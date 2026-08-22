import { Queue, Job } from 'bullmq';
import { getBullMqConnection } from './render.queue';

export const WAREHOUSE_CLEANUP_QUEUE_NAME = 'warehouse-cleanup';

export interface WarehouseCleanupJobData {
  runId: string;
  tenantId: string;
}

let warehouseCleanupQueue: Queue<WarehouseCleanupJobData> | null = null;

export function getWarehouseCleanupQueue(): Queue<WarehouseCleanupJobData> {
  if (!warehouseCleanupQueue) {
    warehouseCleanupQueue = new Queue<WarehouseCleanupJobData>(WAREHOUSE_CLEANUP_QUEUE_NAME, {
      connection: getBullMqConnection(),
      defaultJobOptions: {
        // Bez automatycznych powtorek: przebieg zapisuje wlasny stan i pozycje,
        // wiec ponowne przejscie calosci zdublowaloby wpisy w logu. Bledy
        // wznawia sie swiadomie, przyciskiem "Ponów tylko błędy".
        attempts: 1,
        removeOnComplete: { count: 100, age: 7 * 24 * 3600 },
        removeOnFail: { count: 100, age: 14 * 24 * 3600 },
      },
    }) as Queue<WarehouseCleanupJobData>;
  }

  return warehouseCleanupQueue as Queue<WarehouseCleanupJobData>;
}

export async function addWarehouseCleanupJob(data: WarehouseCleanupJobData): Promise<Job<WarehouseCleanupJobData>> {
  return getWarehouseCleanupQueue().add('cleanup-run', data, {
    jobId: `warehouse-cleanup-${data.runId}`,
  });
}

export async function closeWarehouseCleanupQueue() {
  if (warehouseCleanupQueue) {
    await warehouseCleanupQueue.close();
    warehouseCleanupQueue = null;
  }
}
