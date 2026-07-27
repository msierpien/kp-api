import {
  getFieldScope,
  type PersonalizationAnswerField,
  type StructuredCaseAnswers,
} from '../../lib/personalization-answers';
import { mergeLayoutWithOverrides } from '../../lib/layout-overrides';
import { getTemplatePages, type Layer, type TemplateLayoutJson } from '../../types/template-layout';
import { validateAnswers } from './text-validator.service';

export type FieldValidationConfig = PersonalizationAnswerField & {
  label: string;
  type: string;
  maxLength?: number | null;
  minLength?: number | null;
  pattern?: string | null;
};

export interface PrintPackageFieldIssue {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  itemIndex?: number;
  details?: Record<string, any>;
}

export interface PrintPackageItemValidation {
  itemIndex: number;
  isValid: boolean;
  errors: PrintPackageFieldIssue[];
  warnings: PrintPackageFieldIssue[];
}

export interface PrintPackageValidationSummary {
  isValid: boolean;
  shared: {
    isValid: boolean;
    errors: PrintPackageFieldIssue[];
    warnings: PrintPackageFieldIssue[];
  };
  items: PrintPackageItemValidation[];
  errors: PrintPackageFieldIssue[];
  warnings: PrintPackageFieldIssue[];
}

function getCanvasDpi(layout: TemplateLayoutJson) {
  return Math.max(1, Number(layout.canvas?.dpi || 300));
}

function getLayerFieldKey(layer: Layer): string | null {
  if (layer.type !== 'text' && layer.type !== 'textbox') return null;
  const fieldKey = (layer.properties as any)?.fieldKey;
  return typeof fieldKey === 'string' && fieldKey.trim() ? fieldKey : null;
}

function fontSizeToValidatorPx(fontSize: number, fontUnit: unknown, dpi: number) {
  if (fontUnit === 'px') return fontSize;
  return (fontSize / 72) * dpi;
}

/**
 * Zbiera warstwy ze WSZYSTKICH stron projektu z nalozonymi nadpisaniami
 * klienta.
 *
 * Dwie rzeczy, ktorych brak sprawial, ze walidacja mierzyla co innego niz
 * druk: `layout.layers` to tylko lustro pierwszej strony (pole z tylu winietki
 * nie bylo w ogole sprawdzane), a geometria i `fontSize` szly wprost
 * z szablonu - a klient mogl juz zmniejszyc czcionke albo poszerzyc ramke.
 */
function collectLayersForItem(
  layout: TemplateLayoutJson,
  layoutOverrides: unknown,
  itemIndex?: number
): Layer[] {
  const pages = getTemplatePages(layout);

  return pages.flatMap((page) => {
    const pageLayout: TemplateLayoutJson = {
      ...layout,
      canvas: page.canvas || layout.canvas,
      layers: page.layers,
    };
    return mergeLayoutWithOverrides(pageLayout, layoutOverrides, itemIndex, page.id).layers;
  });
}

/**
 * Dokleja do konfiguracji pol geometrie warstwy, w ktorej pole sie renderuje
 * (szerokosc ramki, rozmiar pisma, liczba linii) - bez tego walidator nie ma
 * czego porownac i sprawdza wylacznie dlugosc w znakach.
 */
