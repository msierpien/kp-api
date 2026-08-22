import { Worker, Job } from 'bullmq';
import { WAREHOUSE_CLEANUP_QUEUE_NAME, type WarehouseCleanupJobData } from './warehouse-cleanup.queue';
import { getBullMqConnection } from './render.queue';
import { processCleanupRun } from '../admin/warehouse-product-cleanup.service';

let warehouseCleanupWorker: Worker<WarehouseCleanupJobData> | null = null;

async function processWarehouseCleanupJob(job: Job<WarehouseCleanupJobData>) {
  // tenantId jedzie w danych zadania: w workerze nie ma kontekstu requestu,
  // z ktorego reszta kodu bierze tenanta.
  await processCleanupRun(job.data.runId, job.data.tenantId);
}

export function startWarehouseCleanupWorker() {
  if (warehouseCleanupWorker) return warehouseCleanupWorker;

  warehouseCleanupWorker = new Worker<WarehouseCleanupJobData>(
    WAREHOUSE_CLEANUP_QUEUE_NAME,
    processWarehouseCleanupJob,
    {
      connection: getBullMqConnection(),
      // Jeden przebieg naraz: kazdy i tak wola API sklepu pozycja po pozycji,
      // a rownolegle porzadki na tym samym sklepie tylko by sie biły.
      concurrency: 1,
    },
  );

  warehouseCleanupWorker.on('failed', (job, error) => {
    console.error('[WarehouseCleanupWorker] failed', job?.id, error);
  });

  return warehouseCleanupWorker;
}

export async function stopWarehouseCleanupWorker() {
  if (warehouseCleanupWorker) {
    await warehouseCleanupWorker.close();
    warehouseCleanupWorker = null;
  }
}
