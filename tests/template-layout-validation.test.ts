import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTemplateSchema, templateLayoutSchema } from '../src/schemas/admin.schema';
import { collectTemplateLayoutWarnings, validateTemplateLayoutStructure } from '../src/services/admin/template-layout-validation';
import { mmToPx, normalizeCanvasConfig } from '../src/types/template-layout';

test('reports unmapped field keys as soft layout warnings', () => {
  const warnings = collectTemplateLayoutWarnings({
    version: 1,
    canvas: {} as any,
    fonts: [],
    layers: [
      {
        id: 'text_1',
        name: 'Imię',
        type: 'text',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 1,
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        rotation: 0,
        properties: { type: 'text', fieldKey: 'brakujace', placeholder: '{{ brakujace }}' } as any,
      },
    ],
  }, [{ fields: [{ key: 'imie' }] }]);

  assert.equal(warnings.some((warning) => warning.code === 'TEXT_LAYER_FIELD_KEY_UNMAPPED'), true);
  assert.equal(warnings.some((warning) => warning.code === 'BACKGROUND_LAYER_MISSING'), true);
});

test('keeps invalid layer geometry as a blocking validation error', () => {
  assert.throws(() => validateTemplateLayoutStructure({
    version: 1,
    canvas: {} as any,
    fonts: [],
    layers: [
      {
        id: 'text_1',
        name: 'Imię',
        type: 'text',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 1,
        x: 0,
        y: 0,
        width: 0,
        height: 40,
        rotation: 0,
        properties: { type: 'text', fieldKey: 'imie', placeholder: '{{ imie }}' } as any,
      },
    ],
  }), /nieprawidłowe wymiary/);
});

test('preserves simple editor slot metadata in parsed template layouts', () => {
  const parsed = templateLayoutSchema.parse({
    version: 1,
    canvas: {
      width: 1748,
      height: 1240,
      unit: 'mm',
      widthMm: 148,
      heightMm: 105,
      dpi: 300,
      bleed: 0,
      safeArea: 0,
      backgroundColor: '#ffffff',
    },
    fonts: [],
    layers: [
      {
        id: 'text_1',
        name: 'Imię',
        type: 'text',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 1,
        x: 874,
        y: 620,
        width: 400,
        height: 80,
        rotation: 0,
        properties: {
          type: 'text',
          fieldKey: 'imie',
          simpleSlot: 'MIDDLE_CENTER',
          placeholder: '{{ imie }}',
          fontSize: 24,
          fontFamily: 'Arial',
        },
      },
    ],
  });

  const properties = parsed.layers[0].properties as { simpleSlot?: string };
  assert.equal(properties.simpleSlot, 'MIDDLE_CENTER');
});

test('accepts mm-only canvas payloads and derives px dimensions from millimeters', () => {
  const parsed = templateLayoutSchema.parse({
    version: 1,
    canvas: {
      unit: 'mm',
      widthMm: 90,
      heightMm: 50,
      formatPreset: 'WINIETKA_90X50',
      dpi: 300,
      backgroundColor: '#ffffff',
    },
    fonts: [],
    layers: [],
  });

  const normalized = normalizeCanvasConfig(parsed.canvas);

  assert.equal(normalized.unit, 'mm');
  assert.equal(normalized.widthMm, 90);
  assert.equal(normalized.heightMm, 50);
  assert.equal(normalized.width, mmToPx(90, 300));
  assert.equal(normalized.height, mmToPx(50, 300));
});

test('accepts initial layout in create template payload', () => {
  const parsed = createTemplateSchema.parse({
    code: 'WINIETKA_TEST',
    name: 'Winietka test',
    editorType: 'SIMPLE',
    layout: {
      version: 1,
      canvas: {
        unit: 'mm',
        widthMm: 90,
        heightMm: 50,
        formatPreset: 'WINIETKA_90X50',
        dpi: 300,
        backgroundColor: '#ffffff',
      },
      fonts: [],
      layers: [],
    },
  });

  const layout = templateLayoutSchema.parse(parsed.layout);
  const normalized = normalizeCanvasConfig(layout.canvas);

  assert.equal(parsed.editorType, 'SIMPLE');
  assert.equal(normalized.unit, 'mm');
  assert.equal(normalized.widthMm, 90);
  assert.equal(normalized.heightMm, 50);
  assert.equal(normalized.width, mmToPx(90, 300));
  assert.equal(normalized.height, mmToPx(50, 300));
});

test('prefers millimeter dimensions over stale pixel dimensions', () => {
  const normalized = normalizeCanvasConfig({
    width: 9999,
    height: 9999,
    unit: 'mm',
    widthMm: 105,
    heightMm: 148,
    dpi: 300,
    bleed: 200,
    bleedMm: 3,
    safeArea: 500,
    safeAreaMm: 5,
    backgroundColor: '#ffffff',
  });

  assert.equal(normalized.width, mmToPx(105, 300));
  assert.equal(normalized.height, mmToPx(148, 300));
  assert.equal(normalized.bleed, mmToPx(3, 300));
  assert.equal(normalized.safeArea, mmToPx(5, 300));
});
