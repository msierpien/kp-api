import type { TemplateFormInput } from '../../schemas/admin.schema';

type ExistingTemplateForm = {
  fields: Array<{
    key: string;
    label: string;
    sortOrder: number;
  }>;
};

type NextTemplateField = TemplateFormInput['forms'][number]['fields'][number] & {
  previousKey?: string | null;
};

function normalizeLabel(value: string) {
  return value.trim().toLowerCase();
}

function addRename(renameMap: Map<string, string>, oldKey: string, newKey: string) {
  if (oldKey && newKey && oldKey !== newKey) {
    renameMap.set(oldKey, newKey);
  }
}

export function buildFieldRenameMap(
  existingForms: ExistingTemplateForm[],
  nextForms: TemplateFormInput['forms']
) {
  const renameMap = new Map<string, string>();
  const existingKeys = new Set(existingForms.flatMap((form) => form.fields.map((field) => field.key)));
  const nextKeys = new Set(nextForms.flatMap((form) => form.fields.map((field) => field.key)));
  const consumedExistingKeys = new Set<string>();

  nextForms.forEach((nextForm, formIndex) => {
    const existingForm = existingForms[formIndex];
    if (!existingForm) return;

    nextForm.fields.forEach((rawNextField, fieldIndex) => {
      const nextField = rawNextField as NextTemplateField;
      const explicitPreviousKey = nextField.previousKey?.trim();
      if (
        explicitPreviousKey &&
        existingKeys.has(explicitPreviousKey) &&
        !nextKeys.has(explicitPreviousKey) &&
        !existingKeys.has(nextField.key)
      ) {
        addRename(renameMap, explicitPreviousKey, nextField.key);
        consumedExistingKeys.add(explicitPreviousKey);
        return;
      }

      if (existingKeys.has(nextField.key)) return;

      const nextLabel = normalizeLabel(nextField.label);
      const sameLabelFields = existingForm.fields.filter((field) => normalizeLabel(field.label) === nextLabel);
      const existingByPosition = existingForm.fields[fieldIndex];
      const existingField =
        sameLabelFields.length === 1
          ? sameLabelFields[0]
          : existingByPosition && normalizeLabel(existingByPosition.label) === nextLabel
            ? existingByPosition
            : null;

      if (!existingField || consumedExistingKeys.has(existingField.key) || nextKeys.has(existingField.key)) return;

      addRename(renameMap, existingField.key, nextField.key);
      consumedExistingKeys.add(existingField.key);
    });
  });

  return renameMap;
}

export function buildDeletedFieldKeySet(
  existingForms: ExistingTemplateForm[],
  nextForms: TemplateFormInput['forms'],
  renameMap: Map<string, string>
) {
  const nextKeys = new Set(nextForms.flatMap((form) => form.fields.map((field) => field.key)));
  const renamedKeys = new Set(renameMap.keys());
  const deletedKeys = new Set<string>();

  for (const field of existingForms.flatMap((form) => form.fields)) {
    if (!nextKeys.has(field.key) && !renamedKeys.has(field.key)) {
      deletedKeys.add(field.key);
    }
  }

  return deletedKeys;
}

export function migrateLayoutFieldKeys(layoutJson: unknown, renameMap: Map<string, string>) {
  if (!layoutJson || renameMap.size === 0 || typeof layoutJson !== 'object') return null;

  const layout = layoutJson as any;
  if (!Array.isArray(layout.layers)) return null;

  let changed = false;
  const layers = layout.layers.map((layer: any) => {
    const fieldKey = layer?.properties?.fieldKey;
    if (!fieldKey || !renameMap.has(fieldKey)) return layer;

    changed = true;
    return {
      ...layer,
      properties: {
        ...layer.properties,
        fieldKey: renameMap.get(fieldKey),
      },
    };
  });

  return changed ? { ...layout, layers } : null;
}

export function removeDeletedFieldLayers(layoutJson: unknown, deletedKeys: Set<string>) {
  if (!layoutJson || deletedKeys.size === 0 || typeof layoutJson !== 'object') return null;

  const layout = layoutJson as any;
  if (!Array.isArray(layout.layers)) return null;

  let changed = false;
  const layers = layout.layers.filter((layer: any) => {
    const fieldKey = layer?.properties?.fieldKey;
    const isFieldLayer = layer?.type === 'text' || layer?.type === 'textbox';
    if (isFieldLayer && fieldKey && deletedKeys.has(fieldKey)) {
      changed = true;
      return false;
    }

    return true;
  });

  return changed ? { ...layout, layers } : null;
}
