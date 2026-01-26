import prisma from '../../lib/prisma';
import type { TemplateFormInput } from '../../schemas/admin.schema';

export async function listTemplates() {
  return prisma.personalizationTemplate.findMany({
    select: { id: true, name: true, code: true, version: true, isActive: true },
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
