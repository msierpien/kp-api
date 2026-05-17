import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';

export type ProductSourceMappingSource = 'SHOP' | 'WHOLESALE';

export interface BulkAutoMapProductSourcesInput {
  productIds: string[];
  sources?: ProductSourceMappingSource[];
  activeOnly?: boolean;
}

export interface ProductSourceMappingStats {
  scanned: number;
  mapped: number;
  mappedBySku: number;
  mappedByEan: number;
  skippedConflict: number;
  skippedNoMatch: number;
}

export interface BulkAutoMapProductSourcesResult {
  requestedProducts: number;
  shop: ProductSourceMappingStats;
  wholesale: ProductSourceMappingStats;
}

type MatchType = 'SKU' | 'EAN';
type MatchMap = Map<string, string | null>;
type MappingOperation = {
  id: string;
  warehouseProductId: string;
  matchType: MatchType;
};

const MAX_BULK_PRODUCT_IDS = 500;
const UPDATE_BATCH_SIZE = 100;
const EMPTY_STATS: ProductSourceMappingStats = {
  scanned: 0,
  mapped: 0,
  mappedBySku: 0,
  mappedByEan: 0,
  skippedConflict: 0,
  skippedNoMatch: 0,
};

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

export async function bulkAutoMapProductSources(
  input: BulkAutoMapProductSourcesInput,
): Promise<BulkAutoMapProductSourcesResult> {
  const tenantId = requireTenantId();
  const productIds = normalizeProductIds(input.productIds);
  const sources = normalizeSources(input.sources);
  const activeOnly = input.activeOnly ?? true;

  const products = await prisma.warehouseProduct.findMany({
    where: { tenantId, id: { in: productIds } },
    select: {
      id: true,
      sku: true,
      barcodes: {
        where: { isActive: true },
        select: { ean: true },
      },
    },
  });

  const matchContext = buildMatchContext(products);
  const result: BulkAutoMapProductSourcesResult = {
    requestedProducts: productIds.length,
    shop: { ...EMPTY_STATS },
    wholesale: { ...EMPTY_STATS },
  };

  if (sources.includes('SHOP')) {
    result.shop = await autoMapShopMappings(tenantId, matchContext, activeOnly);
  }

  if (sources.includes('WHOLESALE')) {
    result.wholesale = await autoMapWholesaleMappings(tenantId, matchContext, activeOnly);
  }

  return result;
}

