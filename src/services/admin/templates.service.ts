import prisma from '../../lib/prisma';
import { templateLayoutSchema, type TemplateFormInput, type CreateTemplateInput, type UpdateTemplateMetadataInput } from '../../schemas/admin.schema';
import { canonicalizeTemplateForms } from '../../lib/personalization-answers';
import { normalizeCanvasConfig } from '../../types/template-layout';
import { buildDeletedFieldKeySet, buildFieldRenameMap, migrateLayoutFieldKeys, removeDeletedFieldLayers } from './template-field-key-migration';
import { assertTemplateVersion, templateVersionToken } from './template-version';
import { ConflictError, NotFoundError } from '../../lib/errors';
import { formatTagLabel, normalizeTags } from '../../lib/template-tags';
import { deleteTemplateThumbnail, scheduleTemplateThumbnail } from './template-thumbnail.service';

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
      tags: true,
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
          shopProductMappings: { where: { isActive: true } },
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
      tags: template.tags ?? [],
      thumbnailUrl: template.thumbnailUrl,
      layout: summarizeTemplateLayout(template.layoutJson),
      fieldCount: fields.length,
      individualFieldCount: fields.filter((field) => field.scope === 'INDIVIDUAL').length,
      productCount: template._count.personalizedProducts,
      mappingCount: template._count.shopProductMappings,
      createdAt: template.createdAt,
    };
  });
}

export async function getTemplateForm(templateId: string) {
  const [forms, template] = await Promise.all([
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
      select: { updatedAt: true },
    }),
  ]);

  return {
    forms: canonicalizeTemplateForms(forms),
    // Ten sam znacznik co przy layoucie - zapis formularza tez dotyka szablonu.
    version: template ? templateVersionToken(template.updatedAt) : undefined,
  };
}

export async function replaceTemplateForm(
  templateId: string,
  input: TemplateFormInput,
  expectedVersion?: string
) {
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
      select: { layoutJson: true, updatedAt: true },
    }),
  ]);

  if (!existingTemplate) {
    throw new NotFoundError('Szablon nie znaleziony');
  }

  assertTemplateVersion(existingTemplate.updatedAt, expectedVersion);

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
              repeaterGroupKey: null,
              sortOrder: f.sortOrder ?? 0,
              validationRulesJson: f.validationRulesJson ?? null,
            })),
          },
        },
      });
    }

    // Szablon dotykamy ZAWSZE, nie tylko przy zmianie layoutu: `updatedAt`
    // jest znacznikiem wersji dla obu sciezek zapisu, wiec po zmianie samych
    // pol formularza tez musi drgnac - inaczej kontrola konfliktu przepuscilaby
    // nadpisanie z nieswiezej karty.
    await tx.personalizationTemplate.update({
      where: { id: templateId },
      data: {
        ...(changedLayout ? { layoutJson: changedLayout as any } : {}),
        updatedAt: new Date(),
      },
    });
  });

  return getTemplateForm(templateId);
}

/**
 * Kopia szablonu razem z layoutem i formularzem.
 *
 * Chrzest, komunia i urodziny to ten sam uklad z inna trescia - bez kopiowania
 * kazdy projekt trzeba bylo skladac od zera. Assety zostaja przy oryginale:
 * kopia wskazuje te same pliki w storage, wiec usuniecie kopii nie zabiera
 * tla oryginalowi.
 */
export async function duplicateTemplate(templateId: string, input: { code: string; name: string }) {
  const source = await prisma.personalizationTemplate.findUnique({
    where: { id: templateId },
    include: {
      forms: {
        orderBy: { sortOrder: 'asc' },
        include: { fields: { orderBy: { sortOrder: 'asc' } } },
      },
    },
  });

  if (!source) {
    throw new NotFoundError('Szablon nie znaleziony');
  }

  const existing = await prisma.personalizationTemplate.findFirst({
    where: { code: input.code },
  });
  if (existing) {
    throw new ConflictError(`Szablon o kodzie "${input.code}" już istnieje`);
  }

  const duplicate = await prisma.personalizationTemplate.create({
    data: {
      code: input.code,
      name: input.name,
      description: source.description,
      // Kopia zaczyna od wersji 1 - numer wersji sluzy do zamrazania spraw
      // przy oryginale i nie ma sensu go dziedziczyc.
      version: 1,
      editorType: source.editorType,
      isActive: source.isActive,
      layoutJson: (source.layoutJson ?? undefined) as any,
      // Kopia dostaje wlasna miniature (nizej, w tle) - dziedziczenie sciezki
      // po oryginale wiazaloby dwa szablony z jednym plikiem, a ten znika przy
      // kolejnym zapisie projektu oryginalu.
      thumbnailUrl: null,
      forms: {
        create: source.forms.map((form) => ({
          name: form.name,
          sortOrder: form.sortOrder,
          isActive: form.isActive,
          fields: {
            create: form.fields.map((field) => ({
              key: field.key,
              label: field.label,
              type: field.type,
              scope: field.scope,
              required: field.required,
              minLength: field.minLength,
              maxLength: field.maxLength,
              pattern: field.pattern,
              placeholder: field.placeholder,
              helpText: field.helpText,
              defaultValue: field.defaultValue,
              optionsJson: field.optionsJson ?? undefined,
              repeaterGroupKey: field.repeaterGroupKey,
              sortOrder: field.sortOrder,
              validationRulesJson: field.validationRulesJson ?? undefined,
            })),
          },
        })),
      },
    } as any,
    select: {
      id: true,
      code: true,
      name: true,
      version: true,
      editorType: true,
      isActive: true,
      createdAt: true,
    },
  });

  scheduleTemplateThumbnail(duplicate.id);

  return duplicate;
}

