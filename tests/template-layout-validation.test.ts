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

test('preserves panel properties on save (backgroundOpacity + client typography flags)', () => {
  const parsed = templateLayoutSchema.parse({
    version: 2,
    canvas: {
      unit: 'mm',
      widthMm: 90,
      heightMm: 50,
      dpi: 300,
      bleed: 0,
      safeArea: 0,
      backgroundColor: '#ffffff',
    },
    fonts: [],
    layers: [
      {
        id: 'textbox_1',
        name: 'Imię i nazwisko',
        type: 'textbox',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 1,
        x: 10,
        y: 10,
        width: 400,
        height: 80,
        rotation: 0,
        properties: {
          type: 'textbox',
          text: '{{ imie }}',
          fontSize: 24,
          fontFamily: 'Arial',
          backgroundColor: '#ffffff',
          backgroundOpacity: 45,
          splitByGrapheme: true,
          clientDraggable: true,
          clientFontSize: true,
          clientFontFamily: true,
          clientColor: true,
          clientTextAlign: true,
        },
      },
      {
        id: 'text_1',
        name: 'Imię',
        type: 'text',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 2,
        x: 10,
        y: 100,
        width: 400,
        height: 80,
        rotation: 0,
        properties: {
          type: 'text',
          fieldKey: 'imie',
          placeholder: '{{ imie }}',
          fontSize: 24,
          fontFamily: 'Arial',
          clientFontSize: true,
          clientFontFamily: true,
          clientColor: true,
          clientTextAlign: true,
        },
      },
    ],
  });

  const textbox = parsed.layers[0].properties as Record<string, unknown>;
  assert.equal(textbox.backgroundOpacity, 45);
  assert.equal(textbox.splitByGrapheme, true);
  assert.equal(textbox.clientFontSize, true);
  assert.equal(textbox.clientTextAlign, true);

  const text = parsed.layers[1].properties as Record<string, unknown>;
  assert.equal(text.clientFontSize, true);
  assert.equal(text.clientFontFamily, true);
  assert.equal(text.clientColor, true);
  assert.equal(text.clientTextAlign, true);
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

test('fonty webowe sa oznaczone jako niezdatne do druku', async () => {
  const { PRINTABLE_FONT_FORMATS } = await import('../src/services/admin/fonts.service');

  // Renderer (node-canvas) rejestruje wylacznie formaty plikowe.
  assert.deepEqual([...PRINTABLE_FONT_FORMATS].sort(), ['otf', 'ttf']);
  assert.equal(PRINTABLE_FONT_FORMATS.includes('woff'), false);
  assert.equal(PRINTABLE_FONT_FORMATS.includes('woff2'), false);
});

test('paleta kolorow szablonu przechodzi zapis i odrzuca smieci', () => {
  const base = {
    version: 2 as const,
    canvas: { unit: 'mm' as const, widthMm: 90, heightMm: 50, dpi: 300, bleed: 0, safeArea: 0, backgroundColor: '#ffffff' },
    fonts: [],
    layers: [],
  };

  const parsed = templateLayoutSchema.parse({ ...base, palette: ['#000000', '#C0392B'] });
  assert.deepEqual(parsed.palette, ['#000000', '#C0392B']);

  // Bez walidacji kolor trafilby wprost do stylu tekstu i do wydruku.
  assert.throws(() => templateLayoutSchema.parse({ ...base, palette: ['czerwony'] }));
  assert.throws(() => templateLayoutSchema.parse({ ...base, palette: ['#fff'] }));
});

test('wlasciwosci figury przechodza zapis w calosci', () => {
  // Zod wycina nieznane klucze po cichu, wiec pole dodane do formatu i
  // pominiete w schemacie znika przy zapisie bez sladu w logach. Ten test
  // pilnuje tego dla figur.
  const parsed = templateLayoutSchema.parse({
    version: 2,
    canvas: { unit: 'mm', widthMm: 90, heightMm: 50, dpi: 300, bleed: 0, safeArea: 0, backgroundColor: '#ffffff' },
    fonts: [],
    layers: [
      {
        id: 'shape_1',
        name: 'Kreska',
        type: 'shape',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 1,
        x: 100,
        y: 200,
        width: 300,
        height: 6,
        rotation: 0,
        properties: {
          type: 'shape',
          shapeType: 'line',
          fill: 'transparent',
          stroke: '#C0392B',
          strokeWidth: 1,
          strokeWidthMm: 0.5,
          borderRadius: 0,
          borderRadiusMm: 2,
          strokeDashArray: [18, 12],
        },
      },
    ],
  });

  const shape = parsed.layers[0].properties as Record<string, unknown>;
  assert.equal(shape.shapeType, 'line');
  assert.equal(shape.strokeWidthMm, 0.5);
  assert.equal(shape.borderRadiusMm, 2);
  assert.deepEqual(shape.strokeDashArray, [18, 12]);
});

test('grupy warstw przechodza przez schemat zapisu', () => {
  // Pole nieopisane w schemacie jest cicho wycinane - ten test pilnuje, ze
  // grupy przetrwaja zapis layoutu, bo inaczej edytor gubilby je po kazdym
  // odswiezeniu i nikt by tego nie zauwazyl az do reklamacji.
  const canvas = normalizeCanvasConfig({ widthMm: 105, heightMm: 148, dpi: 300 } as any);
  const layer = {
    id: 'text_1',
    name: 'Imiona',
    type: 'text',
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    groupId: 'g1',
    blockId: 'block_1',
    properties: {
      type: 'text',
      fieldKey: 'imiona',
      placeholder: '{{ imiona }}',
      fontSize: 24,
      fontFamily: 'Cormorant Garamond',
    },
  };

  const parsed = templateLayoutSchema.parse({
    version: 2,
    canvas,
    fonts: [],
    layers: [layer],
    pages: [
      {
        id: 'page-1',
        name: 'Przód',
        canvas,
        layers: [layer],
        groups: [
          { id: 'g1', name: 'Nagłówek', settings: { fontFamily: 'Cormorant', fill: '#a3123a' } },
        ],
      },
    ],
  });

  assert.equal(parsed.pages?.[0].groups?.[0].name, 'Nagłówek');
  assert.equal(parsed.pages?.[0].groups?.[0].settings?.fill, '#a3123a');
  assert.equal(parsed.pages?.[0].layers[0].groupId, 'g1');
  assert.equal(parsed.layers[0].groupId, 'g1', 'lustro pierwszej strony tez niesie grupe');
  assert.equal(parsed.pages?.[0].layers[0].blockId, 'block_1', 'znacznik bloku przezywa zapis');
});

test('ostrzezenia o grupach docieraja z pakietu formatu', () => {
  const canvas = normalizeCanvasConfig({ widthMm: 105, heightMm: 148, dpi: 300 } as any);
  const layer = {
    id: 'text_1',
    name: 'Imiona',
    type: 'text',
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: 0,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    rotation: 0,
    groupId: 'nie-ma-takiej',
    properties: { type: 'text', fieldKey: 'imiona', placeholder: '{{ imiona }}' } as any,
  };

  const warnings = collectTemplateLayoutWarnings(
    {
      version: 2,
      canvas,
      fonts: [],
      layers: [layer],
      pages: [{ id: 'page-1', name: 'Przód', canvas, layers: [layer], groups: [] }],
    } as any,
    [{ fields: [{ key: 'imiona' }] }]
  );

  assert.ok(warnings.some((warning) => warning.code === 'LAYER_GROUP_MISSING'));
});
