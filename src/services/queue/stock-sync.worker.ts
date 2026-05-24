import { Worker, Job, UnrecoverableError } from 'bullmq';
import prisma from '../../lib/prisma';
import { createShopStockClient } from '../shops/shop-client.factory';
import { PrestaShopStockClient } from '../shops/prestashop-stock-client';
import type { ShopProductInventorySnapshot } from '../shops/shop-stock-client.interface';
import { getInventoryPublicationDecision } from '../stock/stock-sync.service';
import { getRedisConnection } from './render.queue';
import { STOCK_SYNC_QUEUE_NAME, type StockSyncBatchJobData, type StockSyncJobData, type StockSyncLegacyJobData } from './stock-sync.queue';

let stockSyncWorker: Worker<StockSyncJobData> | null = null;
const PRESTASHOP_SYNC_RATE_LIMIT = { max: 60, duration: 60_000 };

async function processStockSyncJob(job: Job<StockSyncJobData>) {
  if ('items' in job.data) {
    return processStockSyncBatch(job.data);
  }

  return processLegacyStockSyncJob(job.data);
}

async function processLegacyStockSyncJob(data: StockSyncLegacyJobData) {
  const { logId, warehouseProductId, shopId, externalProductId } = data;
  const [product, shop, log] = await Promise.all([
    prisma.warehouseProduct.findUnique({ where: { id: warehouseProductId } }),
    prisma.shop.findUnique({ where: { id: shopId } }),
    prisma.stockSyncLog.findUnique({ where: { id: logId } }),
  ]);

  // UnrecoverableError = BullMQ nie będzie retry-ował, job od razu do failed
  if (!product) {
    await prisma.stockSyncLog.updateMany({
      where: { id: logId },
      data: { status: 'FAILED', errorMessage: `Warehouse product not found: ${warehouseProductId}` },
    });
    throw new UnrecoverableError(`Warehouse product not found: ${warehouseProductId}`);
  }
  if (!shop) {
    await prisma.stockSyncLog.updateMany({
      where: { id: logId },
      data: { status: 'FAILED', errorMessage: `Shop not found: ${shopId}` },
    });
    throw new UnrecoverableError(`Shop not found: ${shopId}`);
  }
  if (!log) throw new UnrecoverableError(`Stock sync log not found: ${logId}`);

  const decision = await getInventoryPublicationDecision(warehouseProductId, {
    warningMessage: log.warningMessage ?? undefined,
  });
  const publishedLeadTimeDays = resolvePublishedLeadTimeDays(decision, shop.configJson);

  await prisma.stockSyncLog.update({
    where: { id: logId },
    data: {
      stockAfter: product.currentStock,
      publishedQuantity: decision.publishedQuantity,
      publishedLeadTimeDays,
      availabilityPolicy: decision.availabilityPolicy,
      outOfStockBehavior: decision.outOfStockBehavior,
      warningMessage: decision.warningMessage,
    },
  });

  return processStockSyncBatch({
    tenantId: data.tenantId,
    shopId,
    triggeredBy: data.triggeredBy,
    documentId: data.documentId,
    items: [{
      logId,
      warehouseProductId,
      externalProductId,
      quantity: Math.max(0, Math.floor(Number(decision.publishedQuantity))),
      leadTimeDays: publishedLeadTimeDays,
      warehouseAvailableAt: formatWarehouseAvailableAt(decision.warehouseAvailableAt),
      outOfStockBehavior: decision.outOfStockBehavior,
      availabilityPolicy: decision.availabilityPolicy,
    }],
  });
}

async function processStockSyncBatch(data: StockSyncBatchJobData) {
  if (data.items.length === 0) {
    throw new UnrecoverableError('Stock sync batch is empty');
  }

  const logIds = data.items.map((item) => item.logId);
  const shop = await prisma.shop.findUnique({ where: { id: data.shopId } });
  if (!shop) {
    await markLogsFailed(logIds, `Shop not found: ${data.shopId}`);
    throw new UnrecoverableError(`Shop not found: ${data.shopId}`);
  }

  const logs = await prisma.stockSyncLog.findMany({
    where: { id: { in: logIds } },
    select: { id: true },
  });
  const foundLogIds = new Set(logs.map((log) => log.id));
  const missingLogIds = logIds.filter((id) => !foundLogIds.has(id));
  if (missingLogIds.length > 0) {
    await markLogsFailed(logIds.filter((id) => foundLogIds.has(id)), `Stock sync logs not found: ${missingLogIds.join(', ')}`);
    throw new UnrecoverableError(`Stock sync logs not found: ${missingLogIds.join(', ')}`);
  }

  const client = createShopStockClient(shop);
  const prestashopShopId = client instanceof PrestaShopStockClient
    ? client.configuredPrestaShopShopId
    : null;

  const useBulk = client instanceof PrestaShopStockClient &&
    client.hasBulkModule &&
    data.items.every((item) => isPositiveIntegerString(item.externalProductId));
  const syncMode: 'BULK' | 'WEBSERVICE' = useBulk ? 'BULK' : 'WEBSERVICE';

  await prisma.stockSyncLog.updateMany({
    where: { id: { in: logIds } },
    data: {
      status: 'PROCESSING',
      attemptCount: { increment: 1 },
      syncMode,
      prestashopShopId,
      errorMessage: null,
    },
  });

  console.log(
    `[StockSyncWorker] shop=${data.shopId} items=${data.items.length} mode=${syncMode}`,
  );

  if (useBulk) {
    return processBulkBatch(client, data.items, { syncMode, prestashopShopId });
  }

  return processWebserviceBatch(client, data.items, { syncMode, prestashopShopId });
}

