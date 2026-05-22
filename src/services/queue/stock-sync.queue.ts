import { Queue, Job } from 'bullmq';
import { getRedisConnection } from './render.queue';

export const STOCK_SYNC_QUEUE_NAME = 'stock-sync';

export type StockSyncAvailabilityPolicy = 'IN_STOCK' | 'BACKORDER_FROM_WHOLESALE' | 'OUT_OF_STOCK';

export type StockSyncTriggeredBy =
  | 'DOCUMENT_CONFIRM'
  | 'DOCUMENT_CANCEL'
  | 'ORDER_RESERVATION'
  | 'ORDER_RESERVATION_RELEASE'
  | 'MANUAL'
  | 'WHOLESALE_SYNC'
  | 'SCHEDULED'
  | 'LEAD_TIME_UPDATE';

export interface StockSyncLegacyJobData {
  logId: string;
  tenantId: string;
  warehouseProductId: string;
  shopId: string;
  externalProductId: string;
  triggeredBy: StockSyncTriggeredBy;
  documentId?: string;
}

export interface StockSyncBatchItem {
  logId: string;
  warehouseProductId: string;
  externalProductId: string;
  quantity: number;
  leadTimeDays?: number | null;
  warehouseAvailableAt?: string | null;
  outOfStockBehavior?: 0 | 1;
  availabilityPolicy?: StockSyncAvailabilityPolicy;
  idProductAttribute?: number;
}

export interface StockSyncBatchJobData {
  tenantId: string;
  shopId: string;
  triggeredBy: StockSyncTriggeredBy;
  documentId?: string;
  items: StockSyncBatchItem[];
}

export type StockSyncJobData = StockSyncLegacyJobData | StockSyncBatchJobData;

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
  if ('items' in data) {
    return queue.add('sync-stock-batch', data, {
      jobId: buildBatchJobId(data.shopId, data.items, 1),
    });
  }

  return queue.add('sync-stock', data, {
    jobId: `stock-${data.logId}`,
  });
}

export async function addStockSyncBatchJobs(data: Omit<StockSyncBatchJobData, 'items'> & { items: StockSyncBatchItem[] }): Promise<Array<Job<StockSyncJobData>>> {
  const queue = getStockSyncQueue();
  const jobs: Array<Job<StockSyncJobData>> = [];

  for (let i = 0; i < data.items.length; i += 500) {
    const items = data.items.slice(i, i + 500);
    const batchNumber = Math.floor(i / 500) + 1;
    jobs.push(await queue.add('sync-stock-batch', { ...data, items }, {
      jobId: buildBatchJobId(data.shopId, items, batchNumber),
    }));
  }

  return jobs;
}

function buildBatchJobId(shopId: string, items: StockSyncBatchItem[], batchNumber: number) {
  const firstLogId = items[0]?.logId ?? 'empty';
  const lastLogId = items[items.length - 1]?.logId ?? firstLogId;
  return `stock-batch-${shopId}-${batchNumber}-${items.length}-${firstLogId}-${lastLogId}`;
}

export async function closeStockSyncQueue() {
  if (stockSyncQueue) {
    await stockSyncQueue.close();
    stockSyncQueue = null;
  }
}