export function buildValidationFields(
  fields: FieldValidationConfig[],
  layout: TemplateLayoutJson,
  layoutOverrides?: unknown,
  itemIndex?: number
) {
  const dpi = getCanvasDpi(layout);
  const layerByFieldKey = new Map<string, Layer>();

  for (const layer of collectLayersForItem(layout, layoutOverrides, itemIndex)) {
    if (layer.visible === false) continue;
    const fieldKey = getLayerFieldKey(layer);
    if (fieldKey && !layerByFieldKey.has(fieldKey)) {
      layerByFieldKey.set(fieldKey, layer);
    }
  }

  return fields.map((field) => {
    const layer = layerByFieldKey.get(field.key);
    const props = layer?.properties as any;
    const fontSize = typeof props?.fontSize === 'number'
      ? fontSizeToValidatorPx(props.fontSize, props.fontUnit, dpi)
      : undefined;
    const horizontalPadding = layer?.type === 'textbox' ? Number(props?.padding || 0) * 2 : 0;
    const width = layer ? Math.max(1, Number(layer.width || 0) - horizontalPadding) : undefined;
    const lineHeight = Number(props?.lineHeight || 1.2);
    const maxLines = typeof props?.maxLines === 'number'
      ? props.maxLines
      : layer && fontSize
        ? Math.max(1, Math.floor(Number(layer.height || 0) / Math.max(1, fontSize * lineHeight)))
        : undefined;

    return {
      key: field.key,
      label: field.label,
      type: field.type,
      required: Boolean(field.required),
      maxLength: field.maxLength || undefined,
      minLength: field.minLength || undefined,
      pattern: field.pattern || undefined,
      width,
      maxLines,
      font: props ? {
        family: props.fontFamily || 'Inter',
        size: fontSize,
        weight: Number(props.fontWeight || 400),
      } : undefined,
    };
  });
}

function prefixIssues(
  issues: Array<{ field: string; message: string; severity: 'error' | 'warning'; details?: Record<string, any> }>,
  itemIndex?: number
): PrintPackageFieldIssue[] {
  return issues.map((issue) => ({
    ...issue,
    itemIndex,
    message: itemIndex === undefined ? issue.message : `Sztuka ${itemIndex + 1}: ${issue.message}`,
  }));
}

/**
 * Waliduje odpowiedzi KAZDEJ sztuki osobno.
 *
 * Pola wspolne (SHARED) sprawdzane sa raz, pola indywidualne (INDIVIDUAL) -
 * tyle razy, ile jest sztuk, kazde wzgledem geometrii TEJ sztuki. Wynik niesie
 * `itemIndex`, zeby portal umial wskazac wiersz listy gosci, a nie tylko
 * powiedziec "cos jest za dlugie".
 */
export async function validatePrintPackageAnswers(
  answers: StructuredCaseAnswers,
  fields: FieldValidationConfig[],
  layout: TemplateLayoutJson,
  qty: number,
  layoutOverrides?: unknown
): Promise<PrintPackageValidationSummary> {
  const sharedFields = fields.filter((field) => getFieldScope(field) === 'SHARED');
  const itemFields = fields.filter((field) => getFieldScope(field) === 'INDIVIDUAL');

  const sharedValidationFields = buildValidationFields(sharedFields, layout, layoutOverrides);
  const sharedResult = await validateAnswers(answers.sharedAnswers, sharedValidationFields);
  const sharedErrors = prefixIssues(sharedResult.errors);
  const sharedWarnings = prefixIssues(sharedResult.warnings);
  const items: PrintPackageItemValidation[] = [];

  for (let itemIndex = 0; itemIndex < qty; itemIndex += 1) {
    const itemValidationFields = buildValidationFields(itemFields, layout, layoutOverrides, itemIndex);
    const result = await validateAnswers(answers.items[itemIndex] || {}, itemValidationFields);
    const errors = prefixIssues(result.errors, itemIndex);
    const warnings = prefixIssues(result.warnings, itemIndex);
    items.push({
      itemIndex,
      isValid: result.isValid,
      errors,
      warnings,
    });
  }

  const errors = [
    ...sharedErrors,
    ...items.flatMap((item) => item.errors),
  ];
  const warnings = [
    ...sharedWarnings,
    ...items.flatMap((item) => item.warnings),
  ];

  return {
    isValid: errors.length === 0,
    shared: {
      isValid: sharedResult.isValid,
      errors: sharedErrors,
      warnings: sharedWarnings,
    },
    items,
    errors,
    warnings,
  };
}
