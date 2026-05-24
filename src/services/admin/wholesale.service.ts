import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import {
  addWholesaleSyncJob,
  type WholesaleSyncJobData,
  type WholesaleSyncTriggeredBy,
} from '../queue/wholesale-sync.queue';
import { publishInventoryToShops } from '../stock/stock-sync.service';
import {
  fetchFeed,
  isPositiveDecimal,
  mapCsvRecord,
  parseCsv,
  parseProviderConfig,
  requireTenantId,
  sameDateOnly,
  type FieldMapping,
} from './wholesale/shared';

export * from './wholesale-provider.service';

export interface WholesaleMappingsQuery {
  page?: number;
  limit?: number;
  search?: string;
  isMapped?: boolean;
  isActive?: boolean;
  diagnosis?: 'mapped' | 'ready' | 'missingSku' | 'missingEan' | 'nameOnly' | 'missingData';
}

export interface WholesaleSyncLogsQuery {
  page?: number;
  limit?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface WholesaleProductOffersQuery {
  productIds?: string;
}

export interface SyncWholesaleProviderOptions {
  limit?: number;
  batchSize?: number;
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

const ACTIVE_WHOLESALE_SYNC_STATUSES = ['PENDING', 'PROCESSING'];
const DEFAULT_WHOLESALE_SYNC_BATCH_SIZE = 500;

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

export async function getWholesaleSyncLogs(providerId: string, query: WholesaleSyncLogsQuery = {}) {
  const tenantId = requireTenantId();
  await assertProviderBelongsToTenant(providerId, tenantId);

  const { page = 1, limit = 50, status, dateFrom, dateTo } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.WholesaleSyncLogWhereInput = { tenantId, providerId };
  if (status) where.status = status;
  if (dateFrom || dateTo) {
    where.startedAt = {};
    if (dateFrom) where.startedAt.gte = new Date(dateFrom);
    if (dateTo) where.startedAt.lte = new Date(dateTo);
  }

  const [data, total] = await Promise.all([
    prisma.wholesaleSyncLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { startedAt: 'desc' },
      include: { provider: true },
    }),
    prisma.wholesaleSyncLog.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function syncWholesaleProvider(providerId: string, options: SyncWholesaleProviderOptions = {}) {
  const tenantId = requireTenantId();
  return enqueueWholesaleProviderSync(providerId, tenantId, options, 'MANUAL');
}

export async function enqueueWholesaleProviderSync(
  providerId: string,
  tenantId: string,
  options: SyncWholesaleProviderOptions = {},
  triggeredBy: WholesaleSyncTriggeredBy = 'MANUAL',
) {
  const provider = await prisma.wholesaleProvider.findFirst({ where: { id: providerId, tenantId } });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');
  if (!provider.isActive) throw new Error('Provider hurtowni jest nieaktywny');
  if (provider.platform !== 'CSV_FEED') throw new Error(`Sync nie obsługuje jeszcze platformy ${provider.platform}`);

  const activeLog = await prisma.wholesaleSyncLog.findFirst({
    where: {
      tenantId,
      providerId,
      status: { in: ACTIVE_WHOLESALE_SYNC_STATUSES },
    },
    orderBy: { startedAt: 'desc' },
  });

  if (activeLog) return activeLog;

  const batchSize = normalizeSyncBatchSize(options.batchSize);
  const limit = normalizeSyncLimit(options.limit);
  const log = await prisma.wholesaleSyncLog.create({
    data: {
      tenantId,
      providerId,
      status: 'PENDING',
      batchSize,
      startedAt: new Date(),
    },
  });

  try {
    await addWholesaleSyncJob({
      logId: log.id,
      tenantId,
      providerId,
      triggeredBy,
      limit,
      batchSize,
    });
  } catch (error) {
    await prisma.wholesaleSyncLog.update({
      where: { id: log.id },
      data: {
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Nie udało się dodać joba synchronizacji hurtowni',
        finishedAt: new Date(),
      },
    });
    throw error;
  }

  return log;
}

export async function syncWholesaleProviderForTenant(
  providerId: string,
  tenantId: string,
  options: SyncWholesaleProviderOptions = {},
) {
  return enqueueWholesaleProviderSync(providerId, tenantId, options, 'SCHEDULER');
}

export async function runWholesaleSyncJob(data: WholesaleSyncJobData) {
  const { logId, tenantId, providerId } = data;
  const batchSize = normalizeSyncBatchSize(data.batchSize);
  const limit = normalizeSyncLimit(data.limit);

  const [provider, log] = await Promise.all([
    prisma.wholesaleProvider.findFirst({ where: { id: providerId, tenantId } }),
    prisma.wholesaleSyncLog.findFirst({ where: { id: logId, tenantId, providerId } }),
  ]);

  if (!provider) throw new Error('Provider hurtowni nie znaleziony');
  if (!log) throw new Error('Log synchronizacji hurtowni nie znaleziony');
  if (!provider.isActive) throw new Error('Provider hurtowni jest nieaktywny');
  if (provider.platform !== 'CSV_FEED') throw new Error(`Sync nie obsługuje jeszcze platformy ${provider.platform}`);

  await prisma.wholesaleSyncLog.update({
    where: { id: logId },
    data: {
      status: 'PROCESSING',
      batchSize,
      startedAt: new Date(),
      errorMessage: null,
    },
  });

  return processWholesaleSyncJob({ ...data, limit, batchSize });
}

export async function processWholesaleSyncJob(data: WholesaleSyncJobData) {
  const { logId, providerId, tenantId } = data;
  const limit = normalizeSyncLimit(data.limit);
  const batchSize = normalizeSyncBatchSize(data.batchSize);
  const provider = await prisma.wholesaleProvider.findFirst({ where: { id: providerId, tenantId } });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');
  if (!provider.isActive) throw new Error('Provider hurtowni jest nieaktywny');
  if (provider.platform !== 'CSV_FEED') throw new Error(`Sync nie obsługuje jeszcze platformy ${provider.platform}`);

  try {
    await prisma.wholesaleSyncLog.update({
      where: { id: logId },
      data: {
        status: 'PROCESSING',
        errorMessage: null,
        startedAt: new Date(),
        batchSize,
      },
    });

    const config = parseProviderConfig(provider.configJson);
    const csvText = await fetchFeed(provider.feedUrl);
    const records = parseCsv(csvText, config.delimiter ?? ';');
    const limitedRecords = limit ? records.slice(0, limit) : records;

    await prisma.wholesaleSyncLog.update({
      where: { id: logId },
      data: {
        totalItems: limitedRecords.length,
        itemsFetched: limitedRecords.length,
      },
    });

    let created = 0;
    let updated = 0;
    let skipped = 0;
    let processed = 0;

    for (let offset = 0; offset < limitedRecords.length; offset += batchSize) {
      const batch = limitedRecords.slice(offset, offset + batchSize);
      const result = await processWholesaleSyncBatch({
        tenantId,
        providerId,
        records: batch,
        fieldMapping: config.fieldMapping,
      });

      created += result.created;
      updated += result.updated;
      skipped += result.skipped;
      processed += batch.length;

      await prisma.wholesaleSyncLog.update({
        where: { id: logId },
        data: {
          processedItems: processed,
          mappingsCreated: created,
          mappingsUpdated: updated,
          skipped,
        },
      });
    }

    const finishedAt = new Date();
    const finishedLog = await prisma.wholesaleSyncLog.update({
      where: { id: logId },
      data: {
        status: 'SUCCESS',
        itemsFetched: limitedRecords.length,
        totalItems: limitedRecords.length,
        processedItems: processed,
        mappingsCreated: created,
        mappingsUpdated: updated,
        skipped,
        errorMessage: null,
        finishedAt,
      },
    });

    await prisma.wholesaleProvider.update({
      where: { id: providerId },
      data: { lastSyncAt: finishedAt },
    });

    return finishedLog;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nieznany błąd sync hurtowni';
    await prisma.wholesaleSyncLog.update({
      where: { id: logId },
      data: {
        status: 'FAILED',
        errorMessage: message,
        finishedAt: new Date(),
      },
    });
    throw error;
  }
}

async function processWholesaleSyncBatch(input: {
  tenantId: string;
  providerId: string;
  records: Record<string, string>[];
  fieldMapping: FieldMapping;
}) {
  const mappedBySku = new Map<string, ReturnType<typeof mapCsvRecord> & { payloadJson: Prisma.InputJsonValue }>();
  let skipped = 0;

  for (const record of input.records) {
    const mapped = mapCsvRecord(record, input.fieldMapping);
    if (!mapped.externalSku) {
      skipped++;
      continue;
    }

    if (mappedBySku.has(mapped.externalSku)) skipped++;
    mappedBySku.set(mapped.externalSku, {
      ...mapped,
      payloadJson: record as Prisma.InputJsonValue,
    });
  }

  const mappedRecords = Array.from(mappedBySku.values());
  if (mappedRecords.length === 0) return { created: 0, updated: 0, skipped };

  const existingMappings = await prisma.wholesaleProductMapping.findMany({
    where: {
      providerId: input.providerId,
      externalSku: { in: mappedRecords.map((record) => record.externalSku) },
    },
    select: {
      id: true,
      externalSku: true,
      warehouseProductId: true,
      lastKnownStock: true,
      warehouseAvailableAt: true,
      isActive: true,
    },
  });
  const existingBySku = new Map(existingMappings.map((mapping) => [mapping.externalSku, mapping]));
  const now = new Date();
  const createData: Prisma.WholesaleProductMappingCreateManyInput[] = [];
  const updateOperations: Prisma.PrismaPromise<unknown>[] = [];
  const availabilityChangedProductIds = new Set<string>();

  for (const mapped of mappedRecords) {
    const existing = existingBySku.get(mapped.externalSku);
    const data = {
      externalEan: mapped.externalEan,
      externalName: mapped.externalName,
      externalCategory: mapped.externalCategory,
      lastKnownStock: mapped.lastKnownStock,
      lastKnownPrice: mapped.lastKnownPrice,
      warehouseAvailableAt: mapped.warehouseAvailableAt,
      payloadJson: mapped.payloadJson,
      isActive: true,
      lastSyncAt: now,
    };

    if (existing) {
      const wasAvailable = existing.isActive && isPositiveDecimal(existing.lastKnownStock);
      const isAvailable = isPositiveDecimal(mapped.lastKnownStock);
      const availabilityDateChanged = !sameDateOnly(existing.warehouseAvailableAt, mapped.warehouseAvailableAt);
      if (existing.warehouseProductId && (wasAvailable !== isAvailable || availabilityDateChanged)) {
        availabilityChangedProductIds.add(existing.warehouseProductId);
      }
      updateOperations.push(prisma.wholesaleProductMapping.update({
        where: { id: existing.id },
        data,
      }));
    } else {
      createData.push({
        tenantId: input.tenantId,
        providerId: input.providerId,
        externalSku: mapped.externalSku,
        ...data,
      });
    }
  }

  const createOperation = createData.length > 0
    ? [prisma.wholesaleProductMapping.createMany({ data: createData, skipDuplicates: true })]
    : [];
  const results = await prisma.$transaction([...createOperation, ...updateOperations]);
  const created = createData.length > 0 ? (results[0] as Prisma.BatchPayload).count : 0;

  await enqueueWholesaleAvailabilityStockSync(Array.from(availabilityChangedProductIds), input.tenantId);

  return {
    created,
    updated: updateOperations.length,
    skipped,
  };
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

async function assertProviderBelongsToTenant(providerId: string, tenantId: string) {
  const provider = await prisma.wholesaleProvider.findFirst({
    where: { id: providerId, tenantId },
    select: { id: true },
  });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');
}

async function enqueueWholesaleAvailabilityStockSync(warehouseProductIds: string[], tenantId: string) {
  const productIds = Array.from(new Set(warehouseProductIds.filter(Boolean)));
  if (productIds.length === 0) return;

  const products = await prisma.warehouseProduct.findMany({
    where: {
      id: { in: productIds },
      tenantId,
      isActive: true,
      currentStock: { lte: new Prisma.Decimal(0) },
    },
    select: { id: true },
  });

  for (let i = 0; i < products.length; i += 500) {
    await publishInventoryToShops({
      tenantId,
      warehouseProductIds: products.slice(i, i + 500).map((product) => product.id),
      triggeredBy: 'WHOLESALE_SYNC',
    });
  }
}

function normalizeSyncLimit(limit?: number) {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Limit synchronizacji hurtowni musi być dodatnią liczbą całkowitą');
  }
  return limit;
}

function normalizeSyncBatchSize(batchSize?: number) {
  if (batchSize === undefined) return DEFAULT_WHOLESALE_SYNC_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5000) {
    throw new Error('batchSize synchronizacji hurtowni musi być liczbą całkowitą od 1 do 5000');
  }
  return batchSize;
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
