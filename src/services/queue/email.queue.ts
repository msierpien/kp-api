import { Queue } from 'bullmq';
import { config } from '../../config';
import { createLogger } from '../../lib/logger';

const logger = createLogger('email-queue');

/**
 * Email job data interfaces
 */
export interface PersonalizationEmailJob {
  to: string;
  customerName: string;
  orderReference: string;
  shopName: string;
  items: Array<{
    productName: string;
    quantity: number;
    personalizationUrl: string;
  }>;
  baseUrl: string;
  caseId?: string; // Optional: for tracking
}

export interface TestEmailJob {
  to: string;
  subject?: string;
  message?: string;
}

export type EmailJobData = PersonalizationEmailJob | TestEmailJob;

/**
 * BullMQ Queue for email sending
 */
export const emailQueue = new Queue<EmailJobData>('email', {
  connection: {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000, // 2s, 4s, 8s
    },
    removeOnComplete: {
      count: 100, // Keep last 100 completed jobs
      age: 24 * 3600, // Keep for 24 hours
    },
    removeOnFail: {
      count: 500, // Keep last 500 failed jobs for debugging
      age: 7 * 24 * 3600, // Keep for 7 days
    },
  },
});

/**
 * Add personalization email to queue
 */
export async function queuePersonalizationEmail(data: PersonalizationEmailJob) {
  const job = await emailQueue.add('personalization', data, {
    jobId: data.caseId ? `personalization-${data.caseId}` : undefined,
  });

  logger.info({ jobId: job.id, to: data.to }, 'Queued personalization email');
  return job;
}

/**
 * Add test email to queue
 */
export async function queueTestEmail(data: TestEmailJob) {
  const job = await emailQueue.add('test', data);
  
  logger.info({ jobId: job.id, to: data.to }, 'Queued test email');
  return job;
}

/**
 * Close email queue connection
 */
export async function closeEmailQueue() {
  await emailQueue.close();
  logger.info('Queue closed');
}

/**
 * Get email queue instance
 */
export function getEmailQueue() {
  return emailQueue;
}

/**
 * Get email queue stats
 */
export async function getEmailQueueStats() {
  const [waiting, active, completed, failed] = await Promise.all([
    emailQueue.getWaitingCount(),
    emailQueue.getActiveCount(),
    emailQueue.getCompletedCount(),
    emailQueue.getFailedCount(),
  ]);

  return { waiting, active, completed, failed };
}
