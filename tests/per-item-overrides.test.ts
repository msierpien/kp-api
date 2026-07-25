import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

const DPI = 300;
const mmToPx = (mm: number) => Math.round((mm / 25.4) * DPI);

function layoutWithText() {
  const canvas = {
    unit: 'mm',
    widthMm: 90,
    heightMm: 50,
    width: mmToPx(90),
    height: mmToPx(50),
    dpi: DPI,
    bleed: 0,
    safeArea: 0,
    backgroundColor: '#ffffff',
  };

  return {
    version: 2,
    canvas,
    fonts: [],
    layers: [],
    pages: [
      {
        id: 'page-1',
        name: 'Przod',
        canvas,
        layers: [
          {
            id: 'layer_name',
            name: 'Nazwisko',
            type: 'textbox',
            visible: true,
            locked: false,
            opacity: 1,
            zIndex: 1,
            x: 400,
            y: 200,
            width: 600,
            height: 120,
            rotation: 0,
            properties: {
              type: 'textbox',
              text: '{{ nazwisko }}',
              fontSize: 40,
              fontUnit: 'pt',
              fontFamily: 'Arial',
              fill: '#000000',
              textAlign: 'center',
              verticalAlign: 'middle',
              padding: 1,
              borderColor: '#000000',
              borderWidth: 1,
              editable: true,
            },
          },
        ],
      },
    ],
  } as any;
}

/** Ile ciemnych pikseli - proxy wielkosci tekstu na wyrenderowanej stronie. */
async function countDarkPixels(png: Buffer): Promise<number> {
  const { createCanvas, loadImage } = await import('canvas');
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;

  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) dark += 1;
  }
  return dark;
}

test('nadpisanie per sztuka zmienia TYLKO wskazana sztuke', async () => {
  const { renderPrintSheetPng } = await import('../src/services/renderer/fabric-renderer.service');
  const layout = layoutWithText();
  const answers = { nazwisko: 'Kowalska-Nowakowska' };

  // Sztuka 1 dostaje mniejszy krój - dlugie nazwisko sie nie miescilo.
  const overrides = {
    layers: {},
    items: { '1': { layers: { layer_name: { fontSize: 12 } } } },
  };

  const item0 = await renderPrintSheetPng(layout, answers, overrides, null, 0);
  const item1 = await renderPrintSheetPng(layout, answers, overrides, null, 1);

  const darkDefault = await countDarkPixels(item0.buffer);
  const darkSmaller = await countDarkPixels(item1.buffer);

  assert.ok(darkDefault > 0, 'sztuka bez nadpisania powinna miec tekst');
  assert.ok(
    darkSmaller < darkDefault / 2,
    `sztuka 1 powinna miec wyraznie mniejszy tekst (${darkSmaller} vs ${darkDefault})`
  );
});

test('nadpisanie wspolne obowiazuje wszystkie sztuki, a per sztuka ma pierwszenstwo', async () => {
  const { renderPrintSheetPng } = await import('../src/services/renderer/fabric-renderer.service');
  const layout = layoutWithText();
  const answers = { nazwisko: 'Kowalska' };

  const overrides = {
    layers: { layer_name: { fontSize: 40 } },
    items: { '2': { layers: { layer_name: { fontSize: 10 } } } },
  };

  const shared = await countDarkPixels((await renderPrintSheetPng(layout, answers, overrides, null, 0)).buffer);
  const perItem = await countDarkPixels((await renderPrintSheetPng(layout, answers, overrides, null, 2)).buffer);

  assert.ok(shared > perItem * 2, `wspolne 40pt vs per sztuka 10pt (${shared} vs ${perItem})`);
});
