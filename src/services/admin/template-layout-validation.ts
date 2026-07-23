import type { TemplateLayoutInput } from '../../schemas/admin.schema';

export type TemplateLayoutWarningCode =
  | 'TEXT_LAYER_FIELD_KEY_MISSING'
  | 'TEXT_LAYER_FIELD_KEY_UNMAPPED'
  | 'TEXT_LAYER_FIELD_KEY_DUPLICATED'
  | 'BACKGROUND_LAYER_MISSING';

export type TemplateLayoutWarning = {
  code: TemplateLayoutWarningCode;
  message: string;
  layerId?: string;
  layerName?: string;
  fieldKey?: string;
};

type TemplateFormFieldKeySource = Array<{ fields: Array<{ key: string }> }> | null;

function isFieldMappedTextLayer(layer: TemplateLayoutInput['layers'][number]) {
  return layer.type === 'text' || layer.type === 'textbox';
}

export function validateTemplateLayoutStructure(layout: TemplateLayoutInput) {
  const ids = new Set<string>();
  for (const layer of layout.layers) {
    if (ids.has(layer.id)) {
      throw new Error(`Duplikat id warstwy: ${layer.id}`);
    }
    ids.add(layer.id);
    if (layer.width <= 0 || layer.height <= 0) {
      throw new Error(`Warstwa ${layer.name} ma nieprawidłowe wymiary`);
    }
  }
}

export function collectTemplateLayoutWarnings(
  layout: TemplateLayoutInput,
  forms: TemplateFormFieldKeySource
): TemplateLayoutWarning[] {
  const warnings: TemplateLayoutWarning[] = [];
  const formKeys = new Set(forms?.flatMap((form) => form.fields.map((field) => field.key)) || []);
  const seenKeys = new Set<string>();

  for (const layer of layout.layers) {
    if (!isFieldMappedTextLayer(layer)) continue;

    const fieldKey = (layer.properties as any).fieldKey;
    if (!fieldKey) {
      if (layer.type === 'text') {
        warnings.push({
          code: 'TEXT_LAYER_FIELD_KEY_MISSING',
          message: `Warstwa tekstowa "${layer.name}" nie ma fieldKey.`,
          layerId: layer.id,
          layerName: layer.name,
        });
      }
      continue;
    }

    if (!formKeys.has(fieldKey)) {
      warnings.push({
        code: 'TEXT_LAYER_FIELD_KEY_UNMAPPED',
        message: `fieldKey "${fieldKey}" z warstwy "${layer.name}" nie istnieje w formularzu.`,
        layerId: layer.id,
        layerName: layer.name,
        fieldKey,
      });
      continue;
    }

    if (seenKeys.has(fieldKey)) {
      warnings.push({
        code: 'TEXT_LAYER_FIELD_KEY_DUPLICATED',
        message: `fieldKey "${fieldKey}" jest przypisany do więcej niż jednej warstwy.`,
        layerId: layer.id,
        layerName: layer.name,
        fieldKey,
      });
      continue;
    }

    seenKeys.add(fieldKey);
  }

  if (!layout.layers.some((layer) => layer.type === 'background')) {
    warnings.push({
      code: 'BACKGROUND_LAYER_MISSING',
      message: 'Layout nie ma warstwy tła. Tło jest opcjonalne, ale eksport do druku może wymagać kontroli.',
    });
  }

  return warnings;
}

export function validateTemplateLayout(
  layout: TemplateLayoutInput,
  forms: TemplateFormFieldKeySource
): TemplateLayoutWarning[] {
  validateTemplateLayoutStructure(layout);
  return collectTemplateLayoutWarnings(layout, forms);
}