async function processBulkBatch(
  client: PrestaShopStockClient,
  items: StockSyncBatchJobData['items'],
  meta: { syncMode: 'BULK' | 'WEBSERVICE'; prestashopShopId: string | null },
) {
  try {
    const result = await client.bulkUpdateStock(items.map((item) => ({
      productId: Number(item.externalProductId),
      quantity: item.quantity,
      leadTimeDays: item.leadTimeDays,
      warehouseAvailableAt: item.warehouseAvailableAt,
      outOfStockBehavior: item.outOfStockBehavior,
      availabilityPolicy: item.availabilityPolicy,
      ...(item.idProductAttribute === undefined ? {} : { idProductAttribute: item.idProductAttribute }),
    })));

    const hasItemErrors = result.results.some((item) => item.status === 'error');
    if (result.errors.length > 0 && !hasItemErrors) {
      const message = `kp_bulkstock errors: ${result.errors.join('; ')}`;
      await markLogsFailed(items.map((item) => item.logId), message, meta);
      return { success: false, failed: items.length, message };
    }

    const resultByKey = new Map(result.results.map((item) => [bulkResultKey(item.productId, item.idProductAttribute), item]));
    let failed = 0;

    for (const item of items) {
      const remote = resultByKey.get(bulkResultKey(Number(item.externalProductId), item.idProductAttribute));
      if (!remote) {
        failed++;
        const details = result.errors.length > 0 ? `: ${result.errors.join('; ')}` : '';
        await markLogsFailed([item.logId], `kp_bulkstock did not return item result${details}`, meta);
        continue;
      }

      if (remote?.status === 'error') {
        failed++;
        await markLogsFailed([item.logId], remote.message ?? 'kp_bulkstock item error', meta);
        continue;
      }

      await prisma.stockSyncLog.update({
        where: { id: item.logId },
        data: {
          status: 'SUCCESS',
          syncMode: meta.syncMode,
          remoteQuantity: remote.quantity ?? item.quantity,
          remoteLeadTimeDays: remote.leadTimeDays ?? item.leadTimeDays ?? null,
          remoteWarehouseAvailableAt: parseWarehouseAvailableAt(remote.warehouseAvailableAt ?? item.warehouseAvailableAt ?? null),
          stockAvailableId: null,
          prestashopShopId: meta.prestashopShopId,
          errorMessage: null,
          syncedAt: new Date(),
        },
      });
    }

    return {
      success: failed === 0,
      updated: result.updated,
      failed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown bulk stock error';
    await markLogsFailed(items.map((item) => item.logId), message, meta);
    throw error;
  }
}

async function processWebserviceBatch(
  client: ReturnType<typeof createShopStockClient>,
  items: StockSyncBatchJobData['items'],
  meta: { syncMode: 'BULK' | 'WEBSERVICE'; prestashopShopId: string | null },
) {
  let failed = 0;

  for (const item of items) {
    try {
      await client.updateStockQuantity(item.externalProductId, item.quantity, {
        outOfStockBehavior: item.outOfStockBehavior,
      });
      const remote = await confirmRemoteStock({
        client,
        externalProductId: item.externalProductId,
        expectedQuantity: item.quantity,
      });
      await prisma.stockSyncLog.update({
        where: { id: item.logId },
        data: {
          status: 'SUCCESS',
          syncMode: meta.syncMode,
          remoteQuantity: remote.stock,
          remoteLeadTimeDays: null,
          stockAvailableId: remote.stockAvailableId ?? null,
          prestashopShopId: remote.idShop ?? meta.prestashopShopId,
          errorMessage: null,
          syncedAt: new Date(),
        },
      });
    } catch (error) {
      failed++;
      const confirmation = error instanceof StockConfirmationError ? error.remote : null;
      await prisma.stockSyncLog.update({
        where: { id: item.logId },
        data: {
          status: 'FAILED',
          syncMode: meta.syncMode,
          remoteQuantity: confirmation?.stock ?? null,
          remoteLeadTimeDays: null,
          stockAvailableId: confirmation?.stockAvailableId ?? null,
          prestashopShopId: confirmation?.idShop ?? meta.prestashopShopId,
          errorMessage: error instanceof Error ? error.message : 'unknown stock sync error',
        },
      });
    }
  }

  return {
    success: failed === 0,
    failed,
  };
}

async function markLogsFailed(
  logIds: string[],
  errorMessage: string,
  meta: { syncMode?: 'BULK' | 'WEBSERVICE'; prestashopShopId?: string | null } = {},
) {
  if (logIds.length === 0) return;
  await prisma.stockSyncLog.updateMany({
    where: { id: { in: logIds } },
    data: {
      status: 'FAILED',
      ...(meta.syncMode ? { syncMode: meta.syncMode } : {}),
      ...(meta.prestashopShopId !== undefined ? { prestashopShopId: meta.prestashopShopId } : {}),
      errorMessage,
    },
  });
}

function isPositiveIntegerString(value: string) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0;
}

