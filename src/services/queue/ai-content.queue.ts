import { Queue, Job } from 'bullmq';
import { getBullMqConnection } from './render.queue';

export const AI_CONTENT_QUEUE_NAME = 'ai-content';

export interface AiContentJobData {
  jobId: string;
  itemId: string;
  tenantId: string;
  userId?: string | null;
}

let aiContentQueue: Queue<AiContentJobData> | null = null;

export function getAiContentQueue(): Queue<AiContentJobData> {
  if (!aiContentQueue) {
    aiContentQueue = new Queue<AiContentJobData>(AI_CONTENT_QUEUE_NAME, {
      connection: getBullMqConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 500, age: 24 * 3600 },
        removeOnFail: { count: 500, age: 7 * 24 * 3600 },
      },
    }) as Queue<AiContentJobData>;
  }

  return aiContentQueue as Queue<AiContentJobData>;
}

export async function addAiContentJob(data: AiContentJobData): Promise<Job<AiContentJobData>> {
  return getAiContentQueue().add('generate-product-content', data, {
    jobId: `ai-content-${data.itemId}`,
  });
}

export async function closeAiContentQueue() {
  if (aiContentQueue) {
    await aiContentQueue.close();
    aiContentQueue = null;
  }
}
