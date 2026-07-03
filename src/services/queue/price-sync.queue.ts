import { Queue, Job } from 'bullmq';
import { getBullMqConnection } from './render.queue';

export const PRICE_SYNC_QUEUE_NAME = 'price-sync';

export type PriceSyncTriggeredBy = 'MANUAL' | 'PRODUCT_PRICE_UPDATE' | 'SHOP_PUBLICATION' | 'COMPETITOR_AUTO';

export interface PriceSyncJobData {
  logId: string;
  tenantId: string;
  warehouseProductId: string;
  shopId: string;
  shopProductMappingId: string;
  externalProductId: string;
  triggeredBy: PriceSyncTriggeredBy;
}

let priceSyncQueue: Queue<PriceSyncJobData> | null = null;

export function getPriceSyncQueue(): Queue<PriceSyncJobData> {
  if (!priceSyncQueue) {
    priceSyncQueue = new Queue<PriceSyncJobData>(PRICE_SYNC_QUEUE_NAME, {
      connection: getBullMqConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 4000,
        },
        removeOnComplete: {
          count: 500,
          age: 24 * 3600,
        },
        removeOnFail: {
          count: 500,
          age: 7 * 24 * 3600,
        },
      },
    }) as Queue<PriceSyncJobData>;
  }

  return priceSyncQueue as Queue<PriceSyncJobData>;
}

export async function addPriceSyncJob(data: PriceSyncJobData): Promise<Job<PriceSyncJobData>> {
  const queue = getPriceSyncQueue();
  return queue.add('sync-price', data, {
    jobId: `price-${data.logId}`,
  });
}

export async function closePriceSyncQueue() {
  if (priceSyncQueue) {
    await priceSyncQueue.close();
    priceSyncQueue = null;
  }
}
