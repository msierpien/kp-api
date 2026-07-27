import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

/**
 * Krój o stalej szerokosci znaku 0.5 em wgrany do rejestru na czas testu.
 *
 * Bez realnego pliku walidator nie ma czego zmierzyc i kazdy wynik jest
 * zgadywany - a wlasnie to bylo zrodlem bledu, ktory te testy pilnuja. Stala
 * szerokosc daje przewidywalna arytmetyke: N znakow * fontSize / 2.
 */
const TEST_FONT_FAMILY = 'TestMono';
const FONTS_DIR = path.join(process.cwd(), 'storage', 'fonts');
const TEST_FONT_PATH = path.join(FONTS_DIR, `${TEST_FONT_FAMILY}.ttf`);
const CHAR_WIDTH_RATIO = 0.5;

async function installTestFont() {
  const opentype = (await import('opentype.js')) as any;
  const glyphs = [
    new opentype.Glyph({
      name: '.notdef',
      unicode: 0,
      advanceWidth: 500,
      path: new opentype.Path(),
    }),
  ];

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -';
  for (const char of alphabet) {
    glyphs.push(
      new opentype.Glyph({
        name: `g${char.charCodeAt(0)}`,
        unicode: char.charCodeAt(0),
        advanceWidth: 500,
        path: new opentype.Path(),
      })
    );
  }

  const font = new opentype.Font({
    familyName: TEST_FONT_FAMILY,
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs,
  });

  await fs.mkdir(FONTS_DIR, { recursive: true });
  await fs.writeFile(TEST_FONT_PATH, Buffer.from(font.toArrayBuffer()));

  const { clearFontsListCache } = await import('../src/services/admin/fonts.service');
  clearFontsListCache();
}

async function removeTestFont() {
  await fs.rm(TEST_FONT_PATH, { force: true });
  const { clearFontsListCache } = await import('../src/services/admin/fonts.service');
  clearFontsListCache();
}

before(installTestFont);
after(removeTestFont);

function textLayer(id: string, fieldKey: string, overrides: Record<string, any> = {}) {
  return {
    id,
    name: fieldKey,
    type: 'textbox',
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: 1,
    x: 0,
    y: 0,
    width: 600,
    height: 200,
    rotation: 0,
    ...overrides,
    properties: {
      type: 'textbox',
      text: `{{ ${fieldKey} }}`,
      fieldKey,
      // px zamiast pt: pomiar ma byc czytelna arytmetyka, bez przeliczania DPI
      fontSize: 100,
      fontUnit: 'px',
      fontFamily: TEST_FONT_FAMILY,
      fill: '#000000',
      padding: 0,
      lineHeight: 1.2,
      ...(overrides.properties || {}),
    },
  };
}

function layoutWithPages(pages: Array<{ id: string; layers: any[] }>) {
  const canvas = {
    unit: 'mm',
    widthMm: 100,
    heightMm: 100,
    width: 1181,
    height: 1181,
    dpi: 300,
    bleed: 0,
    safeArea: 0,
    backgroundColor: '#ffffff',
  };

  return {
    version: 2,
    canvas,
    fonts: [],
    // Lustro pierwszej strony - dokladnie tak zapisuje layouty edytor.
    layers: pages[0].layers,
    pages: pages.map((page) => ({ ...page, name: page.id, canvas })),
  } as any;
}

const NAZWISKO_FIELD = {
  key: 'nazwisko',
  label: 'Nazwisko',
  type: 'text',
  required: false,
  scope: 'INDIVIDUAL' as const,
};

/** 8 znakow * 50px = 400px - miesci sie w ramce 600px. */
const SHORT_NAME = 'Kowalska';
/** 19 znakow * 50px = 950px - nie miesci sie. */
const LONG_NAME = 'Kowalska-Nowakowska';

test('za dlugie nazwisko wskazuje wlasciwa sztuke, nie pierwsza', async () => {
  const { validatePrintPackageAnswers } = await import(
    '../src/services/renderer/answers-validation.service'
  );

  const layout = layoutWithPages([{ id: 'page-1', layers: [textLayer('layer_name', 'nazwisko')] }]);
  const answers = {
    sharedAnswers: {},
    items: [{ nazwisko: SHORT_NAME }, { nazwisko: 'Nowak' }, { nazwisko: LONG_NAME }],
  };

  const summary = await validatePrintPackageAnswers(answers, [NAZWISKO_FIELD] as any, layout, 3);

  assert.equal(summary.isValid, false, 'sprawa z za dlugim nazwiskiem nie moze byc poprawna');
  assert.equal(summary.items[0].isValid, true);
  assert.equal(summary.items[1].isValid, true);
  assert.equal(summary.items[2].isValid, false);
  assert.equal(summary.errors.length, 1);
  assert.equal(summary.errors[0].itemIndex, 2, 'blad ma wskazywac gosca 3');
  assert.match(summary.errors[0].message, /Sztuka 3/);
  assert.equal(summary.errors[0].details?.measured, true, 'pomiar ma isc z realnego pliku fontu');
  assert.equal(
    summary.errors[0].details?.actualWidth,
    Math.round(LONG_NAME.length * 100 * CHAR_WIDTH_RATIO)
  );
});