function bulkResultKey(productId: number, idProductAttribute?: number) {
  return `${productId}:${idProductAttribute ?? 0}`;
}

function resolvePublishedLeadTimeDays(
  decision: { leadTimeDays?: unknown; availabilityPolicy?: string | null },
  shopConfigJson: unknown,
) {
  if (decision.availabilityPolicy === 'OUT_OF_STOCK') return null;
  return normalizeOptionalLeadTimeDays(decision.leadTimeDays) ??
    getShopDefaultLeadTimeDays(shopConfigJson) ??
    0;
}

function formatWarehouseAvailableAt(value?: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function parseWarehouseAvailableAt(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getShopDefaultLeadTimeDays(configJson: unknown) {
  if (!configJson || typeof configJson !== 'object' || Array.isArray(configJson)) return null;
  return normalizeOptionalLeadTimeDays((configJson as Record<string, unknown>).defaultLeadTimeDays);
}

function normalizeOptionalLeadTimeDays(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) return null;
  return days;
}

async function confirmRemoteStock(input: {
  client: ReturnType<typeof createShopStockClient>;
  externalProductId: string;
  expectedQuantity: number;
}) {
  if (!input.client.getProductInventorySnapshot) {
    throw new Error('Klient sklepu nie obsługuje potwierdzenia stanu po synchronizacji');
  }

  const remote = input.client instanceof PrestaShopStockClient
    ? await input.client.getStockAvailableSnapshot(input.externalProductId)
    : await input.client.getProductInventorySnapshot(input.externalProductId);
  if (remote.stock === undefined || remote.stock === null) {
    throw new Error(`PrestaShop nie zwrócił quantity dla produktu ${input.externalProductId}`);
  }

  if (Number(remote.stock) !== input.expectedQuantity) {
    throw new StockConfirmationError(
      `PrestaShop stock confirmation mismatch for product ${input.externalProductId}: ` +
      `expected ${input.expectedQuantity}, remote ${remote.stock}, ` +
      `stock_available=${remote.stockAvailableId ?? 'unknown'}, id_shop=${remote.idShop ?? 'unknown'}`,
      remote,
    );
  }

  return remote;
}

class StockConfirmationError extends Error {
  constructor(
    message: string,
    readonly remote: ShopProductInventorySnapshot,
  ) {
    super(message);
    this.name = 'StockConfirmationError';
  }
}

export function startStockSyncWorker() {
  if (stockSyncWorker) {
    console.log('[StockSyncWorker] Worker already running');
    return;
  }

  stockSyncWorker = new Worker<StockSyncJobData>(
    STOCK_SYNC_QUEUE_NAME,
    async (job) => processStockSyncJob(job),
    {
      connection: getRedisConnection(),
      concurrency: 5,
      limiter: PRESTASHOP_SYNC_RATE_LIMIT,
    },
  );

  stockSyncWorker.on('completed', (job) => {
    console.log(`[StockSyncWorker] Job ${job.id} completed`);
  });

  stockSyncWorker.on('failed', async (job, err) => {
    console.error(`[StockSyncWorker] Job ${job?.id} failed:`, err.message);

    const logIds = job?.data
      ? 'items' in job.data
        ? job.data.items.map((item) => item.logId)
        : [job.data.logId]
      : [];

    if (logIds.length > 0) {
      await prisma.stockSyncLog.updateMany({
        where: { id: { in: logIds } },
        data: {
          status: 'FAILED',
          errorMessage: err.message,
        },
      }).catch(() => undefined);
    }
  });

  stockSyncWorker.on('error', (err) => {
    console.error('[StockSyncWorker] Worker error:', err);
  });

  console.log('[StockSyncWorker] Worker started');
}

export async function stopStockSyncWorker() {
  if (stockSyncWorker) {
    await stockSyncWorker.close();
    stockSyncWorker = null;
    console.log('[StockSyncWorker] Worker stopped');
  }
}
