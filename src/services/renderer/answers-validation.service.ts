import {
  getFieldScope,
  type PersonalizationAnswerField,
  type StructuredCaseAnswers,
} from '../../lib/personalization-answers';
import { mergeLayoutWithOverrides } from '../../lib/layout-overrides';
import {
  getTemplatePagesForAnswers,
  type Layer,
  type TemplateLayoutJson,
} from '../../types/template-layout';
import { validateAnswers } from './text-validator.service';
import { getTextPathArcLength } from '@msierpien/kp-template-core';

export type FieldValidationConfig = PersonalizationAnswerField & {
  label: string;
  type: string;
  maxLength?: number | null;
  minLength?: number | null;
  pattern?: string | null;
};

export interface PrintPackageFieldIssue {
  field: string;
  /**
   * Nazwa pola po ludzku ("Imię i nazwisko"), a nie klucz techniczny.
   * Bez niej portal pokazywal `imie: Sztuka 3: tekst nie miesci sie w ramce` -
   * raz po ludzku, raz po programistycznemu.
   */
  fieldLabel?: string;
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
  // `text_path` MUSI tu byc: bez tego odpowiedzi klienta dla pola na luku
  // nie sa w ogole mierzone - warunek nie rzuca bledu, tylko po cichu
  // pomija warstwe.
  if (layer.type !== 'text' && layer.type !== 'textbox' && layer.type !== 'text_path') return null;
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
  itemIndex?: number,
  answers?: Record<string, unknown>
): Layer[] {
  // Warianty maja wlasne strony - sprawdzamy ten, ktory faktycznie pojdzie do
  // druku, inaczej walidacja mierzylaby ramki z ukladu podstawowego.
  const pages = getTemplatePagesForAnswers(layout, answers);

  return pages.flatMap((page) => {
    const pageLayout: TemplateLayoutJson = {
      ...layout,
      canvas: page.canvas || layout.canvas,
      layers: page.layers,
    };
    return mergeLayoutWithOverrides(pageLayout, layoutOverrides, itemIndex, page.id).layers;
  });
}

/** Geometria ramki, wzgledem ktorej walidator mierzy tekst. */
function describeLayerBox(layer: Layer | undefined, dpi: number) {
  const props = layer?.properties as any;

  // Tekst po luku nie ma ramki - jego "szerokosc" to dlugosc krzywej.
  // Ta sama liczba, ktora edytor pokazuje projektantowi w bloku Kontrola,
  // idzie tutaj jako granica dla odpowiedzi klienta.
  if (layer?.type === 'text_path') {
    const fontSize = typeof props?.fontSize === 'number'
      ? fontSizeToValidatorPx(props.fontSize, props.fontUnit, dpi)
      : undefined;

    return {
      width: getTextPathArcLength(
        {
          pathShape: props?.pathShape === 'circle' ? 'circle' : 'arc',
          radiusMm: Number(props?.radiusMm) || 20,
          startAngle: Number(props?.startAngle) || 0,
          sweepAngle: Number(props?.sweepAngle ?? 180),
        },
        dpi
      ),
      // Napis po luku jest jednoliniowy - druga linia nie mialaby wlasnej krzywej.
      maxLines: 1,
      onArc: true,
      font: props ? {
        family: props.fontFamily || 'Inter',
        size: fontSize,
        weight: Number(props.fontWeight || 400),
      } : undefined,
    };
  }
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
    width,
    maxLines,
    // Tylko `textbox` zawija tekst; `text` i `text_path` sa jednoliniowe.
    wraps: layer?.type === 'textbox',
    font: props ? {
      family: props.fontFamily || 'Inter',
      size: fontSize,
      weight: Number(props.fontWeight || 400),
    } : undefined,
  };
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
  itemIndex?: number,
  answers?: Record<string, unknown>
) {
  const dpi = getCanvasDpi(layout);
  const layerByFieldKey = new Map<string, Layer>();

  for (const layer of collectLayersForItem(layout, layoutOverrides, itemIndex, answers)) {
    if (layer.visible === false) continue;
    const fieldKey = getLayerFieldKey(layer);
    if (fieldKey && !layerByFieldKey.has(fieldKey)) {
      layerByFieldKey.set(fieldKey, layer);
    }
  }

  return fields.map((field) => {
    const layer = layerByFieldKey.get(field.key);

    return {
      key: field.key,
      label: field.label,
      type: field.type,
      required: Boolean(field.required),
      maxLength: field.maxLength || undefined,
      minLength: field.minLength || undefined,
      pattern: field.pattern || undefined,
      ...describeLayerBox(layer, dpi),
    };
  });
}

