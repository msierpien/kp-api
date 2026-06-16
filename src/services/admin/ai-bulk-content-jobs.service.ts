import prisma from '../../lib/prisma';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import type { AiContentProposalInput } from './ai-content-proposals.service';
import { addAiContentJob } from '../queue/ai-content.queue';

export type AiBulkContentJobInput = {
  productIds: string[];
  shopId?: string | null;
  action: AiContentProposalInput['action'];
  templateId?: string | null;
  includeImages?: boolean;
};

function requireTenantId() {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;
  if (!tenantId) throw new Error('Tenant context is required for AI bulk content jobs');
  return tenantId;
}

function getUserId() {
  return getTenantContext()?.userId || null;
}

async function recalculateJobCounts(jobId: string) {
  const items = await prisma.aiBulkContentJobItem.groupBy({
    by: ['status'],
    where: { jobId },
    _count: { _all: true },
  });
  const count = (status: string) => items.find((item) => item.status === status)?._count._all ?? 0;
  const pendingCount = count('PENDING');
  const processingCount = count('PROCESSING');
  const approvalCount = count('APPROVAL');
  const appliedCount = count('APPLIED');
  const failedCount = count('FAILED');
  const completed = pendingCount === 0 && processingCount === 0;

  return prisma.aiBulkContentJob.update({
    where: { id: jobId },
    data: {
      pendingCount,
      processingCount,
      approvalCount,
      appliedCount,
      failedCount,
      status: completed ? (failedCount > 0 && approvalCount === 0 && appliedCount === 0 ? 'FAILED' : 'APPROVAL') : 'PROCESSING',
      completedAt: completed ? new Date() : null,
    },
    include: { items: { orderBy: { createdAt: 'asc' } } },
  });
}

function toResponse(job: any) {
  return {
    id: job.id,
    tenantId: job.tenantId,
    userId: job.userId,
    shopId: job.shopId,
    status: job.status,
    action: job.action,
    templateId: job.templateId,
    includeImages: job.includeImages,
    requestedCount: job.requestedCount,
    pendingCount: job.pendingCount,
    processingCount: job.processingCount,
    approvalCount: job.approvalCount,
    appliedCount: job.appliedCount,
    failedCount: job.failedCount,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    items: (job.items ?? []).map((item: any) => ({
      id: item.id,
      productId: item.warehouseProductId,
      productName: item.product?.name ?? null,
      sku: item.product?.sku ?? null,
      status: item.status,
      attemptCount: item.attemptCount,
      provider: item.provider,
      model: item.model,
      usedImage: item.usedImage,
      proposal: item.proposalJson,
      errorMessage: item.errorMessage,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
  };
}

export async function createAiBulkContentJob(input: AiBulkContentJobInput) {
  const tenantId = requireTenantId();
  const userId = getUserId();
  const productIds = Array.from(new Set(input.productIds.filter(Boolean)));

  if (productIds.length === 0) throw new Error('Wybierz co najmniej jeden produkt');

  const settings = await prisma.aiSettings.findUnique({ where: { tenantId } });
  if (!settings) throw new Error('Brak konfiguracji AI');
  if (productIds.length > (settings.maxBatchSize ?? 20)) {
    throw new Error(`Maksymalna paczka AI to ${settings.maxBatchSize ?? 20} produktow`);
  }

  const products = await prisma.warehouseProduct.findMany({
    where: { tenantId, id: { in: productIds } },
    select: { id: true },
  });
  if (products.length !== productIds.length) throw new Error('Czesc produktow nie istnieje w tym tenancie');

  const job = await prisma.aiBulkContentJob.create({
    data: {
      tenantId,
      userId,
      shopId: input.shopId ?? null,
      status: 'PENDING',
      action: input.action,
      templateId: input.templateId ?? null,
      includeImages: input.includeImages ?? true,
      requestedCount: productIds.length,
      pendingCount: productIds.length,
      items: {
        create: productIds.map((warehouseProductId) => ({
          tenantId,
          warehouseProductId,
          status: 'PENDING',
        })),
      },
    },
    include: { items: true },
  });

  const queued = [];
  for (const item of job.items) {
    const queuedJob = await addAiContentJob({ jobId: job.id, itemId: item.id, tenantId, userId });
    queued.push(queuedJob.id ? String(queuedJob.id) : null);
  }

  const updated = await prisma.aiBulkContentJob.update({
    where: { id: job.id },
    data: { status: 'PROCESSING', bullmqJobId: queued.filter(Boolean).join(',') || null, startedAt: new Date() },
    include: { items: { include: { product: { select: { name: true, sku: true } } }, orderBy: { createdAt: 'asc' } } },
  });

  return toResponse(updated);
}

export async function listAiBulkContentJobs() {
  const tenantId = requireTenantId();
  const jobs = await prisma.aiBulkContentJob.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    include: { items: { include: { product: { select: { name: true, sku: true } } }, orderBy: { createdAt: 'asc' } } },
  });
  return jobs.map(toResponse);
}

export async function getAiBulkContentJob(id: string) {
  const tenantId = requireTenantId();
  const job = await prisma.aiBulkContentJob.findFirst({
    where: { id, tenantId },
    include: { items: { include: { product: { select: { name: true, sku: true } } }, orderBy: { createdAt: 'asc' } } },
  });
  if (!job) throw new Error('AI bulk job not found');
  return toResponse(job);
}

export async function markAiBulkContentJobItemApplied(itemId: string) {
  const tenantId = requireTenantId();
  const item = await prisma.aiBulkContentJobItem.findFirst({ where: { id: itemId, tenantId } });
  if (!item) throw new Error('AI bulk job item not found');
  await prisma.aiBulkContentJobItem.update({
    where: { id: itemId },
    data: { status: 'APPLIED', completedAt: new Date(), errorMessage: null },
  });
  return toResponse(await recalculateJobCounts(item.jobId));
}

export async function recalculateAiBulkContentJobCounts(jobId: string) {
  return recalculateJobCounts(jobId);
}
