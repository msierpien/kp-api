import './helpers/test-env';
import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Szerokosc napisu liczona tym, co naprawde pojdzie na papier.
 *
 * Walidator dostawal z warstwy tylko rodzine, stopien i wage pisma. Swiatlo
 * miedzy literami i wersaliki - czyli dwie rzeczy, ktore szerokosc ZMIENIAJA -
 * do niego nie docieraly. Skutek byl cichy: "Aleksandra" miescilo sie w tescie,
 * a "ALEKSANDRA" wyjezdzalo z ramki juz na wydruku.
 */

const DPI = 300;
const TEST_FONT_FAMILY = 'TestWidthCase';
const FONTS_DIR = path.join(process.cwd(), 'storage', 'fonts');
const TEST_FONT_PATH = path.join(FONTS_DIR, `${TEST_FONT_FAMILY}.ttf`);

/**
 * Kroj, w ktorym WIELKA litera jest dwa razy szersza od malej.
 *
 * Dzieki temu sama zamiana wielkosci liter zmienia szerokosc napisu dokladnie
 * dwukrotnie - bez zgadywania, czy roznica wziela sie z metryk kroju.
 */
async function installTestFont() {
  const opentype = (await import('opentype.js')) as any;
  const glyphs = [
    new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 500, path: new opentype.Path() }),
  ];

  for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ ') {
    glyphs.push(
      new opentype.Glyph({
        name: `up${char.charCodeAt(0)}`,
        unicode: char.charCodeAt(0),
        advanceWidth: 500,
        path: new opentype.Path(),
      })
    );
  }

  for (const char of 'abcdefghijklmnopqrstuvwxyz') {
    glyphs.push(
      new opentype.Glyph({
        name: `low${char.charCodeAt(0)}`,
        unicode: char.charCodeAt(0),
        advanceWidth: 250,
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

const FIELD = {
  key: 'imie',
  label: 'Imię',
  type: 'text',
  required: false,
  scope: 'SHARED' as const,
};

/** Ramka 1000 px: dziesiec malych liter (10 x 25 px) miesci sie z zapasem. */
function layoutWithText(extra: Record<string, unknown>) {
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
        id: 'text-1',
        name: 'Imię gościa',
        type: 'text',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 1,
        x: 590,
        y: 500,
        width: 1000,
        height: 160,
        rotation: 0,
        properties: {
          type: 'text',
          fieldKey: 'imie',
          placeholder: '',
          // 100 px: mala litera zajmuje 25 px, wielka 50 px.
          fontSize: 100,
          fontUnit: 'px',
          fontFamily: TEST_FONT_FAMILY,
          fontWeight: 400,
          fontStyle: 'normal',
          fill: '#000000',
          textAlign: 'center',
          lineHeight: 1.2,
          maxLines: 1,
          editable: true,
          ...extra,
        },
      },
    ],
  } as any;
}

async function validate(layout: any, value: string) {
  const { validatePrintPackageAnswers } = await import(
    '../src/services/renderer/answers-validation.service'
  );
  return validatePrintPackageAnswers(
    { sharedAnswers: { imie: value }, items: [{}] },
    [FIELD] as any,
    layout,
    1
  );
}

describe('pomiar szerokosci napisu', () => {
  // 30 malych liter to 750 px - miesci sie w ramce 1000 px.
  const VALUE = 'abcdefghijklmnopqrstuvwxyzabcd';

  test('bez wersalikow i swiatla napis przechodzi', async () => {
    const summary = await validate(layoutWithText({}), VALUE);
    assert.equal(summary.isValid, true, JSON.stringify(summary.errors));
  });

  test('wersaliki licza sie do szerokosci', async () => {
    // Te same 30 znakow wielkimi literami to 1500 px - o polowe za duzo.
    // Przed poprawka walidator mierzyl tresc sprzed zamiany i przepuszczal.
    const summary = await validate(layoutWithText({ textTransform: 'uppercase' }), VALUE);

    assert.equal(summary.isValid, false, 'wersaliki musza wyjsc poza ramke');
    assert.equal(summary.errors[0]?.details?.measured, true, 'kroj jest w rejestrze');
    assert.ok(
      Number(summary.errors[0]?.details?.actualWidth) > 1000,
      `zmierzona szerokosc: ${summary.errors[0]?.details?.actualWidth}`
    );
  });

  test('swiatlo miedzy literami liczy sie do szerokosci', async () => {
    // 30 znakow po 25 px to 750 px; swiatlo 100 (0,1 em) dokłada 10 px na znak,
    // czyli 300 px - razem 1050 px, o 50 px za duzo.
    const summary = await validate(layoutWithText({ letterSpacing: 100 }), VALUE);

    assert.equal(summary.isValid, false, 'swiatlo musi wypchnac napis z ramki');
    assert.ok(
      Number(summary.errors[0]?.details?.actualWidth) > 1000,
      `zmierzona szerokosc: ${summary.errors[0]?.details?.actualWidth}`
    );
  });

  test('ujemne swiatlo sciska napis i pozwala mu przejsc', async () => {
    // 40 malych liter to 1000 px z hakiem; swiatlo -50 zdejmuje 5 px na znak.
    const long = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmn';
    const tight = await validate(layoutWithText({ letterSpacing: -50 }), long);
    assert.equal(tight.isValid, true, JSON.stringify(tight.errors));
  });

  test('konfiguracja walidacji niesie swiatlo, styl i wielkosc liter', async () => {
    const { buildValidationFields } = await import(
      '../src/services/renderer/answers-validation.service'
    );

    const [config] = buildValidationFields(
      [FIELD] as any,
      layoutWithText({ letterSpacing: 100, fontStyle: 'italic', textTransform: 'uppercase' }),
      undefined,
      undefined,
      {}
    );

    assert.equal(config.font?.letterSpacing, 100);
    assert.equal(config.font?.style, 'italic');
    assert.equal(config.font?.transform, 'uppercase');
  });
});
