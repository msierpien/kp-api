import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import {
  assertProviderBelongsToTenant,
  requireTenantId,
} from './wholesale/shared';

export interface WholesaleMappingsQuery {
  page?: number;
  limit?: number;
  search?: string;
  isMapped?: boolean;
  isActive?: boolean;
  diagnosis?: 'mapped' | 'ready' | 'missingSku' | 'missingEan' | 'nameOnly' | 'missingData';
}

export interface WholesaleProductOffersQuery {
  productIds?: string;
}

type AutoMapWholesaleMode = 'sku_ean' | 'sku' | 'ean' | 'name';

export interface AutoMapWholesaleProviderOptions {
  activeOnly?: boolean;
  mode?: AutoMapWholesaleMode;
}

export interface AutoMapWholesaleProviderResult {
  providerId: string;
  scanned: number;
  mapped: number;
  mappedBySku: number;
  mappedByEan: number;
  mappedByName: number;
  skippedNoProduct: number;
}

export interface MapWholesaleProductInput {
  warehouseProductId: string | null;
}

export interface BulkCreateWarehouseProductsFromWholesaleInput {
  catalogId?: string;
  importEan?: boolean;
}

export interface BulkCreateWarehouseProductsFromWholesaleResult {
  created: number;
  skipped: number;
  skippedDuplicateSku: number;
}

