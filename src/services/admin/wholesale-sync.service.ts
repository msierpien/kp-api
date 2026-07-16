import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import {
  addWholesaleSyncJob,
  type WholesaleSyncJobData,
  type WholesaleSyncTriggeredBy,
} from '../queue/wholesale-sync.queue';
import { publishInventoryToShops } from '../stock/stock-sync.service';
import {
  assertProviderBelongsToTenant,
  fetchFeed,
  isPositiveDecimal,
  mapCsvRecord,
  parseCsv,
  parseProviderConfig,
  requireTenantId,
  sameDateOnly,
  type FieldMapping,
} from './wholesale/shared';

export interface WholesaleSyncLogsQuery {
  page?: number;
  limit?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface SyncWholesaleProviderOptions {
  limit?: number;
  batchSize?: number;
}

const ACTIVE_WHOLESALE_SYNC_STATUSES = ['PENDING', 'PROCESSING'];
const DEFAULT_WHOLESALE_SYNC_BATCH_SIZE = 500;
const ZERO = new Prisma.Decimal(0);

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
    const syncStartedAt = new Date();
    await prisma.wholesaleSyncLog.update({
      where: { id: logId },
      data: {
        status: 'PROCESSING',
        errorMessage: null,
        startedAt: syncStartedAt,
        batchSize,
      },
    });

    const config = parseProviderConfig(provider.configJson);
    const csvText = await fetchFeed(provider.feedUrl);
    const records = parseCsv(csvText, config.delimiter ?? ';');
    const limitedRecords = limit ? records.slice(0, limit) : records;
    assertFeedColumns(limitedRecords, config.fieldMapping);
    const prepared = prepareWholesaleFeed(limitedRecords, config.fieldMapping);
    const baseline = limit
      ? null
      : await prisma.wholesaleSyncLog.findFirst({
          where: { providerId, tenantId, id: { not: logId }, status: 'SUCCESS', itemsFetched: { gt: 0 } },
          orderBy: { finishedAt: 'desc' },
          select: { itemsFetched: true },
        });
    const validation = validateWholesaleFeed({
      totalItems: limitedRecords.length,
      uniqueItems: prepared.items.length,
      invalidItems: prepared.invalidItems,
      baselineItems: baseline?.itemsFetched ?? null,
      safety: config.feedSafety!,
      partial: Boolean(limit),
    });

    await prisma.wholesaleSyncLog.update({
      where: { id: logId },
      data: {
        totalItems: limitedRecords.length,
        itemsFetched: limitedRecords.length,
        baselineItems: validation.baselineItems,
        feedDropPercent: validation.dropPercent,
        validationStatus: validation.ok ? 'PASSED' : 'BLOCKED',
        skipped: prepared.skipped,
      },
    });
    if (!validation.ok) {
      throw new Error(`Feed hurtowni zablokowany przez walidację: ${validation.errors.join('; ')}`);
    }

    await stageWholesaleFeed({ logId, tenantId, providerId, items: prepared.items, batchSize });
    const applied = await applyWholesaleFeed({
      tenantId,
      providerId,
      items: prepared.items,
      fullFeed: !limit,
      appliedAt: new Date(),
    });
    const publication = await enqueueWholesaleAvailabilityStockSync(applied.changedProductIds, tenantId);
    const finishedAt = new Date();

