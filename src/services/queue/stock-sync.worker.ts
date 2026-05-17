import { Worker, Job } from 'bullmq';
import prisma from '../../lib/prisma';
import { createShopStockClient } from '../shops/shop-client.factory';
import { getInventoryPublicationDecision } from '../stock/stock-sync.service';
import { getRedisConnection } from './render.queue';
import { STOCK_SYNC_QUEUE_NAME, type StockSyncJobData } from './stock-sync.queue';

let stockSyncWorker: Worker<StockSyncJobData> | null = null;
const PRESTASHOP_SYNC_RATE_LIMIT = { max: 30, duration: 60_000 };

async function processStockSyncJob(job: Job<StockSyncJobData>) {
  const { logId, warehouseProductId, shopId, externalProductId } = job.data;

  const [product, shop, log] = await Promise.all([
    prisma.warehouseProduct.findUnique({ where: { id: warehouseProductId } }),
    prisma.shop.findUnique({ where: { id: shopId } }),
    prisma.stockSyncLog.findUnique({ where: { id: logId } }),
  ]);

  if (!product) throw new Error(`Warehouse product not found: ${warehouseProductId}`);
  if (!shop) throw new Error(`Shop not found: ${shopId}`);
  if (!log) throw new Error(`Stock sync log not found: ${logId}`);

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
  await client.updateStockQuantity(externalProductId, Number(decision.publishedQuantity), {
    outOfStockBehavior: decision.outOfStockBehavior,
  });

  await prisma.stockSyncLog.update({
    where: { id: logId },
    data: {
      status: 'SUCCESS',
      stockAfter: product.currentStock,
      publishedQuantity: decision.publishedQuantity,
      availabilityPolicy: decision.availabilityPolicy,
      outOfStockBehavior: decision.outOfStockBehavior,
      warningMessage: decision.warningMessage,
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
      concurrency: 1,
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
