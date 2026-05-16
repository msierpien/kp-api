/// <reference lib="dom" />
import { parse } from 'csv-parse/sync';
import { Prisma, WholesalePlatform } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import {
  addWholesaleSyncJob,
  type WholesaleSyncJobData,
  type WholesaleSyncTriggeredBy,
} from '../queue/wholesale-sync.queue';

type WholesalePreset = 'GODAN' | 'PARTYDECO' | 'CUSTOM';

interface FieldMapping {
  sku: string;
  name: string;
  ean?: string;
  stock?: string;
  price?: string;
  description?: string;
  image?: string;
  category?: string;
}

interface WholesaleProviderConfig {
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping: FieldMapping;
}

export interface WholesaleProvidersQuery {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

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

export interface CreateWholesaleProviderInput {
  name: string;
  feedUrl: string;
  platform?: WholesalePlatform;
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping?: FieldMapping;
  syncEnabled?: boolean;
  syncInterval?: number;
  isActive?: boolean;
}

export interface UpdateWholesaleProviderInput {
  name?: string;
  feedUrl?: string;
  platform?: WholesalePlatform;
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping?: FieldMapping;
  syncEnabled?: boolean;
  syncInterval?: number;
  isActive?: boolean;
}

export interface SyncWholesaleProviderOptions {
  limit?: number;
  batchSize?: number;
}

export interface PreviewWholesaleProviderInput {
  feedUrl: string;
  delimiter?: string;
  limit?: number;
}

export interface PreviewWholesaleProviderResult {
  columns: string[];
  sampleRows: Record<string, string>[];
  totalPreviewRows: number;
  delimiter: string;
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

export interface UpdateWholesaleSyncIntervalInput {
  intervalMinutes: number;
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

const PRESET_CONFIGS: Record<Exclude<WholesalePreset, 'CUSTOM'>, WholesaleProviderConfig> = {
  GODAN: {
    preset: 'GODAN',
    delimiter: ';',
    fieldMapping: {
      sku: 'Kod produktu',
      ean: 'Kod EAN',
      name: 'Nazwa',
      stock: 'Stan magazynowy',
      price: 'Cena netto jednostkowa',
      description: 'Opis',
      image: 'Zdjęcie',
    },
  },
  PARTYDECO: {
    preset: 'PARTYDECO',
    delimiter: ';',
    fieldMapping: {
      sku: 'code',
      ean: 'ean',
      name: 'name',
      stock: 'stock',
      price: 'price_net',
      description: 'description',
      image: 'photos',
      category: 'category_path',
    },
  },
};

const ACTIVE_WHOLESALE_SYNC_STATUSES = ['PENDING', 'PROCESSING'];
const DEFAULT_WHOLESALE_SYNC_BATCH_SIZE = 500;

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

function withLatestWholesaleSyncLog<T extends { syncLogs?: unknown[] }>(provider: T) {
  const { syncLogs, ...rest } = provider;
  return {
    ...rest,
    latestSyncLog: syncLogs?.[0] ?? null,
  };
}

export async function getWholesaleProviders(query: WholesaleProvidersQuery = {}) {
  const tenantId = requireTenantId();
  const { page = 1, limit = 50, search, isActive } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.WholesaleProviderWhereInput = { tenantId };
  if (isActive !== undefined) where.isActive = isActive;
  if (search) where.name = { contains: search, mode: 'insensitive' };

  const [data, total] = await Promise.all([
    prisma.wholesaleProvider.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { mappings: true, syncLogs: true } },
        syncLogs: {
          take: 1,
          orderBy: { startedAt: 'desc' },
        },
      },
    }),
    prisma.wholesaleProvider.count({ where }),
  ]);

  return {
    data: data.map(withLatestWholesaleSyncLog),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getWholesaleProviderById(id: string) {
  const tenantId = requireTenantId();

  return prisma.wholesaleProvider.findFirst({
    where: { id, tenantId },
    include: {
      _count: { select: { mappings: true, syncLogs: true } },
      syncLogs: {
        take: 1,
        orderBy: { startedAt: 'desc' },
      },
    },
  }).then((provider) => provider ? withLatestWholesaleSyncLog(provider) : null);
}

export async function createWholesaleProvider(input: CreateWholesaleProviderInput) {
  const tenantId = requireTenantId();
  const config = buildProviderConfig(input);
  const syncInterval = validateWholesaleSyncInterval(input.syncInterval ?? 1440);

  return prisma.wholesaleProvider.create({
    data: {
      tenantId,
      name: input.name.trim(),
      platform: input.platform ?? 'CSV_FEED',
      feedUrl: input.feedUrl.trim(),
      configJson: config as unknown as Prisma.InputJsonValue,
      syncEnabled: input.syncEnabled ?? true,
      syncInterval,
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateWholesaleProvider(id: string, input: UpdateWholesaleProviderInput) {
  const tenantId = requireTenantId();
  const provider = await prisma.wholesaleProvider.findFirst({ where: { id, tenantId } });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');

  const data: Prisma.WholesaleProviderUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.feedUrl !== undefined) data.feedUrl = input.feedUrl.trim();
  if (input.platform !== undefined) data.platform = input.platform;
  if (input.syncEnabled !== undefined) data.syncEnabled = input.syncEnabled;
  if (input.syncInterval !== undefined) data.syncInterval = validateWholesaleSyncInterval(input.syncInterval);
  if (input.isActive !== undefined) data.isActive = input.isActive;

  if (input.preset !== undefined || input.delimiter !== undefined || input.fieldMapping !== undefined) {
    const currentConfig = parseProviderConfig(provider.configJson);
    const nextConfig = buildProviderConfig({
      preset: input.preset ?? currentConfig.preset ?? 'CUSTOM',
      delimiter: input.delimiter ?? currentConfig.delimiter,
      fieldMapping: input.fieldMapping ?? currentConfig.fieldMapping,
      name: provider.name,
      feedUrl: provider.feedUrl,
    });
    data.configJson = nextConfig as unknown as Prisma.InputJsonValue;
  }

  return prisma.wholesaleProvider.update({ where: { id }, data });
}

export async function updateWholesaleProviderSyncInterval(
  id: string,
  input: UpdateWholesaleSyncIntervalInput,
) {
  const tenantId = requireTenantId();
  const provider = await prisma.wholesaleProvider.findFirst({ where: { id, tenantId } });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');

  const syncInterval = validateWholesaleSyncInterval(input.intervalMinutes);
  return prisma.wholesaleProvider.update({
    where: { id },
    data: { syncInterval },
  });
}

export async function deleteWholesaleProvider(id: string) {
  const tenantId = requireTenantId();
  const provider = await prisma.wholesaleProvider.findFirst({ where: { id, tenantId } });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');

  return prisma.wholesaleProvider.delete({ where: { id } });
}

export async function previewWholesaleProvider(input: PreviewWholesaleProviderInput): Promise<PreviewWholesaleProviderResult> {
  requireTenantId();

  const feedUrl = input.feedUrl?.trim();
  if (!feedUrl) throw new Error('feedUrl jest wymagany');

  const delimiter = normalizeDelimiter(input.delimiter);
  const limit = clampPreviewLimit(input.limit);
  const csvText = await fetchFeed(feedUrl);
  const records = parseCsv(csvText, delimiter);
  const sampleRows = records.slice(0, limit);

  return {
    columns: collectColumns(sampleRows.length > 0 ? sampleRows : records),
    sampleRows,
    totalPreviewRows: sampleRows.length,
    delimiter,
  };
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
    externalSku: string;
    externalEan: string | null;
    externalName: string | null;
    externalCategory: string | null;
    lastKnownStock: number | null;
    lastKnownPrice: number | null;
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
      externalSku: mapping.externalSku,
      externalEan: mapping.externalEan,
      externalName: mapping.externalName,
      externalCategory: mapping.externalCategory,
      lastKnownStock: mapping.lastKnownStock != null ? mapping.lastKnownStock.toNumber() : null,
      lastKnownPrice: mapping.lastKnownPrice != null ? mapping.lastKnownPrice.toNumber() : null,
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
    },
  });
  const existingBySku = new Map(existingMappings.map((mapping) => [mapping.externalSku, mapping.id]));
  const now = new Date();
  const createData: Prisma.WholesaleProductMappingCreateManyInput[] = [];
  const updateOperations: Prisma.PrismaPromise<unknown>[] = [];

  for (const mapped of mappedRecords) {
    const existingId = existingBySku.get(mapped.externalSku);
    const data = {
      externalEan: mapped.externalEan,
      externalName: mapped.externalName,
      externalCategory: mapped.externalCategory,
      lastKnownStock: mapped.lastKnownStock,
      lastKnownPrice: mapped.lastKnownPrice,
      payloadJson: mapped.payloadJson,
      isActive: true,
      lastSyncAt: now,
    };

    if (existingId) {
      updateOperations.push(prisma.wholesaleProductMapping.update({
        where: { id: existingId },
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

function buildProviderConfig(input: {
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping?: FieldMapping;
  feedUrl: string;
  name: string;
}): WholesaleProviderConfig {
  const preset = input.preset ?? detectPreset(input.feedUrl, input.name);
  const presetConfig = preset !== 'CUSTOM' ? PRESET_CONFIGS[preset] : undefined;
  const delimiter = normalizeDelimiter(input.delimiter ?? presetConfig?.delimiter);
  const fieldMapping = input.fieldMapping ?? presetConfig?.fieldMapping;

  if (!fieldMapping?.sku || !fieldMapping?.name) {
    throw new Error('Konfiguracja hurtowni wymaga mapowania pól sku i name');
  }

  return { preset, delimiter, fieldMapping };
}

function parseProviderConfig(configJson: unknown): WholesaleProviderConfig {
  const config = (configJson || {}) as Partial<WholesaleProviderConfig>;
  if (!config.fieldMapping?.sku || !config.fieldMapping?.name) {
    throw new Error('Provider hurtowni nie ma poprawnej konfiguracji CSV');
  }

  return {
    preset: config.preset ?? 'CUSTOM',
    delimiter: normalizeDelimiter(config.delimiter),
    fieldMapping: config.fieldMapping,
  };
}

function detectPreset(feedUrl: string, name: string): WholesalePreset {
  const value = `${feedUrl} ${name}`.toLowerCase();
  if (value.includes('godan')) return 'GODAN';
  if (value.includes('partydeco') || value.includes('party deco')) return 'PARTYDECO';
  return 'CUSTOM';
}

async function fetchFeed(feedUrl: string) {
  const response = await fetch(feedUrl);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Błąd pobierania feedu hurtowni: ${response.status} ${text.slice(0, 200)}`);
  }
  return response.text();
}

function parseCsv(csvText: string, delimiter: string): Record<string, string>[] {
  return parse(csvText, {
    bom: true,
    columns: true,
    delimiter,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];
}

function normalizeDelimiter(delimiter?: string) {
  if (!delimiter) return ';';
  if (delimiter === '\\t') return '\t';
  if (delimiter.length !== 1) throw new Error('Separator CSV musi mieć dokładnie jeden znak');
  return delimiter;
}

function clampPreviewLimit(limit?: number) {
  if (limit === undefined) return 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Limit preview musi być liczbą całkowitą od 1 do 50');
  }
  return limit;
}

function validateWholesaleSyncInterval(intervalMinutes: number) {
  if (!Number.isInteger(intervalMinutes)) {
    throw new Error('Interwał synchronizacji hurtowni musi być liczbą całkowitą');
  }

  if (intervalMinutes < 30) {
    throw new Error('Interwał synchronizacji hurtowni musi wynosić minimum 30 minut');
  }

  if (intervalMinutes > 1440) {
    throw new Error('Interwał synchronizacji hurtowni nie może przekraczać 1440 minut');
  }

  return intervalMinutes;
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

function collectColumns(records: Record<string, string>[]) {
  const columns = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) columns.add(key);
  }
  return Array.from(columns);
}

function mapCsvRecord(record: Record<string, string>, fieldMapping: FieldMapping) {
  return {
    externalSku: readField(record, fieldMapping.sku),
    externalEan: readOptionalField(record, fieldMapping.ean),
    externalName: readOptionalField(record, fieldMapping.name),
    externalCategory: readOptionalField(record, fieldMapping.category),
    lastKnownStock: parseDecimal(readOptionalField(record, fieldMapping.stock), 3),
    lastKnownPrice: parseDecimal(readOptionalField(record, fieldMapping.price), 2),
  };
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

function readField(record: Record<string, string>, fieldName: string) {
  return String(record[fieldName] ?? '').trim();
}

function readOptionalField(record: Record<string, string>, fieldName?: string) {
  if (!fieldName) return null;
  const value = readField(record, fieldName);
  return value || null;
}

function parseDecimal(value: string | null, scale: number) {
  if (!value) return null;
  const normalized = value.replace(/\s/g, '').replace(',', '.');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return new Prisma.Decimal(parsed.toFixed(scale));
}
