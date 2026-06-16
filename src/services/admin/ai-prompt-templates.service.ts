import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantContext, getTenantId, isSuperAdmin } from '../../lib/tenant-context';
import type { AiPromptTemplateInput, AiPromptTemplateUpdateInput } from '../../schemas/admin.schema';

function requireTenantId() {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;

  if (!tenantId || (isSuperAdmin() && !getTenantContext()?.overrideTenantId && !getTenantContext()?.tenantId)) {
    throw new Error('Tenant context is required for AI prompt templates');
  }

  return tenantId;
}

function toResponse(template: any) {
  return {
    id: template.id,
    tenantId: template.tenantId,
    name: template.name,
    category: template.category,
    productType: template.productType,
    occasionContext: template.occasionContext,
    tone: template.tone,
    brief: template.brief,
    systemPrompt: template.systemPrompt,
    htmlMode: template.htmlMode,
    rulesJson: template.rulesJson,
    isDefault: template.isDefault,
    isActive: template.isActive,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}

async function clearDefaultIfNeeded(tenantId: string, isDefault?: boolean, exceptId?: string) {
  if (!isDefault) return;

  await prisma.aiPromptTemplate.updateMany({
    where: {
      tenantId,
      ...(exceptId ? { id: { not: exceptId } } : {}),
      isDefault: true,
    },
    data: { isDefault: false },
  });
}

export async function listAiPromptTemplates() {
  const tenantId = requireTenantId();
  const templates = await prisma.aiPromptTemplate.findMany({
    where: { tenantId },
    orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
  });

  return templates.map(toResponse);
}

export async function createAiPromptTemplate(input: AiPromptTemplateInput) {
  const tenantId = requireTenantId();
  await clearDefaultIfNeeded(tenantId, input.isDefault);

  const template = await prisma.aiPromptTemplate.create({
    data: {
      tenantId,
      name: input.name,
      category: input.category,
      productType: input.productType ?? null,
      occasionContext: input.occasionContext ?? null,
      tone: input.tone,
      brief: input.brief,
      systemPrompt: input.systemPrompt ?? null,
      htmlMode: input.htmlMode,
      rulesJson: input.rulesJson ?? Prisma.JsonNull,
      isDefault: input.isDefault,
      isActive: input.isActive,
    },
  });

  if (template.isDefault) {
    await prisma.aiSettings.upsert({
      where: { tenantId },
      create: { tenantId, defaultPromptTemplateId: template.id },
      update: { defaultPromptTemplateId: template.id },
    });
  }

  return toResponse(template);
}

export async function updateAiPromptTemplate(id: string, input: AiPromptTemplateUpdateInput) {
  const tenantId = requireTenantId();
  const existing = await prisma.aiPromptTemplate.findFirst({ where: { id, tenantId } });

  if (!existing) {
    throw new Error('AI prompt template not found');
  }

  await clearDefaultIfNeeded(tenantId, input.isDefault, id);

  const template = await prisma.aiPromptTemplate.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.category !== undefined ? { category: input.category } : {}),
      ...(input.productType !== undefined ? { productType: input.productType ?? null } : {}),
      ...(input.occasionContext !== undefined ? { occasionContext: input.occasionContext ?? null } : {}),
      ...(input.tone !== undefined ? { tone: input.tone } : {}),
      ...(input.brief !== undefined ? { brief: input.brief } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt ?? null } : {}),
      ...(input.htmlMode !== undefined ? { htmlMode: input.htmlMode } : {}),
      ...(input.rulesJson !== undefined ? { rulesJson: input.rulesJson ?? Prisma.JsonNull } : {}),
      ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });

  if (template.isDefault) {
    await prisma.aiSettings.upsert({
      where: { tenantId },
      create: { tenantId, defaultPromptTemplateId: template.id },
      update: { defaultPromptTemplateId: template.id },
    });
  }

  return toResponse(template);
}

export async function deleteAiPromptTemplate(id: string) {
  const tenantId = requireTenantId();
  const existing = await prisma.aiPromptTemplate.findFirst({ where: { id, tenantId } });

  if (!existing) {
    throw new Error('AI prompt template not found');
  }

  await prisma.aiPromptTemplate.delete({ where: { id } });

  if (existing.isDefault) {
    await prisma.aiSettings.updateMany({
      where: { tenantId, defaultPromptTemplateId: id },
      data: { defaultPromptTemplateId: null },
    });
  }

  return { success: true };
}
