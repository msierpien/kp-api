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
