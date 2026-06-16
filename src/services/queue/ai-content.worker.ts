import { Worker, Job, UnrecoverableError } from 'bullmq';
import prisma from '../../lib/prisma';
import { AI_CONTENT_QUEUE_NAME, type AiContentJobData } from './ai-content.queue';
import { getBullMqConnection } from './render.queue';
import { generateWarehouseProductContentProposalForTenant, type AiContentProposalInput } from '../admin/ai-content-proposals.service';
import { recalculateAiBulkContentJobCounts } from '../admin/ai-bulk-content-jobs.service';

let aiContentWorker: Worker<AiContentJobData> | null = null;

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function buildInput(job: any, item: any, snapshotPayload: unknown): AiContentProposalInput {
  const snapshot = asRecord(snapshotPayload);
  const identity = asRecord(snapshot.identity);
  const content = asRecord(snapshot.content);
  const seo = asRecord(snapshot.seo);
  const media = asRecord(snapshot.media);
  const images = Array.isArray(media.images) ? media.images : [];
  const image = images.find((entry: any) => entry?.cover) ?? images[0] ?? null;

  return {
    shopId: job.shopId,
    templateId: job.templateId,
    action: job.action,
    imageUrl: job.includeImages ? image?.url ?? null : null,
    current: {
      name: identity.name ?? item.product?.name ?? '',
      shortDescriptionHtml: content.shortDescriptionHtml ?? item.product?.description ?? '',
      longDescriptionHtml: content.longDescriptionHtml ?? '',
      metaTitle: seo.metaTitle ?? '',
      metaDescription: seo.metaDescription ?? '',
      linkRewrite: seo.linkRewrite ?? '',
    },
    categories: Array.isArray(snapshot.categories) ? snapshot.categories : [],
    features: Array.isArray(snapshot.features)
      ? snapshot.features.map((feature: any) => ({ name: feature.name, value: feature.value }))
      : [],
  };
}

async function processAiContentJob(queueJob: Job<AiContentJobData>) {
  const item = await prisma.aiBulkContentJobItem.findFirst({
    where: { id: queueJob.data.itemId, tenantId: queueJob.data.tenantId },
    include: {
      job: true,
      product: true,
    },
  });

  if (!item) throw new UnrecoverableError(`AI bulk job item not found: ${queueJob.data.itemId}`);
  if (!item.job) throw new UnrecoverableError(`AI bulk job not found: ${queueJob.data.jobId}`);
  const snapshot = item.job.shopId
    ? await prisma.productChannelSnapshot.findUnique({
      where: { warehouseProductId_shopId: { warehouseProductId: item.warehouseProductId, shopId: item.job.shopId } },
      select: { payloadJson: true },
    })
    : await prisma.productChannelSnapshot.findFirst({
      where: { warehouseProductId: item.warehouseProductId, tenantId: item.tenantId },
      orderBy: { fetchedAt: 'desc' },
      select: { payloadJson: true },
    });

  await prisma.aiBulkContentJobItem.update({
    where: { id: item.id },
    data: {
      status: 'PROCESSING',
      attemptCount: { increment: 1 },
      startedAt: new Date(),
      errorMessage: null,
    },
  });
  await recalculateAiBulkContentJobCounts(item.jobId);

  try {
    const proposal = await generateWarehouseProductContentProposalForTenant(
      item.warehouseProductId,
      buildInput(item.job, item, snapshot?.payloadJson),
      {
        tenantId: item.tenantId,
        userId: item.job.userId,
        source: 'BULK',
        bulkJobId: item.jobId,
        bulkJobItemId: item.id,
      },
    );

    await prisma.aiBulkContentJobItem.update({
      where: { id: item.id },
      data: {
        status: 'APPROVAL',
        provider: proposal.provider,
        model: proposal.model,
        usedImage: proposal.usedImage,
        proposalJson: proposal as any,
        completedAt: new Date(),
        errorMessage: null,
      },
    });
    return recalculateAiBulkContentJobCounts(item.jobId);
  } catch (error) {
    await prisma.aiBulkContentJobItem.update({
      where: { id: item.id },
      data: {
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Nie udało się wygenerować propozycji AI',
        completedAt: new Date(),
      },
    });
    await recalculateAiBulkContentJobCounts(item.jobId);
    throw error;
  }
}

export function startAiContentWorker() {
  if (aiContentWorker) return aiContentWorker;

  aiContentWorker = new Worker<AiContentJobData>(AI_CONTENT_QUEUE_NAME, processAiContentJob, {
    connection: getBullMqConnection(),
    concurrency: 2,
  });

  aiContentWorker.on('failed', (job, error) => {
    console.error('[AiContentWorker] failed', job?.id, error);
  });

  return aiContentWorker;
}

export async function stopAiContentWorker() {
  if (aiContentWorker) {
    await aiContentWorker.close();
    aiContentWorker = null;
  }
}
