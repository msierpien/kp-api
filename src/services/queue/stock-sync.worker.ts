import { Worker, Job } from 'bullmq';
import prisma from '../../lib/prisma';
import { createShopStockClient } from '../shops/shop-client.factory';
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

  const currentStock = Number(product.currentStock);

  await prisma.stockSyncLog.update({
    where: { id: logId },
    data: {
      status: 'PROCESSING',
      attemptCount: { increment: 1 },
      stockAfter: product.currentStock,
    },
  });

  const client = createShopStockClient(shop);
  await client.updateStockQuantity(externalProductId, currentStock);

  await prisma.stockSyncLog.update({
    where: { id: logId },
    data: {
      status: 'SUCCESS',
      stockAfter: product.currentStock,
      errorMessage: null,
      syncedAt: new Date(),
    },
  });

  return { success: true, stock: currentStock };
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
