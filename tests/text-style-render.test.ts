import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

const DPI = 300;
const mmToPx = (mm: number) => Math.round((mm / 25.4) * DPI);

function makeTextboxLayout(styleRanges?: unknown) {
  const canvas = {
    unit: 'mm',
    widthMm: 60,
    heightMm: 20,
    width: mmToPx(60),
    height: mmToPx(20),
    dpi: DPI,
    bleed: 0,
    safeArea: 0,
    backgroundColor: '#ffffff',
  };

  return {
    version: 2,
    canvas,
    fonts: [],
    layers: [
      {
        id: 'txt',
        name: 'Tekst',
        type: 'textbox',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 0,
        x: mmToPx(30),
        y: mmToPx(10),
        width: mmToPx(56),
        height: mmToPx(16),
        rotation: 0,
        properties: {
          type: 'textbox',
          text: 'zwykly czerwony',
          fontSize: 12,
          fontUnit: 'pt',
          fontFamily: 'Arial',
          fontWeight: 400,
          fontStyle: 'normal',
          fill: '#000000',
          textAlign: 'left',
          verticalAlign: 'top',
          lineHeight: 1.2,
          padding: 0,
          backgroundColor: 'transparent',
          borderColor: 'transparent',
          borderWidth: 0,
          editable: false,
          ...(styleRanges ? { styleRanges } : {}),
        },
      },
    ],
  };
}

async function countRedPixels(png: Buffer): Promise<number> {
  const { createCanvas, loadImage } = await import('canvas');
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);

  let red = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] < 90) red += 1;
  }
  return red;
}

test('styleRanges koloruje TYLKO swoj fragment tekstu', async () => {
  const { renderPreview } = await import('../src/services/renderer/fabric-renderer.service');

  const options = {
    width: mmToPx(60),
    height: mmToPx(20),
    scale: 1,
    deviceScaleFactor: 1,
    format: 'png' as const,
  };

  const plain = await renderPreview(
    { answers: {}, templateName: 'test', layoutConfig: makeTextboxLayout() } as any,
    options
  );
  assert.equal(await countRedPixels(plain), 0, 'bez stylow nie ma czerwieni');

  // "czerwony" zaczyna sie na 7. znaku tekstu "zwykly czerwony".
  const styled = await renderPreview(
    {
      answers: {},
      templateName: 'test',
      layoutConfig: makeTextboxLayout([{ start: 7, end: 15, fill: '#ff0000' }]),
    } as any,
    options
  );

  const redPixels = await countRedPixels(styled);
  assert.ok(redPixels > 200, `oczekiwano czerwonego fragmentu, jest ${redPixels} px`);
});
