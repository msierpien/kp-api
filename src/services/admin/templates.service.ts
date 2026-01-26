import prisma from '../../lib/prisma';
import type { TemplateFormInput, CreateTemplateInput, UpdateTemplateMetadataInput } from '../../schemas/admin.schema';

export async function listTemplates() {
  return prisma.personalizationTemplate.findMany({
    select: { id: true, name: true, code: true, description: true, version: true, isActive: true, createdAt: true },
    orderBy: { name: 'asc' },
  });
}

export async function getTemplateForm(templateId: string) {
  const forms = await prisma.form.findMany({
    where: { templateId },
    orderBy: { sortOrder: 'asc' },
    include: {
      fields: {
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  return { forms };
}

export async function replaceTemplateForm(templateId: string, input: TemplateFormInput) {
  // replace all forms/fields for this template
  await prisma.$transaction(async (tx) => {
    await tx.formField.deleteMany({
      where: { form: { templateId } },
    });
    await tx.form.deleteMany({
      where: { templateId },
    });

    for (const form of input.forms) {
      await tx.form.create({
        data: {
          templateId,
          name: form.name,
          sortOrder: form.sortOrder,
          isActive: form.isActive,
          fields: {
            create: form.fields.map((f) => ({
              key: f.key,
              label: f.label,
              type: f.type,
              required: f.required,
              minLength: f.minLength ?? null,
              maxLength: f.maxLength ?? null,
              pattern: f.pattern ?? null,
              placeholder: f.placeholder ?? null,
              helpText: f.helpText ?? null,
              defaultValue: f.defaultValue ?? null,
              optionsJson: f.optionsJson ?? null,
              repeaterGroupKey: f.repeaterGroupKey ?? null,
              sortOrder: f.sortOrder ?? 0,
              validationRulesJson: f.validationRulesJson ?? null,
            })),
          },
        },
      });
    }
  });

  return getTemplateForm(templateId);
}

export async function createTemplate(input: CreateTemplateInput) {
  // Check if code already exists
  const existing = await prisma.personalizationTemplate.findUnique({
    where: { code: input.code },
  });

  if (existing) {
    throw new Error(`Szablon o kodzie "${input.code}" już istnieje`);
  }

  const template = await prisma.personalizationTemplate.create({
    data: {
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      version: input.version,
      isActive: input.isActive,
    },
    select: { id: true, name: true, code: true, description: true, version: true, isActive: true, createdAt: true },
  });

  return template;
}

export async function updateTemplateMetadata(templateId: string, input: UpdateTemplateMetadataInput) {
  // If updating code, check uniqueness
  if (input.code) {
    const existing = await prisma.personalizationTemplate.findFirst({
      where: { code: input.code, id: { not: templateId } },
    });

    if (existing) {
      throw new Error(`Szablon o kodzie "${input.code}" już istnieje`);
    }
  }

  const template = await prisma.personalizationTemplate.update({
    where: { id: templateId },
    data: {
      ...(input.code && { code: input.code }),
      ...(input.name && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.version && { version: input.version }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
    select: { id: true, name: true, code: true, description: true, version: true, isActive: true, createdAt: true },
  });

  return template;
}

export async function deleteTemplate(templateId: string) {
  // Check if template is used by any personalized products
  const usageCount = await prisma.personalizedProduct.count({
    where: { templateId },
  });

  if (usageCount > 0) {
    throw new Error(`Nie można usunąć szablonu. Jest używany przez ${usageCount} produktów personalizowanych.`);
  }

  // Delete forms and fields first (cascade)
  await prisma.$transaction(async (tx) => {
    await tx.formField.deleteMany({
      where: { form: { templateId } },
    });
    await tx.form.deleteMany({
      where: { templateId },
    });
    await tx.personalizationTemplate.delete({
      where: { id: templateId },
    });
  });

  return { success: true };
}
