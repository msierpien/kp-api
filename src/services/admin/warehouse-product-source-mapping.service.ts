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
      name: true,
      barcodes: {
        where: { isActive: true },
        select: { ean: true },
      },
      shopProductMappings: {
        where: { isActive: true },
        select: { externalSku: true, externalEan: true },
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

export function normalizeEanMatchCandidates(value?: string | null) {
  const raw = (value ?? '').trim();
  if (!raw) return [];

  const candidates = new Set<string>();
  const compact = raw.replace(/[\s-]+/g, '');
  const decimalMatch = compact.match(/^(\d+)[,.]0+$/);
  const compactDigits = decimalMatch?.[1] ?? (/^\d{8,14}$/.test(compact) ? compact : null);

  if (compactDigits) addEanCandidate(candidates, compactDigits);

  const digitRuns = raw.match(/\d{8,14}/g) ?? [];
  for (const run of digitRuns) addEanCandidate(candidates, run);

  return Array.from(candidates);
}

function addEanCandidate(candidates: Set<string>, value: string) {
  if (!/^\d{8,14}$/.test(value)) return;
  candidates.add(value);
  if (value.length === 12) candidates.add(`0${value}`);
  if (value.length === 13 && value.startsWith('0')) candidates.add(value.slice(1));
}

function addMatch(map: MatchMap, key: string, productId: string) {
  if (!key) return;
  const current = map.get(key);
  if (current === undefined) map.set(key, productId);
  else if (current !== productId) map.set(key, null);
}

function addEanMatches(map: MatchMap, value: string | null | undefined, productId: string) {
  for (const key of normalizeEanMatchCandidates(value)) {
    addMatch(map, key, productId);
  }
}

export function normalizeSkuMatchCandidates(value?: string | null) {
  const normalized = normalizeMatchValue(value);
  if (!normalized) return [];

  const withoutHash = normalized.startsWith('#') ? normalized.slice(1).trim() : normalized;
  return Array.from(new Set([normalized, withoutHash].filter(Boolean)));
}

export function productNameSkuCandidates(value?: string | null) {
  const name = (value ?? '').trim();
  const match = name.match(/^#\s*([A-Za-z0-9][A-Za-z0-9._/-]{1,31})(?=\s|$)/);
  if (!match) return [];

  return normalizeSkuMatchCandidates(match[1]);
}

function addSkuMatches(map: MatchMap, value: string | null | undefined, productId: string) {
  for (const key of normalizeSkuMatchCandidates(value)) {
    addMatch(map, key, productId);
  }
}

function buildMatchContext(products: Array<{
  id: string;
  sku: string;
  name: string;
  barcodes: Array<{ ean: string }>;
  shopProductMappings: Array<{ externalSku: string; externalEan?: string | null }>;
}>) {
  const productsBySku: MatchMap = new Map();
  const productsByEan: MatchMap = new Map();

  for (const product of products) {
    addSkuMatches(productsBySku, product.sku, product.id);
    for (const key of productNameSkuCandidates(product.name)) {
      addMatch(productsBySku, key, product.id);
    }
    for (const barcode of product.barcodes) {
      addEanMatches(productsByEan, barcode.ean, product.id);
    }
    for (const mapping of product.shopProductMappings) {
      addSkuMatches(productsBySku, mapping.externalSku, product.id);
      addEanMatches(productsByEan, mapping.externalEan, product.id);
    }
  }

  return { productsBySku, productsByEan };
}

function resolveEanMatch(value: string | null | undefined, productsByEan: MatchMap) {
  const matches = new Set<string>();

  for (const key of normalizeEanMatchCandidates(value)) {
    const match = productsByEan.get(key);
    if (match === null) return { conflict: true };
    if (match) matches.add(match);
  }

  if (matches.size > 1) return { conflict: true };
  return { productId: Array.from(matches)[0] };
}

function resolveMappingMatch(
  mapping: { externalSku?: string | null; externalEan?: string | null },
  context: ReturnType<typeof buildMatchContext>,
): { productId?: string; matchType?: MatchType; conflict?: boolean } {
  const skuKey = normalizeMatchValue(mapping.externalSku);
  const skuMatch = skuKey ? context.productsBySku.get(skuKey) : undefined;
  const eanMatch = resolveEanMatch(mapping.externalEan, context.productsByEan);

  if (skuMatch === null || eanMatch.conflict) return { conflict: true };
  if (skuMatch && eanMatch.productId && skuMatch !== eanMatch.productId) return { conflict: true };
  if (skuMatch) return { productId: skuMatch, matchType: 'SKU' };
  if (eanMatch.productId) return { productId: eanMatch.productId, matchType: 'EAN' };
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