    const finishedLog = await prisma.wholesaleSyncLog.update({
      where: { id: logId },
      data: {
        status: 'SUCCESS',
        itemsFetched: limitedRecords.length,
        totalItems: limitedRecords.length,
        processedItems: limitedRecords.length,
        mappingsCreated: applied.created,
        mappingsUpdated: applied.updated,
        mappingsUnchanged: applied.unchanged,
        productsRecalculated: publication.productsRecalculated,
        stockSyncEnqueued: publication.enqueued,
        stockSyncSkipped: publication.skippedUnchangedPublication,
        skipped: prepared.skipped + applied.missingHandled,
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
  } finally {
    await prisma.wholesaleFeedStagingItem.deleteMany({ where: { syncLogId: logId } }).catch(() => undefined);
  }
}

type MappedWholesaleFeedItem = ReturnType<typeof mapCsvRecord> & { payloadJson: Prisma.InputJsonValue };

function prepareWholesaleFeed(records: Record<string, string>[], fieldMapping: FieldMapping) {
  const mappedBySku = new Map<string, MappedWholesaleFeedItem>();
  let invalidItems = 0;
  let duplicateItems = 0;

  for (const record of records) {
    const mapped = mapCsvRecord(record, fieldMapping);
    if (!mapped.externalSku) {
      invalidItems++;
      continue;
    }
    if (mappedBySku.has(mapped.externalSku)) duplicateItems++;
    mappedBySku.set(mapped.externalSku, { ...mapped, payloadJson: record as Prisma.InputJsonValue });
  }

  return {
    items: Array.from(mappedBySku.values()),
    invalidItems,
    duplicateItems,
    skipped: invalidItems + duplicateItems,
  };
}

function assertFeedColumns(records: Record<string, string>[], fieldMapping: FieldMapping) {
  if (records.length === 0) return;
  const columns = new Set(Object.keys(records[0] ?? {}));
  const missing = [fieldMapping.sku, fieldMapping.name].filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(`Feed hurtowni nie zawiera wymaganych kolumn: ${missing.join(', ')}`);
  }
}

export function validateWholesaleFeed(input: {
  totalItems: number;
  uniqueItems: number;
  invalidItems: number;
  baselineItems: number | null;
  safety: { minItems: number; maxDropPercent: number; maxInvalidPercent: number };
  partial?: boolean;
}) {
  const errors: string[] = [];
  const invalidPercent = input.totalItems > 0 ? (input.invalidItems / input.totalItems) * 100 : 100;
  const dropPercent = input.baselineItems && input.baselineItems > 0
    ? Math.max(0, ((input.baselineItems - input.totalItems) / input.baselineItems) * 100)
    : null;

  if (input.uniqueItems === 0) errors.push('feed nie zawiera żadnego poprawnego SKU');
  if (!input.partial && input.uniqueItems < input.safety.minItems) {
    errors.push(`liczba poprawnych SKU ${input.uniqueItems} jest mniejsza niż minimum ${input.safety.minItems}`);
  }
  if (invalidPercent > input.safety.maxInvalidPercent) {
    errors.push(`błędne rekordy ${invalidPercent.toFixed(2)}% przekraczają limit ${input.safety.maxInvalidPercent}%`);
  }
  if (!input.partial && dropPercent !== null && dropPercent > input.safety.maxDropPercent) {
    errors.push(`liczba rekordów spadła o ${dropPercent.toFixed(2)}%, limit to ${input.safety.maxDropPercent}%`);
  }

  return {
    ok: errors.length === 0,
    errors,
    invalidPercent,
    dropPercent,
    baselineItems: input.baselineItems,
  };
}

async function stageWholesaleFeed(input: {
  logId: string;
  tenantId: string;
  providerId: string;
  items: MappedWholesaleFeedItem[];
  batchSize: number;
}) {
  for (let offset = 0; offset < input.items.length; offset += input.batchSize) {
    const items = input.items.slice(offset, offset + input.batchSize);
    await prisma.wholesaleFeedStagingItem.createMany({
      data: items.map((item) => ({
        syncLogId: input.logId,
        tenantId: input.tenantId,
        providerId: input.providerId,
        externalSku: item.externalSku,
        externalEan: item.externalEan,
        externalName: item.externalName,
        externalCategory: item.externalCategory,
        lastKnownStock: item.lastKnownStock,
        lastKnownPrice: item.lastKnownPrice,
        warehouseAvailableAt: item.warehouseAvailableAt,
        payloadJson: item.payloadJson,
      })),
    });
    await prisma.wholesaleSyncLog.update({
      where: { id: input.logId },
      data: { processedItems: Math.min(offset + items.length, input.items.length) },
    });
  }
}

async function applyWholesaleFeed(input: {
  tenantId: string;
  providerId: string;
  items: MappedWholesaleFeedItem[];
  fullFeed: boolean;
  appliedAt: Date;
}) {
  const existingMappings = await prisma.wholesaleProductMapping.findMany({
    where: { tenantId: input.tenantId, providerId: input.providerId },
    select: {
      id: true,
      externalSku: true,
      warehouseProductId: true,
      lastKnownStock: true,
      lastKnownPrice: true,
      warehouseAvailableAt: true,
      isActive: true,
    },
  });
  const existingBySku = new Map(existingMappings.map((mapping) => [mapping.externalSku, mapping]));
  const createData: Prisma.WholesaleProductMappingCreateManyInput[] = [];
  const changedMappings: Array<{ id: string; data: Prisma.WholesaleProductMappingUpdateInput }> = [];
  const changedProductIds = new Set<string>();
  const missingCostCandidates = new Map<string, Prisma.Decimal>();
  const seenSkus = new Set<string>();

  for (const mapped of input.items) {
    seenSkus.add(mapped.externalSku);
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
      lastSyncAt: input.appliedAt,
    };

    if (existing) {
      const businessDataChanged = hasWholesaleBusinessDataChanged(existing, mapped);
      if (!businessDataChanged) continue;
      changedMappings.push({ id: existing.id, data });
      if (existing.warehouseProductId) changedProductIds.add(existing.warehouseProductId);
      if (existing.warehouseProductId && isPositiveDecimal(mapped.lastKnownPrice)) {
        missingCostCandidates.set(existing.warehouseProductId, mapped.lastKnownPrice!);
      }
    } else {
      createData.push({
        tenantId: input.tenantId,
        providerId: input.providerId,
        externalSku: mapped.externalSku,
        ...data,
      });
    }
  }

