import { Worker, Job } from 'bullmq';
import { createLogger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { runWholesaleSyncJob } from '../admin/wholesale.service';
import { getBullMqConnection } from './render.queue';
import { WHOLESALE_SYNC_QUEUE_NAME, type WholesaleSyncJobData } from './wholesale-sync.queue';

const logger = createLogger('wholesale-sync-worker');

let wholesaleSyncWorker: Worker<WholesaleSyncJobData> | null = null;

async function processWholesaleSyncJob(job: Job<WholesaleSyncJobData>) {
  return runWholesaleSyncJob(job.data);
}

export function startWholesaleSyncWorker() {
  if (wholesaleSyncWorker) {
    logger.info('Worker already running');
    return;
  }

  wholesaleSyncWorker = new Worker<WholesaleSyncJobData>(
    WHOLESALE_SYNC_QUEUE_NAME,
    async (job) => processWholesaleSyncJob(job),
    {
      connection: getBullMqConnection(),
      concurrency: 1,
    },
  );

  wholesaleSyncWorker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Job completed');
  });

  wholesaleSyncWorker.on('failed', async (job, err) => {
    logger.error({ err, jobId: job?.id }, 'Job failed');

    if (job?.data.logId) {
      await prisma.wholesaleSyncLog.update({
        where: { id: job.data.logId },
        data: {
          status: 'FAILED',
          errorMessage: err.message,
          finishedAt: new Date(),
        },
      }).catch(() => undefined);
    }
  });

  wholesaleSyncWorker.on('error', (err) => {
    logger.error({ err }, 'Worker error');
  });

  logger.info('Worker started');
}

export async function stopWholesaleSyncWorker() {
  if (wholesaleSyncWorker) {
    await wholesaleSyncWorker.close();
    wholesaleSyncWorker = null;
    logger.info('Worker stopped');
  }
}
