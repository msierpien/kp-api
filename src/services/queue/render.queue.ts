import { Queue, QueueEvents, Job } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../../config';
import type { TemplateLayoutJson } from '../../types/template-layout';

export interface LayoutLayerOverride {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
}

export interface LayoutOverrides {
  layers: Record<string, LayoutLayerOverride>;
}

// Singleton connection
let redisConnection: IORedis | null = null;

export function getRedisConnection(): IORedis {
  if (!redisConnection) {
    redisConnection = new IORedis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
    });

    redisConnection.on('connect', () => {
      console.log('[Redis] Connected to Redis');
    });

    redisConnection.on('error', (err) => {
      console.error('[Redis] Connection error:', err);
    });
  }
  return redisConnection;
}

export function getBullMqConnection() {
  return getRedisConnection() as any;
}

// Job types
export type RenderJobType = 'PNG_PREVIEW' | 'PDF_PRINT';

export interface RenderJobData {
  caseId: string;
  jobType: RenderJobType;
  answers: Record<string, string | number | boolean>;
  templateName: string;
  templateVersion: number;
  layoutConfig?: TemplateLayoutJson | null;
  layoutOverrides?: LayoutOverrides | null;
  lastError?: {
    message: string;
    stack?: string;
    timestamp: string;
    attemptNumber: number;
    caseId: string;
  };
  orderId: string;
  orderReference?: string;
  customerName?: string;
  productName?: string;
  renderOptions?: {
    width?: number;
    height?: number;
    scale?: number;
    includeWatermark?: boolean;
  };
}

export interface RenderJobResult {
  success: boolean;
  assetId?: string;
  filePath?: string;
  fileUrl?: string;
  fileSize?: number;
  error?: string;
  validationSummary?: {
    isValid: boolean;
    errors: Array<{ field: string; message: string; severity: string }>;
    warnings: Array<{ field: string; message: string; severity: string }>;
  };
}

// Queue names
export const RENDER_QUEUE_NAME = 'render-jobs';

// Queue instance
let renderQueue: Queue<RenderJobData, RenderJobResult> | null = null;
let queueEvents: QueueEvents | null = null;

/**
 * Pobiera lub tworzy instancję kolejki renderowania
 */
export function getRenderQueue(): Queue<RenderJobData, RenderJobResult> {
  if (!renderQueue) {
    const connection = getBullMqConnection();

    renderQueue = new Queue<RenderJobData, RenderJobResult>(RENDER_QUEUE_NAME, {
      connection,
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
          count: 50, // Keep last 50 failed jobs
          age: 7 * 24 * 3600, // Keep for 7 days
        },
      },
    }) as Queue<RenderJobData, RenderJobResult>;

    console.log('[RenderQueue] Queue initialized');
  }
  return renderQueue as Queue<RenderJobData, RenderJobResult>;
}

/**
 * Pobiera QueueEvents dla monitorowania
 */
export function getQueueEvents(): QueueEvents {
  if (!queueEvents) {
    const connection = getBullMqConnection();
    queueEvents = new QueueEvents(RENDER_QUEUE_NAME, { connection });
    console.log('[RenderQueue] QueueEvents initialized');
  }
  return queueEvents;
}

/**
 * Dodaje job do kolejki preview (PNG)
 */
export async function addPreviewJob(data: Omit<RenderJobData, 'jobType'>): Promise<Job<RenderJobData, RenderJobResult>> {
  const queue = getRenderQueue();

  const job = await queue.add(
    'preview',
    {
      ...data,
      jobType: 'PNG_PREVIEW',
      renderOptions: {
        width: 800,
        height: 1200,
        scale: 1,
        includeWatermark: true,
        ...data.renderOptions,
      },
    },
    {
      priority: 1, // High priority for preview
      jobId: `preview-${data.caseId}-${Date.now()}`,
    }
  );

  console.log(`[RenderQueue] Preview job added: ${job.id}`);
  return job;
}

/**
 * Dodaje job do kolejki final PDF
 */
export async function addFinalPdfJob(data: Omit<RenderJobData, 'jobType'>): Promise<Job<RenderJobData, RenderJobResult>> {
  const queue = getRenderQueue();

  const job = await queue.add(
    'final-pdf',
    {
      ...data,
      jobType: 'PDF_PRINT',
      renderOptions: {
        width: 148, // A5 width in mm
        height: 210, // A5 height in mm
        includeWatermark: false,
        ...data.renderOptions,
      },
    },
    {
      priority: 5, // Lower priority than preview
      jobId: `pdf-${data.caseId}-${Date.now()}`,
    }
  );

  console.log(`[RenderQueue] Final PDF job added: ${job.id}`);
  return job;
}

/**
 * Pobiera status joba
 */
export async function getJobStatus(jobId: string): Promise<{
  id: string;
  state: string;
  progress: number;
  result?: RenderJobResult;
  failedReason?: string;
  attemptsMade: number;
  timestamp: number;
} | null> {
  const queue = getRenderQueue();
  const job = await queue.getJob(jobId);

  if (!job) return null;

  const state = await job.getState();

  return {
    id: job.id!,
    state,
    progress: job.progress as number,
    result: job.returnvalue,
    failedReason: job.failedReason,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
  };
}

/**
 * Pobiera statystyki kolejki
 */
export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}> {
  const queue = getRenderQueue();

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  const paused = await queue.isPaused() ? 1 : 0;

  return { waiting, active, completed, failed, delayed, paused };
}

/**
 * Retry failed job
 */
export async function retryJob(jobId: string): Promise<boolean> {
  const queue = getRenderQueue();
  const job = await queue.getJob(jobId);

  if (!job) return false;

  await job.retry();
  console.log(`[RenderQueue] Job retried: ${jobId}`);
  return true;
}

/**
 * Pause queue
 */
export async function pauseQueue(): Promise<void> {
  const queue = getRenderQueue();
  await queue.pause();
  console.log('[RenderQueue] Queue paused');
}

/**
 * Resume queue
 */
export async function resumeQueue(): Promise<void> {
  const queue = getRenderQueue();
  await queue.resume();
  console.log('[RenderQueue] Queue resumed');
}

/**
 * Clean old jobs
 */
export async function cleanOldJobs(olderThanMs: number = 7 * 24 * 3600 * 1000): Promise<void> {
  const queue = getRenderQueue();

  await queue.clean(olderThanMs, 100, 'completed');
  await queue.clean(olderThanMs, 100, 'failed');

  console.log(`[RenderQueue] Cleaned jobs older than ${olderThanMs}ms`);
}

/**
 * Graceful shutdown
 */
export async function closeQueue(): Promise<void> {
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }

  if (renderQueue) {
    await renderQueue.close();
    renderQueue = null;
  }

  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }

  console.log('[RenderQueue] Queue closed');
}
