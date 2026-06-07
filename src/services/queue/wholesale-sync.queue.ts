import { Queue, Job } from 'bullmq';
import { getBullMqConnection } from './render.queue';

export const WHOLESALE_SYNC_QUEUE_NAME = 'wholesale-sync';

export type WholesaleSyncTriggeredBy = 'MANUAL' | 'SCHEDULER';

export interface WholesaleSyncJobData {
  logId: string;
  tenantId: string;
  providerId: string;
  triggeredBy: WholesaleSyncTriggeredBy;
  limit?: number;
  batchSize?: number;
}

let wholesaleSyncQueue: Queue<WholesaleSyncJobData> | null = null;

export function getWholesaleSyncQueue(): Queue<WholesaleSyncJobData> {
  if (!wholesaleSyncQueue) {
    wholesaleSyncQueue = new Queue<WholesaleSyncJobData>(WHOLESALE_SYNC_QUEUE_NAME, {
      connection: getBullMqConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: {
          count: 500,
          age: 24 * 3600,
        },
        removeOnFail: {
          count: 500,
          age: 7 * 24 * 3600,
        },
      },
    }) as Queue<WholesaleSyncJobData>;
  }

  return wholesaleSyncQueue as Queue<WholesaleSyncJobData>;
}

export async function addWholesaleSyncJob(data: WholesaleSyncJobData): Promise<Job<WholesaleSyncJobData>> {
  const queue = getWholesaleSyncQueue();
  return queue.add('sync-wholesale', data, {
    jobId: `wholesale-${data.logId}`,
  });
}

export async function closeWholesaleSyncQueue() {
  if (wholesaleSyncQueue) {
    await wholesaleSyncQueue.close();
    wholesaleSyncQueue = null;
  }
}
