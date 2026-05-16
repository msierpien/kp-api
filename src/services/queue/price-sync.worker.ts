import { Worker, Job } from 'bullmq';
import prisma from '../../lib/prisma';
import { createShopStockClient } from '../shops/shop-client.factory';
import { getRedisConnection } from './render.queue';
import { PRICE_SYNC_QUEUE_NAME, type PriceSyncJobData } from './price-sync.queue';

let priceSyncWorker: Worker<PriceSyncJobData> | null = null;
const PRESTASHOP_SYNC_RATE_LIMIT = { max: 30, duration: 60_000 };

async function processPriceSyncJob(job: Job<PriceSyncJobData>) {
  const { logId, warehouseProductId, shopId, shopProductMappingId, externalProductId } = job.data;

  const [product, shop, mapping, log] = await Promise.all([
    prisma.warehouseProduct.findUnique({ where: { id: warehouseProductId } }),
    prisma.shop.findUnique({ where: { id: shopId } }),
    prisma.shopProductMapping.findUnique({ where: { id: shopProductMappingId } }),
    prisma.priceSyncLog.findUnique({ where: { id: logId } }),
  ]);

  if (!product) throw new Error(`Warehouse product not found: ${warehouseProductId}`);
  if (!shop) throw new Error(`Shop not found: ${shopId}`);
  if (!mapping) throw new Error(`Shop product mapping not found: ${shopProductMappingId}`);
  if (!log) throw new Error(`Price sync log not found: ${logId}`);
  if (product.retailPrice === null) throw new Error(`Warehouse product has no retail price: ${warehouseProductId}`);

  const retailPrice = Number(product.retailPrice);

  await prisma.priceSyncLog.update({
    where: { id: logId },
    data: {
      status: 'PROCESSING',
      attemptCount: { increment: 1 },
      priceBefore: mapping.externalPrice,
      priceAfter: product.retailPrice,
    },
  });

  const client = createShopStockClient(shop);
  if (!client.updateProductPrice) {
    throw new Error(`Price sync is not implemented for platform ${shop.platform}`);
  }

  await client.updateProductPrice(externalProductId, retailPrice);

  await prisma.$transaction([
    prisma.priceSyncLog.update({
      where: { id: logId },
      data: {
        status: 'SUCCESS',
        priceBefore: mapping.externalPrice,
        priceAfter: product.retailPrice,
        errorMessage: null,
        syncedAt: new Date(),
      },
    }),
    prisma.shopProductMapping.update({
      where: { id: shopProductMappingId },
      data: {
        externalPrice: product.retailPrice,
        lastSyncAt: new Date(),
      },
    }),
  ]);

  return { success: true, price: retailPrice };
}

export function startPriceSyncWorker() {
  if (priceSyncWorker) {
    console.log('[PriceSyncWorker] Worker already running');
    return;
  }

  priceSyncWorker = new Worker<PriceSyncJobData>(
    PRICE_SYNC_QUEUE_NAME,
    async (job) => processPriceSyncJob(job),
    {
      connection: getRedisConnection(),
      concurrency: 1,
      limiter: PRESTASHOP_SYNC_RATE_LIMIT,
    },
  );

  priceSyncWorker.on('completed', (job) => {
    console.log(`[PriceSyncWorker] Job ${job.id} completed`);
  });

  priceSyncWorker.on('failed', async (job, err) => {
    console.error(`[PriceSyncWorker] Job ${job?.id} failed:`, err.message);

    if (job?.data.logId) {
      await prisma.priceSyncLog.update({
        where: { id: job.data.logId },
        data: {
          status: 'FAILED',
          errorMessage: err.message,
        },
      }).catch(() => undefined);
    }
  });

  priceSyncWorker.on('error', (err) => {
    console.error('[PriceSyncWorker] Worker error:', err);
  });

  console.log('[PriceSyncWorker] Worker started');
}

export async function stopPriceSyncWorker() {
  if (priceSyncWorker) {
    await priceSyncWorker.close();
    priceSyncWorker = null;
    console.log('[PriceSyncWorker] Worker stopped');
  }
}