/**
 * Ostrzezenia o polach, ktorych warstwa zostala ukryta przez klienta.
 *
 * Ukrycie to nadpisanie klienta, a nie decyzja szablonu: pole nadal jest
 * wymagane i klient je wypelnia, tylko tresc nie ma gdzie sie wydrukowac.
 * Pomiar takiej warstwy nie ma sensu (nie ma ramki), ale obsluga musi to
 * zobaczyc przed drukiem - stad ostrzezenie zamiast ciszy.
 */
function hiddenFieldWarnings(
  fields: FieldValidationConfig[],
  layout: TemplateLayoutJson,
  layoutOverrides: unknown,
  values: Record<string, unknown>,
  itemIndex?: number,
  answers?: Record<string, unknown>
): PrintPackageFieldIssue[] {
  const hiddenKeys = new Map<string, string>();
  const visibleKeys = new Set<string>();

  for (const layer of collectLayersForItem(layout, layoutOverrides, itemIndex, answers)) {
    const fieldKey = getLayerFieldKey(layer);
    if (!fieldKey) continue;
    if (layer.visible === false) hiddenKeys.set(fieldKey, layer.name || fieldKey);
    else visibleKeys.add(fieldKey);
  }

  return fields
    .filter((field) => hiddenKeys.has(field.key) && !visibleKeys.has(field.key))
    // Puste pole zglosi juz zwykla walidacja "wymagane" - tu chodzi o dane,
    // ktore klient wpisal, a ktore nie pojda na wydruk.
    .filter((field) => String(values[field.key] ?? '').trim().length > 0)
    .map((field) => ({
      field: field.key,
      fieldLabel: field.label,
      severity: 'warning' as const,
      itemIndex,
      message:
        itemIndex === undefined
          ? 'element ukryty na projekcie — ta treść nie pójdzie na wydruk'
          : `Sztuka ${itemIndex + 1}: element ukryty na projekcie — ta treść nie pójdzie na wydruk`,
      details: { hiddenLayer: true },
    }));
}

/** Prefiks klucza pseudo-pola dla tekstu dopisanego przez klienta. */
const ADDED_TEXT_KEY_PREFIX = '__layer:';

/** Skrot tresci do etykiety - pelne motto nie zmiesci sie w komunikacie. */
function shortenText(text: string, limit = 24): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

/**
 * Pseudo-pola dla tekstow, ktore klient dopisal sam (element "Twój tekst").
 *
 * Walidacja budowala mape wylacznie po `fieldKey` warstwy, wiec wlasne teksty
 * nie mialy czego przekroczyc: klient wpisywal dwuwierszowe motto, dostawal
 * zielone swiatlo i reklamacje po druku. Tresc takiej warstwy nie zyje
 * w odpowiedziach, tylko w samej warstwie - stad osobna para pola i wartosci.
 */
export function buildAddedTextValidation(
  layout: TemplateLayoutJson,
  layoutOverrides?: unknown,
  itemIndex?: number,
  answers?: Record<string, unknown>
): { fields: any[]; values: Record<string, string> } {
  const overrides = layoutOverrides as any;
  const addedIds = new Set<string>(
    Array.isArray(overrides?.addedLayers)
      ? overrides.addedLayers
          .map((entry: any) => entry?.layer?.id || entry?.id)
          .filter((id: unknown): id is string => typeof id === 'string')
      : []
  );

  if (addedIds.size === 0) return { fields: [], values: {} };

  const dpi = getCanvasDpi(layout);
  const fields: any[] = [];
  const values: Record<string, string> = {};

  for (const layer of collectLayersForItem(layout, layoutOverrides, itemIndex, answers)) {
    if (!addedIds.has(layer.id)) continue;
    if (layer.visible === false) continue;
    if (layer.type !== 'text' && layer.type !== 'textbox' && layer.type !== 'text_path') continue;
    // Element wpiety w kolumne listy gosci ma `fieldKey` i idzie zwykla sciezka.
    if (getLayerFieldKey(layer)) continue;

    const text = (layer.properties as any)?.text;
    if (typeof text !== 'string' || !text.trim()) continue;

    const key = `${ADDED_TEXT_KEY_PREFIX}${layer.id}`;
    values[key] = text;
    fields.push({
      key,
      label: `Twój tekst: „${shortenText(text)}"`,
      type: 'text',
      required: false,
      ...describeLayerBox(layer, dpi),
    });
  }

  return { fields, values };
}

