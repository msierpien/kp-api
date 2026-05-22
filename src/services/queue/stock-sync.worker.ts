import { Worker, Job, UnrecoverableError } from 'bullmq';
import prisma from '../../lib/prisma';
import { createShopStockClient } from '../shops/shop-client.factory';
import { PrestaShopStockClient } from '../shops/prestashop-stock-client';
import type { ShopProductInventorySnapshot } from '../shops/shop-stock-client.interface';
import { getInventoryPublicationDecision } from '../stock/stock-sync.service';
import { getRedisConnection } from './render.queue';
import { STOCK_SYNC_QUEUE_NAME, type StockSyncJobData } from './stock-sync.queue';

let stockSyncWorker: Worker<StockSyncJobData> | null = null;
const PRESTASHOP_SYNC_RATE_LIMIT = { max: 60, duration: 60_000 };

async function processStockSyncJob(job: Job<StockSyncJobData>) {
  const { logId, warehouseProductId, shopId, externalProductId } = job.data;

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

  await prisma.stockSyncLog.update({
    where: { id: logId },
    data: {
      status: 'PROCESSING',
      attemptCount: { increment: 1 },
      stockAfter: product.currentStock,
      publishedQuantity: decision.publishedQuantity,
      availabilityPolicy: decision.availabilityPolicy,
      outOfStockBehavior: decision.outOfStockBehavior,
      warningMessage: decision.warningMessage,
    },
  });

  const client = createShopStockClient(shop);
  const prestashopShopId = client instanceof PrestaShopStockClient
    ? client.configuredPrestaShopShopId
    : null;

  const externalNumericProductId = Number(externalProductId);
  const useBulk = client instanceof PrestaShopStockClient &&
    client.hasBulkModule &&
    Number.isInteger(externalNumericProductId) &&
    externalNumericProductId > 0;
  let syncMode: 'BULK' | 'WEBSERVICE' = useBulk ? 'BULK' : 'WEBSERVICE';

  await prisma.stockSyncLog.update({
    where: { id: logId },
    data: {
      syncMode,
      prestashopShopId,
    },
  });

  console.log(
    `[StockSyncWorker] product=${externalProductId} qty=${decision.publishedQuantity} ` +
    `mode=${useBulk ? 'BULK' : 'WEBSERVICE'}`,
  );

  if (useBulk) {
    await client.bulkUpdateStock([{
      productId: externalNumericProductId,
      quantity: Math.max(0, Math.floor(Number(decision.publishedQuantity))),
    }]);
  } else {
    await client.updateStockQuantity(externalProductId, Number(decision.publishedQuantity), {
      outOfStockBehavior: decision.outOfStockBehavior,
    });
  }

  const expectedQuantity = Math.max(0, Math.floor(Number(decision.publishedQuantity)));
  let remote: Awaited<ReturnType<typeof confirmRemoteStock>>;
  try {
    remote = await confirmRemoteStock({
      client,
      externalProductId,
      expectedQuantity,
    });
  } catch (error) {
    const confirmation = error instanceof StockConfirmationError ? error.remote : null;
    await prisma.stockSyncLog.update({
      where: { id: logId },
      data: {
        syncMode,
        remoteQuantity: confirmation?.stock ?? null,
        stockAvailableId: confirmation?.stockAvailableId ?? null,
        prestashopShopId: confirmation?.idShop ?? prestashopShopId,
      },
    });
    throw error;
  }

  await prisma.stockSyncLog.update({
    where: { id: logId },
    data: {
      status: 'SUCCESS',
      stockAfter: product.currentStock,
      publishedQuantity: decision.publishedQuantity,
      availabilityPolicy: decision.availabilityPolicy,
      outOfStockBehavior: decision.outOfStockBehavior,
      warningMessage: decision.warningMessage,
      syncMode,
      remoteQuantity: remote.stock,
      stockAvailableId: remote.stockAvailableId ?? null,
      prestashopShopId: remote.idShop ?? prestashopShopId,
      errorMessage: null,
      syncedAt: new Date(),
    },
  });

  return {
    success: true,
    stock: Number(product.currentStock),
    publishedQuantity: Number(decision.publishedQuantity),
    availabilityPolicy: decision.availabilityPolicy,
  };
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

    if (job?.data.logId) {
      await prisma.stockSyncLog.update({
        where: { id: job.data.logId },
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
