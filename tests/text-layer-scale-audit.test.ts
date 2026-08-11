import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

import {
  collectTextLayers,
  getMeasuredText,
  measureLayer,
  widenFrame,
} from '../src/scripts/audit-text-layer-scale';

const DPI = 300;

function textLayer(overrides: Record<string, any> = {}) {
  return {
    id: 'txt',
    name: 'Imię gościa',
    type: 'text',
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: 0,
    x: 500,
    y: 300,
    width: 400,
    height: 60,
    rotation: 0,
    ...overrides,
    properties: {
      type: 'text',
      fieldKey: 'guest_name',
      placeholder: 'Nowy tekst',
      fontSize: 32,
      fontUnit: 'pt',
      fontFamily: 'Arial',
      fontWeight: 400,
      fontStyle: 'normal',
      fill: '#000000',
      textAlign: 'center',
      lineHeight: 1.2,
      ...(overrides.properties || {}),
    },
  };
}

test('tresc do pomiaru to placeholder warstwy, z tokenami w postaci doslownej', () => {
  assert.equal(getMeasuredText(textLayer()), 'Nowy tekst');

  assert.equal(
    getMeasuredText(textLayer({ properties: { placeholder: '' } })),
    '{{ guest_name }}'
  );

  assert.equal(
    getMeasuredText({ type: 'static_text', properties: { text: 'Zapraszamy' } }),
    'Zapraszamy'
  );
});

test('domyslna warstwa 400 x 60 px byla w starym edytorze mocno sciskana', async () => {
  const layer = textLayer();
  const measured = await measureLayer(layer, DPI);
  assert.ok(measured, 'warstwa z trescia musi dac sie zmierzyc');

  // 32 pt przy 300 dpi to 133 px wysokosci pisma - napis jest wyrazniej
  // wiekszy niz ramka, ktora dostawal domyslnie.
  assert.ok(measured!.width > layer.width, 'napis szerszy niz ramka');
  assert.ok(measured!.height > layer.height, 'napis wyzszy niz ramka');

  const skalaX = layer.width / measured!.width;
  const skalaY = layer.height / measured!.height;

  // Skala niejednorodna - stad deformacja glifow w starym podgladzie.
  assert.ok(Math.abs(skalaX - skalaY) > 0.1, 'skala pozioma i pionowa musialy sie roznic');
});

test('pusta tresc nie daje pomiaru - nie ma z czego liczyc skali', async () => {
  const layer = textLayer({ properties: { placeholder: '', fieldKey: '' } });
  assert.equal(await measureLayer(layer, DPI), null);
});

test('warstwa znaleziona we wszystkich lustrach layoutu', () => {
  const canvas = { dpi: DPI };
  const first = textLayer();
  const mirrored = textLayer();
  const variantCopy = textLayer();

  const layout = {
    canvas,
    layers: [first],
    pages: [{ id: 'page-1', canvas, layers: [mirrored] }],
    variants: [{ id: 'v1', pages: [{ id: 'page-1', canvas, layers: [variantCopy] }] }],
  };

  const found = collectTextLayers(layout);
  assert.equal(found.size, 1);
  assert.equal(found.get('txt')!.length, 3);
  assert.deepEqual(
    found.get('txt')!.map((occurrence) => occurrence.where),
    ['layers', 'pages[0]', 'variants[0].pages[0]']
  );
});

test('warstwy innego typu nie trafiaja do audytu', () => {
  const canvas = { dpi: DPI };
  const layout = {
    canvas,
    layers: [
      { id: 'box', type: 'textbox', width: 300, height: 100, properties: { text: 'x' } },
      { id: 'arc', type: 'text_path', width: 300, height: 100, properties: { text: 'x' } },
    ],
  };

  assert.equal(collectTextLayers(layout).size, 0);
});

test('poszerzenie ramki nigdy jej nie zweza i wchodzi w kazde lustro', () => {
  const wide = textLayer({ width: 900, height: 200 });
  const narrow = textLayer({ width: 400, height: 60 });

  const occurrences = [
    { where: 'layers', layer: narrow, dpi: DPI },
    { where: 'pages[0]', layer: wide, dpi: DPI },
  ];

  assert.equal(widenFrame(occurrences, 652.4, 151.2), true);
  // Ciasna ramka rosnie do napisu (w gore, do pelnych pikseli)...
  assert.equal(narrow.width, 653);
  assert.equal(narrow.height, 152);
  // ...a szersza zostaje nietknieta - to decyzja projektanta.
  assert.equal(wide.width, 900);
  assert.equal(wide.height, 200);

  // Drugie przejscie nie ma juz czego zmienic.
  assert.equal(widenFrame(occurrences, 652.4, 151.2), false);
});