test('walidowane sa warstwy ze WSZYSTKICH stron, nie tylko z pierwszej', async () => {
  const { validatePrintPackageAnswers } = await import(
    '../src/services/renderer/answers-validation.service'
  );

  // Pole z nazwiskiem jest na drugiej stronie - w `layout.layers` (lustro
  // pierwszej strony) nie ma go wcale.
  const layout = layoutWithPages([
    { id: 'page-1', layers: [textLayer('layer_other', 'data')] },
    { id: 'page-2', layers: [textLayer('layer_name', 'nazwisko')] },
  ]);
  const answers = { sharedAnswers: {}, items: [{ nazwisko: LONG_NAME }] };

  const summary = await validatePrintPackageAnswers(answers, [NAZWISKO_FIELD] as any, layout, 1);

  assert.equal(summary.isValid, false, 'pole z tylu winietki tez ma byc sprawdzane');
  assert.equal(summary.errors[0].itemIndex, 0);
});

test('mniejsza czcionka ustawiona przez klienta ratuje sztuke', async () => {
  const { validatePrintPackageAnswers } = await import(
    '../src/services/renderer/answers-validation.service'
  );

  const layout = layoutWithPages([{ id: 'page-1', layers: [textLayer('layer_name', 'nazwisko')] }]);
  const answers = { sharedAnswers: {}, items: [{ nazwisko: LONG_NAME }, { nazwisko: LONG_NAME }] };

  // Klient zmniejszyl krój TYLKO na drugiej sztuce: 19 * 20 * 0.5 = 190px.
  const overrides = {
    layers: {},
    items: { '1': { layers: { layer_name: { fontSize: 20 } } } },
  };

  const summary = await validatePrintPackageAnswers(
    answers,
    [NAZWISKO_FIELD] as any,
    layout,
    2,
    overrides
  );

  assert.equal(summary.items[0].isValid, false, 'sztuka bez poprawki nadal sie nie miesci');
  assert.equal(summary.items[1].isValid, true, 'sztuka ze zmniejszonym krojem ma przejsc');
});

test('szersza ramka ustawiona przez klienta tez jest respektowana', async () => {
  const { validatePrintPackageAnswers } = await import(
    '../src/services/renderer/answers-validation.service'
  );

  const layout = layoutWithPages([{ id: 'page-1', layers: [textLayer('layer_name', 'nazwisko')] }]);
  const answers = { sharedAnswers: {}, items: [{ nazwisko: LONG_NAME }] };
  const overrides = { layers: { layer_name: { width: 1000 } } };

  const summary = await validatePrintPackageAnswers(
    answers,
    [NAZWISKO_FIELD] as any,
    layout,
    1,
    overrides
  );

  assert.equal(summary.isValid, true, '950px miesci sie w poszerzonej do 1000px ramce');
});

test('brak kroju w rejestrze daje ostrzezenie, nie blokujacy blad', async () => {
  const { validatePrintPackageAnswers } = await import(
    '../src/services/renderer/answers-validation.service'
  );

  const layout = layoutWithPages([
    {
      id: 'page-1',
      layers: [
        textLayer('layer_name', 'nazwisko', {
          properties: { fontFamily: 'Krój Ktorego Nie Ma W Rejestrze' },
        }),
      ],
    },
  ]);
  const answers = { sharedAnswers: {}, items: [{ nazwisko: LONG_NAME }] };

  const summary = await validatePrintPackageAnswers(answers, [NAZWISKO_FIELD] as any, layout, 1);

  assert.equal(summary.isValid, true, 'zgadywana szerokosc nie moze blokowac klienta');
  assert.equal(summary.warnings.length, 1);
  assert.equal(summary.warnings[0].details?.measured, false);
  assert.match(summary.warnings[0].message, /pomiar przybliżony/);
});

test('pola wspolne sprawdzane sa raz, bez numeru sztuki', async () => {
  const { validatePrintPackageAnswers } = await import(
    '../src/services/renderer/answers-validation.service'
  );

  const layout = layoutWithPages([{ id: 'page-1', layers: [textLayer('layer_para', 'para')] }]);
  const sharedField = { ...NAZWISKO_FIELD, key: 'para', label: 'Para', scope: 'SHARED' as const };
  const answers = { sharedAnswers: { para: LONG_NAME }, items: [{}, {}, {}] };

  const summary = await validatePrintPackageAnswers(answers, [sharedField] as any, layout, 3);

  assert.equal(summary.errors.length, 1, 'pole wspolne nie moze sie powtorzyc raz na sztuke');
  assert.equal(summary.errors[0].itemIndex, undefined);
  assert.equal(summary.shared.isValid, false);
});
