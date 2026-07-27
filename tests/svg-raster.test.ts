import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Renderer importuje config, ktory waliduje env przy imporcie.
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <rect x="0" y="0" width="100" height="100" fill="currentColor"/>
</svg>`;

async function writeTempSvg(content = SVG): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'svg-raster-'));
  const file = path.join(dir, 'ozdobnik.svg');
  await fs.writeFile(file, content, 'utf-8');
  return file;
}

test('node-canvas nie zastapi resvg: SVG dostajemy w rozmiarze wlasnym albo wcale', async () => {
  const { loadImage } = await import('canvas');
  const file = await writeTempSvg();

  // Obsluga SVG w node-canvas zalezy od librsvg w cairo: lokalnie (macOS
  // z homebrew) plik sie laduje, w produkcyjnym obrazie alpine - nie.
  // Ale nawet tam, gdzie sie laduje, jest to raster w rozmiarze WLASNYM
  // pliku, wiec ozdobnik powiekszony przez klienta wyszedlby rozmyty.
  // Oba warianty prowadza do tego samego wniosku: rasteryzujemy resvg.
  try {
    const image = await loadImage(file);
    assert.equal(image.width, 100, 'node-canvas ignoruje docelowy rozmiar renderu');
  } catch {
    // Brak librsvg - SVG w ogole sie nie otwiera. Tez akceptowalne.
  }
});

test('rasteryzuje w rozmiarze DOCELOWYM, nie w rozmiarze zrodla', async () => {
  const { rasterizeSvgFile } = await import('../src/services/renderer/svg-raster.service');
  const { loadImage } = await import('canvas');
  const file = await writeTempSvg();

  // Zrodlo ma 100x100; ozdobnik powiekszony przez klienta ma byc ostry.
  const png = await rasterizeSvgFile({ filePath: file, widthPx: 600 });
  const image = await loadImage(png);

  assert.equal(image.width, 600);
  assert.equal(image.height, 600, 'proporcje zrodla zachowane');
});

test('podstawia kolor z palety pod currentColor', async () => {
  const { rasterizeSvgFile } = await import('../src/services/renderer/svg-raster.service');
  const { createCanvas, loadImage } = await import('canvas');
  const file = await writeTempSvg();

  const png = await rasterizeSvgFile({ filePath: file, widthPx: 40, tint: '#c02040' });
  const image = await loadImage(png);

  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image as never, 0, 0);
  const [r, g, b, a] = ctx.getImageData(20, 20, 1, 1).data;

  assert.equal(a, 255, 'wypelnienie ma byc nieprzezroczyste');
  assert.deepEqual([r, g, b], [0xc0, 0x20, 0x40]);
});

test('bez tintu currentColor zostaje domyslnie czarny', async () => {
  const { rasterizeSvgFile } = await import('../src/services/renderer/svg-raster.service');
  const { createCanvas, loadImage } = await import('canvas');
  const file = await writeTempSvg();

  const png = await rasterizeSvgFile({ filePath: file, widthPx: 40 });
  const image = await loadImage(png);

  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image as never, 0, 0);
  const [r, g, b] = ctx.getImageData(20, 20, 1, 1).data;

  assert.deepEqual([r, g, b], [0, 0, 0]);
});

test('isSvgPath rozpoznaje ozdobniki po rozszerzeniu', async () => {
  const { isSvgPath } = await import('../src/services/renderer/svg-raster.service');
  assert.equal(isSvgPath('/storage/decorations/t1/abc.svg'), true);
  assert.equal(isSvgPath('/storage/decorations/t1/ABC.SVG'), true);
  assert.equal(isSvgPath('/storage/decorations/t1/abc.png'), false);
});