  const missing = input.fullFeed
    ? existingMappings.filter((mapping) => mapping.isActive && !seenSkus.has(mapping.externalSku))
    : [];
  const missingMappedIds = missing
    .filter((mapping) => mapping.warehouseProductId && (!sameNullableDecimal(mapping.lastKnownStock, ZERO) || mapping.warehouseAvailableAt !== null))
    .map((mapping) => mapping.id);
  const missingUnmappedIds = missing.filter((mapping) => !mapping.warehouseProductId).map((mapping) => mapping.id);
  for (const mapping of missing) {
    if (mapping.warehouseProductId) changedProductIds.add(mapping.warehouseProductId);
  }

  const created = await prisma.$transaction(async (tx) => {
    const createdResult = createData.length > 0
      ? await tx.wholesaleProductMapping.createMany({ data: createData, skipDuplicates: true })
      : { count: 0 };
    for (const mapping of changedMappings) {
      await tx.wholesaleProductMapping.update({ where: { id: mapping.id }, data: mapping.data });
    }
    for (let offset = 0; offset < missingMappedIds.length; offset += 1000) {
      await tx.wholesaleProductMapping.updateMany({
        where: { id: { in: missingMappedIds.slice(offset, offset + 1000) } },
        data: { lastKnownStock: ZERO, warehouseAvailableAt: null, lastSyncAt: input.appliedAt },
      });
    }
    for (let offset = 0; offset < missingUnmappedIds.length; offset += 1000) {
      await tx.wholesaleProductMapping.updateMany({
        where: { id: { in: missingUnmappedIds.slice(offset, offset + 1000) } },
        data: { isActive: false, lastKnownStock: ZERO, warehouseAvailableAt: null, lastSyncAt: input.appliedAt },
      });
    }
    for (const [warehouseProductId, purchasePrice] of missingCostCandidates) {
      await tx.warehouseProduct.updateMany({
        where: { id: warehouseProductId, tenantId: input.tenantId, purchasePrice: null, averagePurchaseCost: null },
        data: { purchasePrice },
      });
    }
    return createdResult.count;
  });

  return {
    created,
    updated: changedMappings.length + missingMappedIds.length + missingUnmappedIds.length,
    unchanged: input.items.length - createData.length - changedMappings.length,
    missingHandled: missingMappedIds.length + missingUnmappedIds.length,
    changedProductIds: Array.from(changedProductIds),
  };
}

async function enqueueWholesaleAvailabilityStockSync(warehouseProductIds: string[], tenantId: string) {
  const productIds = Array.from(new Set(warehouseProductIds.filter(Boolean)));
  if (productIds.length === 0) return { productsRecalculated: 0, enqueued: 0, skippedUnchangedPublication: 0 };

  const products = await prisma.warehouseProduct.findMany({
    where: {
      id: { in: productIds },
      tenantId,
      isActive: true,
    },
    select: { id: true },
  });

  let enqueued = 0;
  let skippedUnchangedPublication = 0;
  for (let i = 0; i < products.length; i += 500) {
    const result = await publishInventoryToShops({
      tenantId,
      warehouseProductIds: products.slice(i, i + 500).map((product) => product.id),
      triggeredBy: 'WHOLESALE_SYNC',
      skipUnchangedPublication: true,
    });
    enqueued += result.enqueued;
    skippedUnchangedPublication += result.skippedUnchangedPublication;
  }

  return { productsRecalculated: products.length, enqueued, skippedUnchangedPublication };
}

function hasWholesaleBusinessDataChanged(
  existing: {
    lastKnownStock: Prisma.Decimal | null;
    lastKnownPrice: Prisma.Decimal | null;
    warehouseAvailableAt: Date | null;
    isActive: boolean;
  },
  mapped: ReturnType<typeof mapCsvRecord>,
) {
  return !sameNullableDecimal(existing.lastKnownStock, mapped.lastKnownStock) ||
    !sameNullableDecimal(existing.lastKnownPrice, mapped.lastKnownPrice) ||
    !sameDateOnly(existing.warehouseAvailableAt, mapped.warehouseAvailableAt) ||
    !existing.isActive;
}

function sameNullableDecimal(
  a: Prisma.Decimal | number | string | null | undefined,
  b: Prisma.Decimal | number | string | null | undefined,
) {
  if (a === null || a === undefined || b === null || b === undefined) return a === b;
  return new Prisma.Decimal(a).eq(new Prisma.Decimal(b));
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
