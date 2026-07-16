import { Worker, Job } from 'bullmq';
import { createLogger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { createShopStockClient } from '../shops/shop-client.factory';
import { getBullMqConnection } from './render.queue';
import { PRICE_SYNC_QUEUE_NAME, type PriceSyncJobData } from './price-sync.queue';

const logger = createLogger('price-sync-worker');

let priceSyncWorker: Worker<PriceSyncJobData> | null = null;
const PRESTASHOP_SYNC_RATE_LIMIT = { max: 30, duration: 60_000 };
const PRESTASHOP_SYNC_CONCURRENCY = 1;

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

  const costBasis = product.averagePurchaseCost ?? product.purchasePrice;
  const wholesalePrice = costBasis === null ? null : Number(costBasis);
  const priceUpdateOptions = wholesalePrice !== null && Number.isFinite(wholesalePrice) && wholesalePrice >= 0
    ? { wholesalePrice }
    : undefined;

  await client.updateProductPrice(
    externalProductId,
    targetPrice,
    priceUpdateOptions,
  );

  const syncedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.priceSyncLog.update({
      where: { id: logId },
      data: {
        status: 'SUCCESS',
        priceBefore: mapping.externalPrice,
        priceAfter: log.priceAfter,
        errorMessage: null,
        syncedAt,
      },
    });
    await tx.shopProductMapping.update({
      where: { id: shopProductMappingId },
      data: {
        externalPrice: log.priceAfter,
        lastSyncAt: syncedAt,
      },
    });
    await tx.priceChangeHistory.create({
      data: {
        tenantId: log.tenantId,
        warehouseProductId,
        shopId,
        shopProductMappingId,
        priceSyncLogId: logId,
        triggeredBy: log.triggeredBy,
        priceBefore: mapping.externalPrice,
        priceAfter: log.priceAfter,
        changedAt: syncedAt,
      },
    });

    const keep = await tx.priceChangeHistory.findMany({
      where: { tenantId: log.tenantId, warehouseProductId, shopId, shopProductMappingId },
      orderBy: { changedAt: 'desc' },
      skip: 5,
      select: { id: true },
    });
    if (keep.length > 0) {
      await tx.priceChangeHistory.deleteMany({
        where: { id: { in: keep.map((item) => item.id) } },
      });
    }
  });

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
      connection: getBullMqConnection(),
      concurrency: PRESTASHOP_SYNC_CONCURRENCY,
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
