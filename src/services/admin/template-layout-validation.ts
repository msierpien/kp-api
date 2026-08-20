import type { TemplateLayoutInput } from '../../schemas/admin.schema';
import {
  validateTemplateVariants,
  type TemplateLayoutJson,
  type TemplateLayoutWarning,
} from '../../types/template-layout';

// Kody i ksztalt ostrzezenia zyja w pakiecie formatu - panel czyta je z tego
// samego zrodla, wiec lokalna kopia rozjezdzalaby sie po kazdym wydaniu.
export type TemplateLayoutWarningCode = TemplateLayoutWarning['code'];
export type { TemplateLayoutWarning };

type TemplateFormFieldKeySource = Array<{ fields: Array<{ key: string }> }> | null;

function isFieldMappedTextLayer(layer: TemplateLayoutInput['layers'][number]) {
  // `text_path` tez wiaze sie z polem formularza - bez tego ostrzezenia
  // o brakujacym, nieistniejacym albo zdublowanym `fieldKey` omijalyby
  // warstwe po luku, choc dotycza jej tak samo.
  return layer.type === 'text' || layer.type === 'textbox' || layer.type === 'text_path';
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
          message: `Warstwa „${layer.name}” nie jest powiązana z żadnym polem formularza — klient nie będzie miał czego w niej wypełnić.`,
          layerId: layer.id,
          layerName: layer.name,
        });
      }
      continue;
    }

    if (!formKeys.has(fieldKey)) {
      warnings.push({
        code: 'TEXT_LAYER_FIELD_KEY_UNMAPPED',
        message: `Warstwa „${layer.name}” wskazuje pole „${fieldKey}”, którego nie ma w formularzu — na wydruku zostanie puste miejsce.`,
        layerId: layer.id,
        layerName: layer.name,
        fieldKey,
      });
      continue;
    }

    if (seenKeys.has(fieldKey)) {
      warnings.push({
        code: 'TEXT_LAYER_FIELD_KEY_DUPLICATED',
        message: `Pole „${fieldKey}” jest przypisane do kilku warstw — ta sama odpowiedź klienta pojawi się w każdej z nich.`,
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
      message: 'Projekt nie ma warstwy tła. To dozwolone, ale przy druku na kolorowym papierze warto sprawdzić, czy tak ma zostać.',
    });
  }

  // Sklad do druku i mockupy sa wspolne dla szablonu i wskazuja strony po id,
  // wiec wariant bez ktorejs strony po cichu wypadlby z wydruku.
  warnings.push(
    ...validateTemplateVariants(layout as unknown as TemplateLayoutJson, Array.from(formKeys))
  );

  return warnings;
}

export function validateTemplateLayout(
  layout: TemplateLayoutInput,
  forms: TemplateFormFieldKeySource
): TemplateLayoutWarning[] {
  validateTemplateLayoutStructure(layout);
  return collectTemplateLayoutWarnings(layout, forms);
}
