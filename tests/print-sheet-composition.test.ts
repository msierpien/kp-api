import assert from 'node:assert/strict';
import { test } from 'node:test';

// Renderer importuje config, ktory waliduje env przy imporcie.
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

const DPI = 300;
const mmToPx = (mm: number) => Math.round((mm / 25.4) * DPI);

function makePage(id: string, name: string, widthMm: number, heightMm: number, backgroundColor: string) {
  return {
    id,
    name,
    canvas: {
      unit: 'mm',
      widthMm,
      heightMm,
      width: mmToPx(widthMm),
      height: mmToPx(heightMm),
      dpi: DPI,
      bleed: 0,
      safeArea: 0,
      backgroundColor,
    },
    layers: [],
  };
}

async function pixelAt(png: Buffer, xPx: number, yPx: number): Promise<[number, number, number]> {
  const { createCanvas, loadImage } = await import('canvas');
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(xPx, yPx, 1, 1).data;
  return [data[0], data[1], data[2]];
}

test('composePrintSheet honoruje wlasne print.placements (pozycja + obrot 90)', async () => {
  const { renderPrintSheetPng } = await import('../src/services/renderer/fabric-renderer.service');

  // Arkusz 50x20 mm. Strona 1 (czerwona, 20x20) w (0,0) bez obrotu.
  // Strona 2 (niebieska, 20x10) w (30,5) z obrotem 90 - footprint 10x20
  // wokol srodka (40,10), czyli bbox 35..45 x 0..20.
  const layout = {
    version: 2,
    canvas: makePage('page-1', 'Przod', 20, 20, '#ff0000').canvas,
    fonts: [],
    layers: [],
    pages: [
      makePage('page-1', 'Przod', 20, 20, '#ff0000'),
      makePage('page-2', 'Tyl', 20, 10, '#0000ff'),
    ],
    print: {
      sheet: { widthMm: 50, heightMm: 20 },
      placements: [
        { pageId: 'page-1', xMm: 0, yMm: 0, rotation: 0 },
        { pageId: 'page-2', xMm: 30, yMm: 5, rotation: 90 },
      ],
    },
  };

  const sheet = await renderPrintSheetPng(layout as any, {});

  assert.equal(sheet.widthMm, 50);
  assert.equal(sheet.heightMm, 20);
  assert.equal(sheet.widthPx, mmToPx(50));
  assert.equal(sheet.heightPx, mmToPx(20));

  // Srodek strony 1 -> czerwony.
  const p1 = await pixelAt(sheet.buffer, mmToPx(10), mmToPx(10));
  assert.ok(p1[0] > 200 && p1[1] < 50 && p1[2] < 50, `oczekiwano czerwieni, jest rgb(${p1})`);

  // Srodek footprintu strony 2 -> niebieski.
  const p2 = await pixelAt(sheet.buffer, mmToPx(40), mmToPx(10));
  assert.ok(p2[2] > 200 && p2[0] < 50, `oczekiwano niebieskiego, jest rgb(${p2})`);

  // (36,2) lezy w obroconym footprincie (35..45 x 0..20), ale POZA prostokatem
  // bez obrotu (30..50 x 5..15) - niebieski piksel dowodzi, ze obrot zadzialal.
  const rotated = await pixelAt(sheet.buffer, mmToPx(36), mmToPx(2));
  assert.ok(rotated[2] > 200 && rotated[0] < 50, `oczekiwano niebieskiego (obrot 90), jest rgb(${rotated})`);

  // Pusty obszar arkusza -> bialy.
  const empty = await pixelAt(sheet.buffer, mmToPx(25), mmToPx(10));
  assert.ok(empty[0] > 240 && empty[1] > 240 && empty[2] > 240, `oczekiwano bieli, jest rgb(${empty})`);
});
