import { Worker, Job } from 'bullmq';
import { createLogger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { createShopStockClient } from '../shops/shop-client.factory';
import { getRedisConnection } from './render.queue';
import { PRICE_SYNC_QUEUE_NAME, type PriceSyncJobData } from './price-sync.queue';

const logger = createLogger('price-sync-worker');

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
  if (log.priceAfter === null) throw new Error(`Price sync log has no target price: ${logId}`);

  const targetPrice = Number(log.priceAfter);
  if (!Number.isFinite(targetPrice) || targetPrice < 0) {
    throw new Error(`Invalid target price for price sync log: ${logId}`);
  }

  await prisma.priceSyncLog.update({
    where: { id: logId },
    data: {
      status: 'PROCESSING',
      attemptCount: { increment: 1 },
      priceBefore: mapping.externalPrice,
      priceAfter: log.priceAfter,
    },
  });

  const client = createShopStockClient(shop);
  if (!client.updateProductPrice) {
    throw new Error(`Price sync is not implemented for platform ${shop.platform}`);
  }

  await client.updateProductPrice(externalProductId, targetPrice);

  await prisma.$transaction([
    prisma.priceSyncLog.update({
      where: { id: logId },
      data: {
        status: 'SUCCESS',
        priceBefore: mapping.externalPrice,
        priceAfter: log.priceAfter,
        errorMessage: null,
        syncedAt: new Date(),
      },
    }),
    prisma.shopProductMapping.update({
      where: { id: shopProductMappingId },
      data: {
        externalPrice: log.priceAfter,
        lastSyncAt: new Date(),
      },
    }),
  ]);

  return { success: true, price: targetPrice };
}

export function startPriceSyncWorker() {
  if (priceSyncWorker) {
    logger.info('Worker already running');
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
    logger.info({ jobId: job.id }, 'Job completed');
  });

  priceSyncWorker.on('failed', async (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Job failed');

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
    logger.error({ err }, 'Worker error');
  });

  logger.info('Worker started');
}

export async function stopPriceSyncWorker() {
  if (priceSyncWorker) {
    await priceSyncWorker.close();
    priceSyncWorker = null;
    logger.info('Worker stopped');
  }
}
