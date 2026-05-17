import { Queue, Job } from 'bullmq';
import { getRedisConnection } from './render.queue';

export const STOCK_SYNC_QUEUE_NAME = 'stock-sync';

export type StockSyncTriggeredBy = 'DOCUMENT_CONFIRM' | 'DOCUMENT_CANCEL' | 'MANUAL' | 'WHOLESALE_SYNC' | 'SCHEDULED';

export interface StockSyncJobData {
  logId: string;
  tenantId: string;
  warehouseProductId: string;
  shopId: string;
  externalProductId: string;
  triggeredBy: StockSyncTriggeredBy;
  documentId?: string;
}

let stockSyncQueue: Queue<StockSyncJobData> | null = null;

export function getStockSyncQueue(): Queue<StockSyncJobData> {
  if (!stockSyncQueue) {
    stockSyncQueue = new Queue<StockSyncJobData>(STOCK_SYNC_QUEUE_NAME, {
      connection: getRedisConnection(),
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
    });
  }

  return stockSyncQueue;
}

export async function addStockSyncJob(data: StockSyncJobData): Promise<Job<StockSyncJobData>> {
  const queue = getStockSyncQueue();
  return queue.add('sync-stock', data, {
    jobId: `stock-${data.logId}`,
  });
}

export async function closeStockSyncQueue() {
  if (stockSyncQueue) {
    await stockSyncQueue.close();
    stockSyncQueue = null;
  }
}
