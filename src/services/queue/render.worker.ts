import { Worker, Job } from 'bullmq';
import prisma from '../../lib/prisma';
import { renderPreview, renderPDF } from '../renderer/fabric-renderer.service';
import { validateAnswers } from '../renderer/text-validator.service';
import { saveFile } from '../storage/local-storage.service';
import {
  getRedisConnection,
  RENDER_QUEUE_NAME,
  RenderJobData,
  RenderJobResult,
} from './render.queue';

let workerInstance: Worker<RenderJobData, RenderJobResult> | null = null;

/**
 * Przetwarza job renderowania
 */
async function processRenderJob(
  job: Job<RenderJobData, RenderJobResult>
): Promise<RenderJobResult> {
  const { caseId, jobType, answers, templateName, templateVersion, orderId, renderOptions, layoutConfig, layoutOverrides } = job.data;

  console.log(`[RenderWorker] Processing job ${job.id}, type: ${jobType}, case: ${caseId}`);

  try {
    // Update progress
    await job.updateProgress(10);

    const activeRenderJob = await prisma.renderJob.findFirst({
      where: { caseId, jobType },
      orderBy: { createdAt: 'desc' },
    });

    if (activeRenderJob) {
      await prisma.renderJob.update({
        where: { id: activeRenderJob.id },
        data: {
          status: 'PROCESSING',
          startedAt: new Date(),
          metadata: {
            ...(activeRenderJob.metadata as object || {}),
            bullmqJobId: job.id,
          },
        },
      });
    }

    // Pobierz case z bazy
    const personalizationCase = await prisma.personalizationCase.findUnique({
      where: { id: caseId },
      include: {
        orderItem: {
          include: {
            personalizedProduct: {
              include: {
                template: {
                  include: {
                    forms: {
                      include: {
                        fields: { orderBy: { sortOrder: 'asc' } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!personalizationCase) {
      throw new Error(`Case not found: ${caseId}`);
    }

    await job.updateProgress(20);

    // Pobierz pola formularza do walidacji
    const formFields = personalizationCase.orderItem?.personalizedProduct?.template?.forms
      ?.flatMap(form => form.fields) || [];

    // Walidacja odpowiedzi
    const validationResult = await validateAnswers(answers, formFields.map(f => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: f.required,
      maxLength: f.maxLength || undefined,
      minLength: f.minLength || undefined,
      pattern: f.pattern || undefined,
    })));

    await job.updateProgress(30);

    // Dla preview - kontynuuj nawet z ostrzeżeniami (ale nie z błędami krytycznymi dla final)
    if (jobType === 'PDF_PRINT' && !validationResult.isValid) {
      // Zaktualizuj case status na FAILED_RENDER
      await prisma.personalizationCase.update({
        where: { id: caseId },
        data: {
          status: 'FAILED_RENDER',
          validationSummary: JSON.parse(JSON.stringify(validationResult)),
        },
      });

      return {
        success: false,
        error: 'Validation failed for final PDF',
        validationSummary: validationResult,
      };
    }

    await job.updateProgress(40);

    // Przygotuj dane dla renderera
    const templateData = {
      answers,
      templateName: templateName || 'default',
      layoutConfig: layoutConfig || undefined,
      layoutOverrides: layoutOverrides || undefined,
      watermark: jobType === 'PNG_PREVIEW' ? {
        text: 'PODGLĄD',
        opacity: 0.15,
        angle: -30,
        fontSize: 72,
      } : undefined,
    };

    let buffer: Buffer;
    let extension: string;
    let mimeType: string;
    let assetType: 'PNG_PREVIEW' | 'PDF_PRINT';

    // Renderuj
    if (jobType === 'PNG_PREVIEW') {
      console.log(`[RenderWorker] Rendering PNG preview for case ${caseId}`);
      
      if (!templateData.layoutConfig) {
        throw new Error('Layout config is required for rendering');
      }
      
      buffer = await renderPreview(templateData as any, {
        width: renderOptions?.width || 800,
        height: renderOptions?.height || 600,
        scale: renderOptions?.scale || 1,
        includeWatermark: true,
      });
      extension = 'png';
      mimeType = 'image/png';
      assetType = 'PNG_PREVIEW';
    } else {
      console.log(`[RenderWorker] Rendering PDF for case ${caseId}`);
      buffer = await renderPDF(templateData, {
        width: renderOptions?.width || 297, // A4 landscape for 2-page spread
        height: renderOptions?.height || 210,
      });
      extension = 'pdf';
      mimeType = 'application/pdf';
      assetType = 'PDF_PRINT';
    }

    await job.updateProgress(70);

    // Zapisz plik
    const savedFile = await saveFile(buffer, {
      orderId,
      templateVersion,
      filename: jobType === 'PNG_PREVIEW' ? `preview-${caseId}` : `final-${caseId}`,
      extension,
    });

    await job.updateProgress(85);

    // Utwórz Asset w bazie
    const asset = await prisma.asset.create({
      data: {
        caseId,
        assetType,
        filePath: savedFile.relativePath,
        fileSize: savedFile.size,
        mimeType,
        metadata: {
          jobId: job.id,
          generatedAt: new Date().toISOString(),
          templateName,
          templateVersion,
        },
      },
    });

    // Zaktualizuj case
    const newStatus = jobType === 'PNG_PREVIEW' ? 'PREVIEW_READY' : 'RENDERED';

    await prisma.personalizationCase.update({
      where: { id: caseId },
      data: {
        status: newStatus,
        validationSummary: JSON.parse(JSON.stringify(validationResult)),
        ...(jobType === 'PDF_PRINT' && { submittedAt: new Date() }),
      },
    });

    // Zaktualizuj RenderJob w bazie (jeśli istnieje)
    const existingRenderJob = await prisma.renderJob.findFirst({
      where: { caseId, jobType },
      orderBy: { createdAt: 'desc' },
    });

    if (existingRenderJob) {
      await prisma.renderJob.update({
        where: { id: existingRenderJob.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          metadata: {
            ...(existingRenderJob.metadata as object || {}),
            bullmqJobId: job.id,
            assetId: asset.id,
          },
        },
      });
    }

    await job.updateProgress(100);

    console.log(`[RenderWorker] Job ${job.id} completed successfully, asset: ${asset.id}`);

    return {
      success: true,
      assetId: asset.id,
      filePath: savedFile.relativePath,
      fileUrl: savedFile.url,
      fileSize: savedFile.size,
      validationSummary: validationResult,
    };
  } catch (error) {
    console.error(`[RenderWorker] Job ${job.id} failed:`, error);

    // Enhanced error tracking
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    // Store error details in job data for later inspection
    try {
      await job.updateData({
        ...job.data,
        lastError: {
          message: errorMessage,
          stack: errorStack,
          timestamp: new Date().toISOString(),
          attemptNumber: job.attemptsMade + 1,
          caseId,
        },
      });
    } catch (updateError) {
      console.error('[RenderWorker] Failed to update job data with error:', updateError);
    }

    // Zaktualizuj case status na FAILED_RENDER (tylko jeśli to final PDF i ostatnia próba)
    if (jobType === 'PDF_PRINT' && job.attemptsMade >= (job.opts.attempts || 3) - 1) {
      await prisma.personalizationCase.update({
        where: { id: caseId },
        data: { status: 'FAILED_RENDER' },
      });
    }

    const failedRenderJob = await prisma.renderJob.findFirst({
      where: { caseId, jobType },
      orderBy: { createdAt: 'desc' },
    });

    if (failedRenderJob) {
      await prisma.renderJob.update({
        where: { id: failedRenderJob.id },
        data: {
          status: 'FAILED',
          error: errorMessage,
          completedAt: new Date(),
          metadata: {
            ...(failedRenderJob.metadata as object || {}),
            bullmqJobId: job.id,
            lastError: {
              message: errorMessage,
              timestamp: new Date().toISOString(),
            },
          },
        },
      });
    }

    throw error; // Re-throw aby BullMQ zarejestrował błąd
  }
}

/**
 * Uruchamia workera
 */
export function startRenderWorker(): Worker<RenderJobData, RenderJobResult> {
  if (workerInstance) {
    console.log('[RenderWorker] Worker already running');
    return workerInstance;
  }

  const connection = getRedisConnection();

  workerInstance = new Worker<RenderJobData, RenderJobResult>(
    RENDER_QUEUE_NAME,
    processRenderJob,
    {
      connection,
      concurrency: 2, // Max 2 równoległe rendery (Chromium jest zasobożerny)
      limiter: {
        max: 10,
        duration: 60000, // Max 10 jobów na minutę
      },
    }
  );

  // Event handlers
  workerInstance.on('completed', (job, result) => {
    console.log(`[RenderWorker] Job ${job.id} completed:`, result.success ? 'success' : 'failed');
  });

  workerInstance.on('failed', (job, error) => {
    console.error(`[RenderWorker] Job ${job?.id} failed:`, error.message);
  });

  workerInstance.on('error', (error) => {
    console.error('[RenderWorker] Worker error:', error);
  });

  workerInstance.on('stalled', (jobId) => {
    console.warn(`[RenderWorker] Job ${jobId} stalled`);
  });

  console.log('[RenderWorker] Worker started');
  return workerInstance;
}

/**
 * Zatrzymuje workera
 */
export async function stopRenderWorker(): Promise<void> {
  if (workerInstance) {
    await workerInstance.close();
    workerInstance = null;
    console.log('[RenderWorker] Worker stopped');
  }
  // Puppeteer removed - no browser to close
}

/**
 * Sprawdza czy worker działa
 */
export function isWorkerRunning(): boolean {
  return workerInstance !== null && workerInstance.isRunning();
}

/**
 * Pobiera informacje o workerze
 */
export function getWorkerInfo(): {
  running: boolean;
  concurrency: number;
} | null {
  if (!workerInstance) return null;

  return {
    running: workerInstance.isRunning(),
    concurrency: workerInstance.opts.concurrency || 1,
  };
}
