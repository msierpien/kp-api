import prisma from '../../lib/prisma';
import type { TemplateFormInput, CreateTemplateInput, UpdateTemplateMetadataInput } from '../../schemas/admin.schema';
import { buildDeletedFieldKeySet, buildFieldRenameMap, migrateLayoutFieldKeys, removeDeletedFieldLayers } from './template-field-key-migration';

export async function listTemplates() {
  const templates = await prisma.personalizationTemplate.findMany({
    select: {
      id: true,
      name: true,
      code: true,
      description: true,
      version: true,
      editorType: true,
      isActive: true,
      thumbnailUrl: true,
      layoutJson: true,
      createdAt: true,
      forms: {
        select: {
          fields: {
            select: {
              scope: true,
            },
          },
        },
      },
      _count: {
        select: {
          personalizedProducts: true,
        },
      },
    },
    orderBy: { name: 'asc' },
  });

  return templates.map((template) => {
    const fields = template.forms.flatMap((form) => form.fields);

    return {
      id: template.id,
      name: template.name,
      code: template.code,
      description: template.description,
      version: template.version,
      editorType: template.editorType,
      isActive: template.isActive,
      thumbnailUrl: template.thumbnailUrl,
      layout: summarizeTemplateLayout(template.layoutJson),
      fieldCount: fields.length,
      individualFieldCount: fields.filter((field) => field.scope === 'INDIVIDUAL').length,
      productCount: template._count.personalizedProducts,
      createdAt: template.createdAt,
    };
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
  const [existingForms, existingTemplate] = await Promise.all([
    prisma.form.findMany({
      where: { templateId },
      orderBy: { sortOrder: 'asc' },
      include: {
        fields: {
          orderBy: { sortOrder: 'asc' },
        },
      },
    }),
    prisma.personalizationTemplate.findUnique({
      where: { id: templateId },
      select: { layoutJson: true },
    }),
  ]);

  const renameMap = buildFieldRenameMap(existingForms, input.forms);
  const deletedKeys = buildDeletedFieldKeySet(existingForms, input.forms, renameMap);
  const migratedLayout = migrateLayoutFieldKeys(existingTemplate?.layoutJson, renameMap);
  const layoutAfterRename = migratedLayout ?? existingTemplate?.layoutJson;
  const prunedLayout = removeDeletedFieldLayers(layoutAfterRename, deletedKeys);
  const changedLayout = prunedLayout ?? migratedLayout;

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
              scope: f.scope ?? (f.repeaterGroupKey ? 'INDIVIDUAL' : 'SHARED'),
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

    if (changedLayout) {
      await tx.personalizationTemplate.update({
        where: { id: templateId },
        data: {
          layoutJson: changedLayout as any,
        },
      });
    }
  });

  return getTemplateForm(templateId);
}

export async function createTemplate(input: CreateTemplateInput) {
  // Check if code already exists (within same tenant - middleware will filter)
  const existing = await prisma.personalizationTemplate.findFirst({
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
      editorType: input.editorType,
      isActive: input.isActive,
      // tenantId will be added automatically by Prisma middleware
    } as any,
    select: { id: true, name: true, code: true, description: true, version: true, editorType: true, isActive: true, createdAt: true },
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
      ...(input.editorType && { editorType: input.editorType }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    },
    select: { id: true, name: true, code: true, description: true, version: true, editorType: true, isActive: true, createdAt: true },
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

function toPositiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function summarizeTemplateLayout(layoutJson: unknown) {
  if (!layoutJson || typeof layoutJson !== 'object') return null;

  const canvas = (layoutJson as any).canvas;
  if (!canvas || typeof canvas !== 'object') return null;

  const widthMm = toPositiveNumber(canvas.widthMm);
  const heightMm = toPositiveNumber(canvas.heightMm);
  const dpi = toPositiveNumber(canvas.dpi);
  const width = toPositiveNumber(canvas.width);
  const height = toPositiveNumber(canvas.height);

  return {
    widthMm,
    heightMm,
    dpi,
    width,
    height,
    formatPreset: typeof canvas.formatPreset === 'string' ? canvas.formatPreset : null,
  };
}
