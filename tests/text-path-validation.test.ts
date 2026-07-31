import './helpers/test-env';
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getTextPathArcLength, getTextPathBBox } from '@msierpien/kp-template-core';

/**
 * Walidacja tekstu po luku - etap 4 planu.
 *
 * Sedno: napis dluzszy niz luk fabric po prostu utnie na koncu krzywej, bez
 * zadnego bledu. Bez tych testow "pole na luku bez walidacji dlugosci" jest
 * gotowa reklamacja.
 */

const DPI = 300;
const TEST_FONT_FAMILY = 'TestMonoArc';
const FONTS_DIR = path.join(process.cwd(), 'storage', 'fonts');
const TEST_FONT_PATH = path.join(FONTS_DIR, `${TEST_FONT_FAMILY}.ttf`);

/** Kroj o stalej szerokosci 0.5 em - arytmetyka jest wtedy przewidywalna. */
async function installTestFont() {
  const opentype = (await import('opentype.js')) as any;
  const glyphs = [
    new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 500, path: new opentype.Path() }),
  ];

  for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ') {
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

before(installTestFont);
after(async () => {
  await fs.rm(TEST_FONT_PATH, { force: true });
  const { clearFontsListCache } = await import('../src/services/admin/fonts.service');
  clearFontsListCache();
});

const ARC = { pathShape: 'arc' as const, radiusMm: 20, startAngle: 180, sweepAngle: 180 };

function layoutWithArc(fieldKey = 'haslo') {
  const box = getTextPathBBox(ARC, DPI);

  return {
    version: 2,
    canvas: {
      unit: 'mm', widthMm: 100, heightMm: 100,
      width: 1181, height: 1181, dpi: DPI,
      bleed: 0, safeArea: 0, backgroundColor: '#ffffff',
    },
    fonts: [],
    layers: [
      {
        id: 'arc-1',
        name: 'Napis po łuku',
        type: 'text_path',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 1,
        x: 590,
        y: 500,
        width: box.width,
        height: box.height,
        rotation: 0,
        properties: {
          type: 'text_path',
          ...(fieldKey ? { fieldKey } : {}),
          ...ARC,
          pathSide: 'left',
          pathAlign: 'baseline',
          textPathAlign: 'center',
          // 100 px przy 300 dpi - stala szerokosc znaku 0.5 em daje 50 px na znak.
          fontSize: 100,
          fontUnit: 'px',
          fontFamily: TEST_FONT_FAMILY,
          fontWeight: 400,
          fontStyle: 'normal',
          fill: '#000000',
        },
      },
    ],
  } as any;
}

const FIELD = {
  key: 'haslo',
  label: 'Hasło',
  type: 'text',
  required: false,
  scope: 'SHARED' as const,
};

describe('dlugosc napisu na luku', () => {
  test('napis dluzszy niz luk zatrzymuje zatwierdzenie', async () => {
    const { validatePrintPackageAnswers } = await import(
      '../src/services/renderer/answers-validation.service'
    );

    const arcLength = getTextPathArcLength(ARC, DPI);
    // 50 px na znak - tyle znakow, zeby na pewno przekroczyc luk.
    const tooLong = 'A'.repeat(Math.ceil(arcLength / 50) + 5);

    const summary = await validatePrintPackageAnswers(
      { sharedAnswers: { haslo: tooLong }, items: [{}] },
      [FIELD] as any,
      layoutWithArc(),
      1
    );

    assert.equal(summary.isValid, false, 'za dlugi napis nie moze przejsc');
    const issue = summary.errors[0];
    assert.ok(issue, 'ma byc blad walidacji');
    assert.match(issue.message, /łuk/i, 'komunikat ma mowic o luku, nie o linii w ramce');
    assert.equal(issue.details?.onArc, true);
    assert.equal(issue.details?.measured, true, 'kroj jest w rejestrze, wiec pomiar jest realny');
  });

  test('napis mieszczacy sie na luku przechodzi', async () => {
    const { validatePrintPackageAnswers } = await import(
      '../src/services/renderer/answers-validation.service'
    );

    const summary = await validatePrintPackageAnswers(
      { sharedAnswers: { haslo: 'ABC' }, items: [{}] },
      [FIELD] as any,
      layoutWithArc(),
      1
    );

    assert.equal(summary.isValid, true);
    assert.equal(summary.errors.length, 0);
  });

  test('granica to dlugosc luku, a nie szerokosc bboksu warstwy', async () => {
    const { buildValidationFields } = await import(
      '../src/services/renderer/answers-validation.service'
    );

    const [config] = buildValidationFields([FIELD] as any, layoutWithArc(), undefined, undefined, {});
    const arcLength = getTextPathArcLength(ARC, DPI);
    const box = getTextPathBBox(ARC, DPI);

    assert.equal(Math.round(config.width!), Math.round(arcLength));
    assert.notEqual(Math.round(config.width!), box.width, 'bbox to nie to samo co dlugosc luku');
    // Napis po luku jest jednoliniowy.
    assert.equal(config.maxLines, 1);
  });
});