/**
 * Uzupelnia problem o numer sztuki i nazwe pola po ludzku.
 *
 * `message` zostaje z prefiksem "Sztuka N:" - czyta go panel, gdzie lista
 * problemow jest plaska. Portal klienta ma `itemIndex` i `fieldLabel`,
 * wiec sklada zdanie po swojemu.
 */
function describeIssues(
  issues: Array<{ field: string; message: string; severity: 'error' | 'warning'; details?: Record<string, any> }>,
  labels: Map<string, string>,
  itemIndex?: number
): PrintPackageFieldIssue[] {
  return issues.map((issue) => ({
    ...issue,
    itemIndex,
    fieldLabel: labels.get(issue.field),
    message: itemIndex === undefined ? issue.message : `Sztuka ${itemIndex + 1}: ${issue.message}`,
  }));
}

/** Mapa klucz pola -> etykieta, z pol formularza i z tekstow klienta. */
function labelsOf(...fieldSets: Array<Array<{ key: string; label?: string }>>): Map<string, string> {
  const labels = new Map<string, string>();
  for (const fields of fieldSets) {
    for (const field of fields) {
      if (field.label) labels.set(field.key, field.label);
    }
  }
  return labels;
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

  const sharedValidationFields = buildValidationFields(
    sharedFields,
    layout,
    layoutOverrides,
    undefined,
    answers.sharedAnswers
  );

  // Teksty dopisane przez klienta sa wspolne dla zamowienia (tresc nie zalezy
  // od goscia), wiec mierzymy je raz, razem z polami wspolnymi.
  const addedText = buildAddedTextValidation(
    layout,
    layoutOverrides,
    undefined,
    answers.sharedAnswers
  );

  const sharedResult = await validateAnswers(
    { ...answers.sharedAnswers, ...addedText.values },
    [...sharedValidationFields, ...addedText.fields]
  );
  const sharedLabels = labelsOf(sharedValidationFields, addedText.fields);
  const sharedErrors = describeIssues(sharedResult.errors, sharedLabels);
  const sharedWarnings = [
    ...describeIssues(sharedResult.warnings, sharedLabels),
    ...hiddenFieldWarnings(
      sharedFields,
      layout,
      layoutOverrides,
      answers.sharedAnswers,
      undefined,
      answers.sharedAnswers
    ),
  ];
  const items: PrintPackageItemValidation[] = [];

  for (let itemIndex = 0; itemIndex < qty; itemIndex += 1) {
    // Odpowiedzi sztuki nadpisuja wspolne - tak samo sklada je renderer, wiec
    // wariant wybrany tutaj jest tym, ktory pojdzie na wydruk tej sztuki.
    const itemAnswers = { ...answers.sharedAnswers, ...(answers.items[itemIndex] || {}) };
    const itemValidationFields = buildValidationFields(
      itemFields,
      layout,
      layoutOverrides,
      itemIndex,
      itemAnswers
    );
    const result = await validateAnswers(answers.items[itemIndex] || {}, itemValidationFields);
    const itemLabels = labelsOf(itemValidationFields);
    const errors = describeIssues(result.errors, itemLabels, itemIndex);
    const warnings = [
      ...describeIssues(result.warnings, itemLabels, itemIndex),
      ...hiddenFieldWarnings(
        itemFields,
        layout,
        layoutOverrides,
        answers.items[itemIndex] || {},
        itemIndex,
        itemAnswers
      ),
    ];
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