export async function createTemplate(input: CreateTemplateInput) {
  // Check if code already exists (within same tenant - middleware will filter)
  const existing = await prisma.personalizationTemplate.findFirst({
    where: { code: input.code },
  });

  if (existing) {
    throw new Error(`Szablon o kodzie "${input.code}" już istnieje`);
  }

  const layoutJson = input.layout !== undefined
    ? normalizeCreateTemplateLayout(input.layout)
    : undefined;

  const template = await prisma.personalizationTemplate.create({
    data: {
      code: input.code,
      name: input.name,
      description: input.description ?? null,
      version: input.version,
      editorType: input.editorType,
      isActive: input.isActive,
      tags: normalizeTags(input.tags),
      ...(layoutJson ? { layoutJson: layoutJson as any } : {}),
      // tenantId will be added automatically by Prisma middleware
    } as any,
    select: { id: true, name: true, code: true, description: true, version: true, editorType: true, isActive: true, tags: true, createdAt: true },
  });

  return template;
}

function normalizeCreateTemplateLayout(layout: unknown) {
  const parsed = templateLayoutSchema.safeParse(layout);
  if (!parsed.success) {
    throw new Error(`Nieprawidłowy layout startowy: ${parsed.error.errors[0]?.message ?? 'walidacja nie powiodła się'}`);
  }

  return {
    ...parsed.data,
    canvas: normalizeCanvasConfig(parsed.data.canvas as any),
  };
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
      // Brak pola = „nie ruszaj”; pusta tablica = swiadome skasowanie.
      ...(input.tags !== undefined && { tags: normalizeTags(input.tags) }),
    },
    select: { id: true, name: true, code: true, description: true, version: true, editorType: true, isActive: true, tags: true, createdAt: true },
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

  const template = await prisma.personalizationTemplate.findUnique({
    where: { id: templateId },
    select: { thumbnailUrl: true },
  });

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

  await deleteTemplateThumbnail(template?.thumbnailUrl);

  return { success: true };
}

function toPositiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function summarizeTemplateLayout(layoutJson: unknown) {
  if (!layoutJson || typeof layoutJson !== 'object') return null;

  const canvas = (layoutJson as any).canvas;
  if (!canvas || typeof canvas !== 'object') return null;

  const normalizedCanvas = normalizeCanvasConfig(canvas);
  const widthMm = toPositiveNumber(normalizedCanvas.widthMm);
  const heightMm = toPositiveNumber(normalizedCanvas.heightMm);
  const dpi = toPositiveNumber(normalizedCanvas.dpi);
  const width = toPositiveNumber(normalizedCanvas.width);
  const height = toPositiveNumber(normalizedCanvas.height);

  return {
    widthMm,
    heightMm,
    dpi,
    width,
    height,
    formatPreset: typeof normalizedCanvas.formatPreset === 'string' ? normalizedCanvas.formatPreset : null,
  };
}

/**
 * Tagi uzywane w bibliotece wraz z liczba szablonow.
 *
 * Zasila i podpowiedzi przy edycji szablonu, i chipy filtrujace nad lista.
 * Sortowanie po liczbie uzyc, nie alfabetycznie: sprzedawca czesciej siega
 * po „slub” niz po tag, ktory wpisal raz i zapomnial.
 */
export async function listTemplateTags() {
  const templates = await prisma.personalizationTemplate.findMany({
    select: { tags: true },
  });

  const counts = new Map<string, number>();
  for (const template of templates) {
    for (const tag of template.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, label: formatTagLabel(tag), count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'pl'));
}