describe('ostrzezenia szablonu', () => {
  test('luk bez fieldKey to tekst staly, nie blad projektanta', async () => {
    const { collectTemplateLayoutWarnings } = await import(
      '../src/services/admin/template-layout-validation'
    );

    // "ZAPRASZAMY" po luku nie musi brac sie z formularza - tak samo jak
    // `textbox` bez klucza. Ostrzezenie o BRAKU klucza dotyczy wylacznie
    // typu `text`, ktory z definicji podstawia odpowiedz klienta.
    const warnings = collectTemplateLayoutWarnings(layoutWithArc(''), [
      { fields: [{ key: 'haslo' }] },
    ]);

    assert.ok(
      !warnings.some((warning) => warning.layerId === 'arc-1'),
      'tekst staly po luku nie moze zglaszac braku fieldKey'
    );
  });

  test('zdublowany fieldKey na luku jest zglaszany', async () => {
    const { collectTemplateLayoutWarnings } = await import(
      '../src/services/admin/template-layout-validation'
    );

    // Dwie warstwy z tym samym kluczem to konflikt niezaleznie od tego,
    // czy druga jest w ramce, czy po luku.
    const layout = layoutWithArc('haslo');
    layout.layers.push({
      ...layout.layers[0],
      id: 'text-2',
      type: 'text',
      properties: { type: 'text', fieldKey: 'haslo', placeholder: '', fontSize: 20, fontFamily: 'Arial', fontWeight: 400, fontStyle: 'normal', fill: '#000', textAlign: 'center', lineHeight: 1.2, maxLines: 1, textTransform: 'none', editable: true },
    });

    const warnings = collectTemplateLayoutWarnings(layout, [{ fields: [{ key: 'haslo' }] }]);

    assert.ok(
      warnings.some((warning) => warning.code === 'TEXT_LAYER_FIELD_KEY_DUPLICATED'),
      'duplikat klucza ma byc zgloszony'
    );
  });

  test('fieldKey spoza formularza jest zglaszany takze dla luku', async () => {
    const { collectTemplateLayoutWarnings } = await import(
      '../src/services/admin/template-layout-validation'
    );

    const warnings = collectTemplateLayoutWarnings(layoutWithArc('nieistniejace'), [
      { fields: [{ key: 'haslo' }] },
    ]);

    assert.ok(
      warnings.some(
        (warning) => warning.code === 'TEXT_LAYER_FIELD_KEY_UNMAPPED' && warning.layerId === 'arc-1'
      )
    );
  });

  test('walidacja struktury odrzuca warstwe o zerowych wymiarach', async () => {
    const { validateTemplateLayoutStructure } = await import(
      '../src/services/admin/template-layout-validation'
    );

    const layout = layoutWithArc();
    layout.layers[0].width = 0;

    assert.throws(() => validateTemplateLayoutStructure(layout), /nieprawidłowe wymiary/);
  });
});
