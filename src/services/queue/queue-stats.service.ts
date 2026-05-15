import { Queue, Job } from 'bullmq';
import { getRenderQueue } from './render.queue';
import { getEmailQueue } from './email.queue';
import { getStockSyncQueue } from './stock-sync.queue';
import { getPriceSyncQueue } from './price-sync.queue';

// Map queue names to queue instances
function getQueues(): Record<string, Queue> {
  return {
    render: getRenderQueue() as Queue,
    email: getEmailQueue() as Queue,
    stockSync: getStockSyncQueue() as Queue,
    priceSync: getPriceSyncQueue() as Queue,
  };
}

export interface QueueStats {
  name: string;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  };
  lastJob?: {
    id: string;
    processedOn?: number;
    finishedOn?: number;
  } | null;
}

export interface JobDetails {
  id: string;
  name: string;
  data: any;
  opts: any;
  progress: number;
  returnvalue?: any;
  stacktrace: string[];
  attemptsMade: number;
  failedReason?: string;
  finishedOn?: number;
  processedOn?: number;
  timestamp: number;
  delay?: number;
}

/**
 * Get all available queues with their stats
 */
export async function getAllQueuesStats(): Promise<QueueStats[]> {
  const queueNames = Object.keys(getQueues());
  const stats = await Promise.all(
    queueNames.map(name => getQueueStats(name))
  );
  return stats;
}

/**
 * Get stats for a specific queue
 */
export async function getQueueStats(queueName: string): Promise<QueueStats> {
  const queue = getQueues()[queueName];
  if (!queue) {
    throw new Error(`Queue '${queueName}' not found`);
  }

  const [waiting, active, completed, failed, delayed, isPaused] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
    queue.isPaused(),
  ]);

  // Get last processed job
  const completedJobs = await queue.getCompleted(0, 0);
  const lastJob = completedJobs.length > 0 ? completedJobs[0] : null;

  return {
    name: queueName,
    counts: {
      waiting,
      active,
      completed,
      failed,
      delayed,
      paused: isPaused ? 1 : 0,
    },
    lastJob: lastJob ? {
      id: lastJob.id!,
      processedOn: lastJob.processedOn,
      finishedOn: lastJob.finishedOn,
    } : null,
  };
}

/**
 * Get jobs by status from a queue
 */
export async function getQueueJobs(
  queueName: string,
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused' = 'waiting',
  start: number = 0,
  end: number = 19
): Promise<Job[]> {
  const queue = getQueues()[queueName];
  if (!queue) {
    throw new Error(`Queue '${queueName}' not found`);
  }

  let jobs: Job[] = [];

  switch (status) {
    case 'waiting':
      jobs = await queue.getWaiting(start, end);
      break;
    case 'active':
      jobs = await queue.getActive(start, end);
      break;
    case 'completed':
      jobs = await queue.getCompleted(start, end);
      break;
    case 'failed':
      jobs = await queue.getFailed(start, end);
      break;
    case 'delayed':
      jobs = await queue.getDelayed(start, end);
      break;
    case 'paused':
      jobs = [];
      break;
  }

  return jobs;
}

/**
 * Get failed jobs from a queue
 */
export async function getFailedJobs(
  queueName: string,
  limit: number = 50
): Promise<Job[]> {
  return getQueueJobs(queueName, 'failed', 0, limit - 1);
}

/**
 * Get details of a specific job
 */
export async function getJobDetails(
  queueName: string,
  jobId: string
): Promise<JobDetails | null> {
  const queue = getQueues()[queueName];
  if (!queue) {
    throw new Error(`Queue '${queueName}' not found`);
  }

  const job = await queue.getJob(jobId);
  if (!job) {
    return null;
  }

  return {
    id: job.id!,
    name: job.name,
    data: job.data,
    opts: job.opts,
    progress: typeof job.progress === 'number' ? job.progress : 0,
    returnvalue: job.returnvalue,
    stacktrace: job.stacktrace || [],
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    finishedOn: job.finishedOn,
    processedOn: job.processedOn,
    timestamp: job.timestamp,
    delay: job.opts.delay,
  };
}

/**
 * Retry a failed job
 */
export async function retryJob(
  queueName: string,
  jobId: string
): Promise<void> {
  const queue = getQueues()[queueName];
  if (!queue) {
    throw new Error(`Queue '${queueName}' not found`);
  }

  const job = await queue.getJob(jobId);
  if (!job) {
    throw new Error(`Job '${jobId}' not found in queue '${queueName}'`);
  }

  // Retry the job
  await job.retry();
}

/**
 * Retry all failed jobs in a queue
 */
export async function retryAllFailed(queueName: string): Promise<number> {
  const failedJobs = await getFailedJobs(queueName, 500);
  
  let retriedCount = 0;
  for (const job of failedJobs) {
    try {
      await job.retry();
      retriedCount++;
    } catch (error) {
      console.error(`[QueueStats] Failed to retry job ${job.id}:`, error);
    }
  }

  return retriedCount;
}

/**
 * Delete a job from queue
 */
export async function deleteJob(
  queueName: string,
  jobId: string
): Promise<void> {
  const queue = getQueues()[queueName];
  if (!queue) {
    throw new Error(`Queue '${queueName}' not found`);
  }

  const job = await queue.getJob(jobId);
  if (!job) {
    throw new Error(`Job '${jobId}' not found in queue '${queueName}'`);
  }

  await job.remove();
}

/**
 * Clean old jobs from queue
 */
export async function cleanQueue(
  queueName: string,
  grace: number = 3600000, // 1 hour in ms
  limit: number = 1000,
  type: 'completed' | 'failed' = 'completed'
): Promise<string[]> {
  const queue = getQueues()[queueName];
  if (!queue) {
    throw new Error(`Queue '${queueName}' not found`);
  }

  return await queue.clean(grace, limit, type);
}

/**
 * Get available queue names
 */
export function getQueueNames(): string[] {
  return Object.keys(getQueues());
}