export async function getWholesaleMappings(providerId: string, query: WholesaleMappingsQuery = {}) {
  const tenantId = requireTenantId();
  await assertProviderBelongsToTenant(providerId, tenantId);

  const { page = 1, limit = 50, search, isMapped, isActive, diagnosis } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.WholesaleProductMappingWhereInput = { tenantId, providerId };
  if (isActive !== undefined) where.isActive = isActive;
  if (isMapped !== undefined) where.warehouseProductId = isMapped ? { not: null } : null;
  applyWholesaleMappingDiagnosis(where, diagnosis);
  if (search) {
    where.OR = [
      { externalSku: { contains: search, mode: 'insensitive' } },
      { externalName: { contains: search, mode: 'insensitive' } },
      { externalEan: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.wholesaleProductMapping.findMany({
      where,
      skip,
      take: limit,
      orderBy: { externalName: 'asc' },
      include: { provider: true, warehouseProduct: { include: { catalog: true } } },
    }),
    prisma.wholesaleProductMapping.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function mapWholesaleProduct(mappingId: string, input: MapWholesaleProductInput) {
  const tenantId = requireTenantId();
  const mapping = await prisma.wholesaleProductMapping.findFirst({
    where: { id: mappingId, tenantId },
    include: { provider: { select: { name: true } } },
  });
  if (!mapping) throw new Error('Mapowanie produktu hurtowni nie znalezione');

  if (input.warehouseProductId) {
    const product = await prisma.warehouseProduct.findFirst({
      where: { id: input.warehouseProductId, tenantId },
    });
    if (!product) throw new Error('Produkt magazynowy nie znaleziony');
  }

  const updated = await prisma.wholesaleProductMapping.update({
    where: { id: mappingId },
    data: { warehouseProductId: input.warehouseProductId },
    include: { provider: true, warehouseProduct: { include: { catalog: true } } },
  });

  if (input.warehouseProductId && mapping.externalEan) {
    const existingBarcode = await prisma.warehouseProductBarcode.findFirst({
      where: { tenantId, ean: mapping.externalEan },
    });
    if (!existingBarcode) {
      await prisma.warehouseProductBarcode.create({
        data: {
          tenantId,
          warehouseProductId: input.warehouseProductId,
          ean: mapping.externalEan,
          label: mapping.provider?.name ?? null,
          quantityMultiplier: new Prisma.Decimal(1),
          isPrimary: false,
          isActive: true,
        },
      });
    }
  }

  return updated;
}

export async function getWholesaleProductOffers(query: WholesaleProductOffersQuery = {}) {
  const tenantId = requireTenantId();
  const productIds = parseProductIds(query.productIds);

  const mappings = await prisma.wholesaleProductMapping.findMany({
    where: {
      tenantId,
      isActive: true,
      warehouseProductId: { in: productIds },
    },
    include: {
      provider: {
        select: {
          id: true,
          name: true,
          isActive: true,
          syncEnabled: true,
          leadTimeDays: true,
          lastSyncAt: true,
        },
      },
    },
    orderBy: [
      { lastKnownPrice: 'asc' },
      { lastSyncAt: 'desc' },
    ],
  });

  const data: Record<string, Array<{
    mappingId: string;
    providerId: string;
    providerName: string;
    providerActive: boolean;
    providerSyncEnabled: boolean;
    providerLeadTimeDays: number | null;
    externalSku: string;
    externalEan: string | null;
    externalName: string | null;
    externalCategory: string | null;
    lastKnownStock: number | null;
    lastKnownPrice: number | null;
    warehouseAvailableAt: Date | null;
    lastSyncAt: Date | null;
    providerLastSyncAt: Date | null;
  }>> = Object.fromEntries(productIds.map((productId) => [productId, []]));

  for (const mapping of mappings) {
    if (!mapping.warehouseProductId) continue;

    data[mapping.warehouseProductId].push({
      mappingId: mapping.id,
      providerId: mapping.providerId,
      providerName: mapping.provider.name,
      providerActive: mapping.provider.isActive,
      providerSyncEnabled: mapping.provider.syncEnabled,
      providerLeadTimeDays: mapping.provider.leadTimeDays,
      externalSku: mapping.externalSku,
      externalEan: mapping.externalEan,
      externalName: mapping.externalName,
      externalCategory: mapping.externalCategory,
      lastKnownStock: mapping.lastKnownStock != null ? mapping.lastKnownStock.toNumber() : null,
      lastKnownPrice: mapping.lastKnownPrice != null ? mapping.lastKnownPrice.toNumber() : null,
      warehouseAvailableAt: mapping.warehouseAvailableAt,
      lastSyncAt: mapping.lastSyncAt,
      providerLastSyncAt: mapping.provider.lastSyncAt,
    });
  }

  return { data };
}

export async function autoMapWholesaleProvider(
  providerId: string,
  options: AutoMapWholesaleProviderOptions = {},
): Promise<AutoMapWholesaleProviderResult> {
  const tenantId = requireTenantId();
  await assertProviderBelongsToTenant(providerId, tenantId);
  const mode = normalizeAutoMapMode(options.mode);

  const mappings = await prisma.wholesaleProductMapping.findMany({
    where: {
      tenantId,
      providerId,
      warehouseProductId: null,
      ...(options.activeOnly ?? true ? { isActive: true } : {}),
    },
    orderBy: { externalSku: 'asc' },
  });

  const result: AutoMapWholesaleProviderResult = {
    providerId,
    scanned: mappings.length,
    mapped: 0,
    mappedBySku: 0,
    mappedByEan: 0,
    mappedByName: 0,
    skippedNoProduct: 0,
  };

  if (mappings.length === 0) return result;

  const [products, barcodes] = await Promise.all([
    prisma.warehouseProduct.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, sku: true, name: true },
    }),
    mode === 'sku' || mode === 'name'
      ? Promise.resolve([])
      : prisma.warehouseProductBarcode.findMany({
          where: {
            tenantId,
            isActive: true,
            ean: { in: Array.from(new Set(mappings.map((mapping) => mapping.externalEan).filter(Boolean))) as string[] },
          },
          select: { ean: true, warehouseProductId: true },
        }),
  ]);

  const productsBySku = new Map<string, { id: string }>();
  const productsByName = new Map<string, { id: string } | null>();
  const barcodesByEan = new Map<string, { id: string }>();

  for (const product of products) {
    const sku = normalizeMatchValue(product.sku);
    if (sku && !productsBySku.has(sku)) productsBySku.set(sku, { id: product.id });

    const name = normalizeMatchValue(product.name);
    if (!name) continue;
    productsByName.set(name, productsByName.has(name) ? null : { id: product.id });
  }

  for (const barcode of barcodes) {
    const ean = normalizeMatchValue(barcode.ean);
    if (ean && !barcodesByEan.has(ean)) barcodesByEan.set(ean, { id: barcode.warehouseProductId });
  }

  const updates: Array<{ id: string; warehouseProductId: string }> = [];

  for (const mapping of mappings) {
    const match = findAutoMapMatch(mapping, mode, {
      productsBySku,
      productsByName,
      barcodesByEan,
    });

    if (!match) {
      result.skippedNoProduct++;
      continue;
    }

    updates.push({ id: mapping.id, warehouseProductId: match.product.id });
    result.mapped++;
    if (match.matchedBy === 'SKU') result.mappedBySku++;
    if (match.matchedBy === 'EAN') result.mappedByEan++;
    if (match.matchedBy === 'NAME') result.mappedByName++;
  }

  for (let offset = 0; offset < updates.length; offset += 100) {
    const chunk = updates.slice(offset, offset + 100);
    await prisma.$transaction(
      chunk.map((update) =>
        prisma.wholesaleProductMapping.update({
          where: { id: update.id },
          data: { warehouseProductId: update.warehouseProductId },
        }),
      ),
    );
  }

  return result;
}

export async function bulkCreateWarehouseProductsFromWholesale(
  providerId: string,
  input: BulkCreateWarehouseProductsFromWholesaleInput = {},
): Promise<BulkCreateWarehouseProductsFromWholesaleResult> {
  const tenantId = requireTenantId();
  await assertProviderBelongsToTenant(providerId, tenantId);

  const { catalogId, importEan = true } = input;

  const [unmapped, resolvedCatalog] = await Promise.all([
    prisma.wholesaleProductMapping.findMany({
      where: { tenantId, providerId, warehouseProductId: null, isActive: true },
      orderBy: { externalSku: 'asc' },
    }),
    catalogId
      ? prisma.warehouseCatalog.findFirst({ where: { id: catalogId, tenantId } })
      : prisma.warehouseCatalog.findFirst({ where: { tenantId, isDefault: true, isActive: true } }),
  ]);

  if (!resolvedCatalog) throw new Error('Nie znaleziono katalogu magazynowego. Utwórz katalog lub wskaż catalogId.');
  if (unmapped.length === 0) return { created: 0, skipped: 0, skippedDuplicateSku: 0 };

  const existingSkus = new Set(
    (
      await prisma.warehouseProduct.findMany({
        where: {
          tenantId,
          sku: { in: unmapped.map((m) => m.externalSku) },
        },
        select: { sku: true },
      })
    ).map((p) => p.sku),
  );

  const toCreate = unmapped.filter((m) => !existingSkus.has(m.externalSku));
  const skippedDuplicateSku = unmapped.length - toCreate.length;

  let created = 0;

  for (const mapping of toCreate) {
    const product = await prisma.warehouseProduct.create({
      data: {
        tenantId,
        catalogId: resolvedCatalog.id,
        sku: mapping.externalSku,
        name: mapping.externalName || mapping.externalSku,
        unit: 'szt',
        purchasePrice: mapping.lastKnownPrice,
        isActive: true,
      },
    });

    await prisma.wholesaleProductMapping.update({
      where: { id: mapping.id },
      data: { warehouseProductId: product.id },
    });

    if (importEan && mapping.externalEan) {
      const existingBarcode = await prisma.warehouseProductBarcode.findFirst({
        where: { tenantId, ean: mapping.externalEan },
      });
      if (!existingBarcode) {
        await prisma.warehouseProductBarcode.create({
          data: {
            tenantId,
            warehouseProductId: product.id,
            ean: mapping.externalEan,
            quantityMultiplier: new Prisma.Decimal(1),
            isPrimary: true,
            isActive: true,
          },
        });
      }
    }

    created++;
  }

  return { created, skipped: skippedDuplicateSku, skippedDuplicateSku };
}

function applyWholesaleMappingDiagnosis(
  where: Prisma.WholesaleProductMappingWhereInput,
  diagnosis?: WholesaleMappingsQuery['diagnosis'],
) {
  if (!diagnosis) return;

  if (diagnosis === 'mapped') {
    where.warehouseProductId = { not: null };
    return;
  }

  where.warehouseProductId = null;

  if (diagnosis === 'ready') {
    where.externalSku = { not: '' };
    where.externalEan = { not: null };
    where.externalName = { not: null };
    return;
  }

  if (diagnosis === 'missingSku') {
    where.externalSku = '';
    return;
  }

  if (diagnosis === 'missingEan') {
    where.externalSku = { not: '' };
    where.externalEan = null;
    return;
  }

  if (diagnosis === 'nameOnly') {
    where.externalSku = '';
    where.externalEan = null;
    where.externalName = { not: null };
    return;
  }

  if (diagnosis === 'missingData') {
    where.externalSku = '';
    where.externalEan = null;
    where.externalName = null;
  }
}

function normalizeAutoMapMode(mode?: AutoMapWholesaleMode): AutoMapWholesaleMode {
  return mode ?? 'sku_ean';
}

function normalizeMatchValue(value?: string | null) {
  return (value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function findAutoMapMatch(
  mapping: { externalSku: string; externalEan?: string | null; externalName?: string | null },
  mode: AutoMapWholesaleMode,
  indexes: {
    productsBySku: Map<string, { id: string }>;
    productsByName: Map<string, { id: string } | null>;
    barcodesByEan: Map<string, { id: string }>;
  },
) {
  if (mode === 'sku' || mode === 'sku_ean') {
    const product = indexes.productsBySku.get(normalizeMatchValue(mapping.externalSku));
    if (product) return { product, matchedBy: 'SKU' as const };
  }

  if (mode === 'ean' || mode === 'sku_ean') {
    const product = indexes.barcodesByEan.get(normalizeMatchValue(mapping.externalEan));
    if (product) return { product, matchedBy: 'EAN' as const };
  }

  if (mode === 'name') {
    const product = indexes.productsByName.get(normalizeMatchValue(mapping.externalName));
    if (product) return { product, matchedBy: 'NAME' as const };
  }

  return null;
}

function parseProductIds(productIds?: string) {
  const ids = Array.from(new Set((productIds ?? '').split(',').map((id) => id.trim()).filter(Boolean)));

  if (ids.length === 0) {
    throw new Error('productIds jest wymagane');
  }

  if (ids.length > 200) {
    throw new Error('productIds może zawierać maksymalnie 200 produktów');
  }

  return ids;
}

// ─── Ręczne CRUD mapowań dla providera typu PRODUCER (producent wewnętrzny) ───
// Dla feedowych hurtowni stan/cenę/dostępność ustawia sync; producent zarządza tym ręcznie w panelu.

export interface ProducerMappingInput {
  externalSku: string;
  externalName?: string | null;
  externalEan?: string | null;
  warehouseProductId?: string | null;
  lastKnownStock?: number | null;
  lastKnownPrice?: number | null;
  warehouseAvailableAt?: string | null;
  isActive?: boolean;
}

export type ProducerMappingUpdateInput = Partial<Omit<ProducerMappingInput, 'externalSku'>>;

async function assertProducerProvider(providerId: string, tenantId: string) {
  const provider = await prisma.wholesaleProvider.findFirst({ where: { id: providerId, tenantId } });
  if (!provider) throw new Error('Provider nie znaleziony');
  if (provider.platform !== 'PRODUCER') {
    throw new Error('Ręczna edycja mapowań jest dostępna tylko dla providera typu PRODUCER');
  }
  return provider;
}

async function assertWarehouseProduct(warehouseProductId: string | null | undefined, tenantId: string) {
  if (!warehouseProductId) return;
  const product = await prisma.warehouseProduct.findFirst({ where: { id: warehouseProductId, tenantId } });
  if (!product) throw new Error('Produkt magazynowy nie znaleziony');
}

function toDecimal(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error('Wartość musi być liczbą nieujemną');
  return new Prisma.Decimal(value);
}

function toDate(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Nieprawidłowa data dostępności');
  return date;
}

export async function createProducerMapping(providerId: string, input: ProducerMappingInput) {
  const tenantId = requireTenantId();
  await assertProducerProvider(providerId, tenantId);
  const sku = input.externalSku?.trim();
  if (!sku) throw new Error('SKU jest wymagane');
  await assertWarehouseProduct(input.warehouseProductId, tenantId);

  return prisma.wholesaleProductMapping.create({
    data: {
      tenantId,
      providerId,
      externalSku: sku,
      externalName: input.externalName?.trim() || null,
      externalEan: input.externalEan?.trim() || null,
      warehouseProductId: input.warehouseProductId ?? null,
      lastKnownStock: toDecimal(input.lastKnownStock),
      lastKnownPrice: toDecimal(input.lastKnownPrice),
      warehouseAvailableAt: toDate(input.warehouseAvailableAt),
      isActive: input.isActive ?? true,
      lastSyncAt: new Date(),
    },
    include: { warehouseProduct: { include: { catalog: true } } },
  });
}

export async function updateProducerMapping(mappingId: string, input: ProducerMappingUpdateInput) {
  const tenantId = requireTenantId();
  const mapping = await prisma.wholesaleProductMapping.findFirst({
    where: { id: mappingId, tenantId },
    include: { provider: { select: { platform: true } } },
  });
  if (!mapping) throw new Error('Mapowanie nie znalezione');
  if (mapping.provider.platform !== 'PRODUCER') {
    throw new Error('Ręczna edycja mapowań jest dostępna tylko dla providera typu PRODUCER');
  }
  await assertWarehouseProduct(input.warehouseProductId, tenantId);

  const data: Prisma.WholesaleProductMappingUpdateInput = { lastSyncAt: new Date() };
  if (input.externalName !== undefined) data.externalName = input.externalName?.trim() || null;
  if (input.externalEan !== undefined) data.externalEan = input.externalEan?.trim() || null;
  if (input.warehouseProductId !== undefined) {
    data.warehouseProduct = input.warehouseProductId
      ? { connect: { id: input.warehouseProductId } }
      : { disconnect: true };
  }
  if (input.lastKnownStock !== undefined) data.lastKnownStock = toDecimal(input.lastKnownStock);
  if (input.lastKnownPrice !== undefined) data.lastKnownPrice = toDecimal(input.lastKnownPrice);
  if (input.warehouseAvailableAt !== undefined) data.warehouseAvailableAt = toDate(input.warehouseAvailableAt);
  if (input.isActive !== undefined) data.isActive = input.isActive;

  return prisma.wholesaleProductMapping.update({
    where: { id: mappingId },
    data,
    include: { warehouseProduct: { include: { catalog: true } } },
  });
}

export async function deleteProducerMapping(mappingId: string) {
  const tenantId = requireTenantId();
  const mapping = await prisma.wholesaleProductMapping.findFirst({
    where: { id: mappingId, tenantId },
    include: { provider: { select: { platform: true } } },
  });
  if (!mapping) throw new Error('Mapowanie nie znalezione');
  if (mapping.provider.platform !== 'PRODUCER') {
    throw new Error('Usuwanie mapowań ręcznie jest dostępne tylko dla providera typu PRODUCER');
  }
  await prisma.wholesaleProductMapping.delete({ where: { id: mappingId } });
  return { deleted: true };
}

export async function bulkUpsertProducerMappings(providerId: string, items: ProducerMappingInput[]) {
  const tenantId = requireTenantId();
  await assertProducerProvider(providerId, tenantId);
  if (!Array.isArray(items) || items.length === 0) return { upserted: 0 };
  if (items.length > 1000) throw new Error('Maksymalnie 1000 pozycji na raz');

  let upserted = 0;
  for (const item of items) {
    const sku = item.externalSku?.trim();
    if (!sku) continue;
    await assertWarehouseProduct(item.warehouseProductId, tenantId);
    const common = {
      externalName: item.externalName?.trim() || null,
      externalEan: item.externalEan?.trim() || null,
      lastKnownStock: toDecimal(item.lastKnownStock),
      lastKnownPrice: toDecimal(item.lastKnownPrice),
      warehouseAvailableAt: toDate(item.warehouseAvailableAt),
      isActive: item.isActive ?? true,
      lastSyncAt: new Date(),
    };
    await prisma.wholesaleProductMapping.upsert({
      where: { providerId_externalSku: { providerId, externalSku: sku } },
      create: {
        tenantId,
        providerId,
        externalSku: sku,
        warehouseProductId: item.warehouseProductId ?? null,
        ...common,
      },
      update: {
        ...common,
        ...(item.warehouseProductId !== undefined
          ? {
              warehouseProduct: item.warehouseProductId
                ? { connect: { id: item.warehouseProductId } }
                : { disconnect: true },
            }
          : {}),
      },
    });
    upserted += 1;
  }
  return { upserted };
}