function normalizeProductIds(productIds: string[]) {
  const ids = Array.from(new Set((productIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (ids.length === 0) throw new Error('Wybierz produkty do mapowania');
  if (ids.length > MAX_BULK_PRODUCT_IDS) {
    throw new Error(`Można mapować maksymalnie ${MAX_BULK_PRODUCT_IDS} produktów naraz`);
  }
  return ids;
}

function normalizeSources(sources?: ProductSourceMappingSource[]) {
  if (!sources || sources.length === 0) return ['SHOP', 'WHOLESALE'] as ProductSourceMappingSource[];

  const unique = Array.from(new Set(sources));
  const allowed = new Set<ProductSourceMappingSource>(['SHOP', 'WHOLESALE']);
  if (unique.some((source) => !allowed.has(source))) {
    throw new Error('Nieobsługiwane źródło mapowania');
  }
  return unique;
}

function normalizeMatchValue(value?: string | null) {
  return (value ?? '').trim().toLowerCase();
}

function addMatch(map: MatchMap, key: string, productId: string) {
  if (!key) return;
  const current = map.get(key);
  if (current === undefined) map.set(key, productId);
  else if (current !== productId) map.set(key, null);
}

function buildMatchContext(products: Array<{ id: string; sku: string; barcodes: Array<{ ean: string }> }>) {
  const productsBySku: MatchMap = new Map();
  const productsByEan: MatchMap = new Map();

  for (const product of products) {
    addMatch(productsBySku, normalizeMatchValue(product.sku), product.id);
    for (const barcode of product.barcodes) {
      addMatch(productsByEan, normalizeMatchValue(barcode.ean), product.id);
    }
  }

  return { productsBySku, productsByEan };
}

function resolveMappingMatch(
  mapping: { externalSku?: string | null; externalEan?: string | null },
  context: ReturnType<typeof buildMatchContext>,
): { productId?: string; matchType?: MatchType; conflict?: boolean } {
  const skuKey = normalizeMatchValue(mapping.externalSku);
  const eanKey = normalizeMatchValue(mapping.externalEan);
  const skuMatch = skuKey ? context.productsBySku.get(skuKey) : undefined;
  const eanMatch = eanKey ? context.productsByEan.get(eanKey) : undefined;

  if (skuMatch === null || eanMatch === null) return { conflict: true };
  if (skuMatch && eanMatch && skuMatch !== eanMatch) return { conflict: true };
  if (skuMatch) return { productId: skuMatch, matchType: 'SKU' };
  if (eanMatch) return { productId: eanMatch, matchType: 'EAN' };
  return {};
}

async function autoMapShopMappings(
  tenantId: string,
  context: ReturnType<typeof buildMatchContext>,
  activeOnly: boolean,
): Promise<ProductSourceMappingStats> {
  const mappings = await prisma.shopProductMapping.findMany({
    where: {
      tenantId,
      warehouseProductId: null,
      ...(activeOnly ? { isActive: true } : {}),
    },
    select: {
      id: true,
      externalSku: true,
      externalEan: true,
    },
  });

  const { stats, operations } = collectMappingOperations(mappings, context);
  await applyMappingOperations('SHOP', tenantId, operations, stats);
  return stats;
}

async function autoMapWholesaleMappings(
  tenantId: string,
  context: ReturnType<typeof buildMatchContext>,
  activeOnly: boolean,
): Promise<ProductSourceMappingStats> {
  const mappings = await prisma.wholesaleProductMapping.findMany({
    where: {
      tenantId,
      warehouseProductId: null,
      ...(activeOnly ? { isActive: true, provider: { isActive: true } } : {}),
    },
    select: {
      id: true,
      externalSku: true,
      externalEan: true,
    },
  });

  const { stats, operations } = collectMappingOperations(mappings, context);
  await applyMappingOperations('WHOLESALE', tenantId, operations, stats);
  return stats;
}

function collectMappingOperations(
  mappings: Array<{ id: string; externalSku?: string | null; externalEan?: string | null }>,
  context: ReturnType<typeof buildMatchContext>,
) {
  const stats: ProductSourceMappingStats = { ...EMPTY_STATS, scanned: mappings.length };
  const operations: MappingOperation[] = [];

  for (const mapping of mappings) {
    const match = resolveMappingMatch(mapping, context);
    if (match.conflict) {
      stats.skippedConflict++;
      continue;
    }
    if (!match.productId || !match.matchType) {
      stats.skippedNoMatch++;
      continue;
    }

    operations.push({
      id: mapping.id,
      warehouseProductId: match.productId,
      matchType: match.matchType,
    });
  }

  return { stats, operations };
}

async function applyMappingOperations(
  source: ProductSourceMappingSource,
  tenantId: string,
  operations: MappingOperation[],
  stats: ProductSourceMappingStats,
) {
  for (let offset = 0; offset < operations.length; offset += UPDATE_BATCH_SIZE) {
    const batch = operations.slice(offset, offset + UPDATE_BATCH_SIZE);
    const updates = await prisma.$transaction(
      batch.map((operation) => updateMappingOperation(source, tenantId, operation)),
    );

    updates.forEach((update, index) => {
      const count = update.count;
      if (count === 0) return;

      const operation = batch[index];
      stats.mapped += count;
      if (operation.matchType === 'SKU') stats.mappedBySku += count;
      if (operation.matchType === 'EAN') stats.mappedByEan += count;
    });
  }
}

function updateMappingOperation(
  source: ProductSourceMappingSource,
  tenantId: string,
  operation: MappingOperation,
): Prisma.PrismaPromise<Prisma.BatchPayload> {
  if (source === 'SHOP') {
    return prisma.shopProductMapping.updateMany({
      where: {
        id: operation.id,
        tenantId,
        warehouseProductId: null,
      },
      data: { warehouseProductId: operation.warehouseProductId },
    });
  }

  return prisma.wholesaleProductMapping.updateMany({
    where: {
      id: operation.id,
      tenantId,
      warehouseProductId: null,
    },
    data: { warehouseProductId: operation.warehouseProductId },
  });
}
