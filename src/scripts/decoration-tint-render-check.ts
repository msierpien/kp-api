/**
 * Ozdobnik w szablonie: czy wydruk wyglada jak podglad.
 *
 * Trzy warstwy obok siebie na jednym arkuszu, wszystkie z tego samego pliku:
 * bez `tint` (barwy z pliku), z wlasnym hexem i z `currentColor`, ktory ma
 * wziac kolor wiodacy projektu. Nie omijamy renderera - wolamy `renderPreview`,
 * czyli ten sam kod, ktory robi paczki do druku.
 *
 * Uruchomienie (bez bazy):
 *   pnpm tsx src/scripts/decoration-tint-render-check.ts
 */
import fs from 'fs/promises';
import path from 'path';
import { renderPreview } from '../services/renderer/fabric-renderer.service';
import { config } from '../config';

const OUT_DIR = path.join(process.cwd(), 'storage', 'tmp');
const DPI = 300;
const WIDTH_PX = 1181; // 100 mm
const HEIGHT_PX = 591; // 50 mm

/** Ozdobnik z twardym wypelnieniem, juz przygotowany do przebarwiania. */
const ARTWORK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">
  <path fill="currentColor" d="M50 20 C30 20 20 40 35 50 C20 60 30 80 50 80 C70 80 80 60 65 50 C80 40 70 20 50 20 Z"/>
  <circle fill="currentColor" cx="50" cy="50" r="8"/>
</svg>`;

function imageLayer(id: string, x: number, tint?: string) {
  return {
    id,
    name: id,
    type: 'image',
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: 1,
    x,
    y: Math.round(HEIGHT_PX / 2),
    width: 300,
    height: 300,
    rotation: 0,
    properties: {
      type: 'image',
      imageUrl: 'tmp/decoration-tint-check.svg',
      fit: 'contain',
      lockAspectRatio: true,
      ...(tint ? { tint } : {}),
    },
  };
}

async function main() {
  await fs.mkdir(path.join(config.storage.path, 'tmp'), { recursive: true });
  await fs.writeFile(
    path.join(config.storage.path, 'tmp', 'decoration-tint-check.svg'),
    ARTWORK,
    'utf-8'
  );

  const layout = {
    version: 2,
    canvas: {
      width: 100,
      height: 50,
      unit: 'mm',
      dpi: DPI,
      bleed: 0,
      safeArea: 0,
      backgroundColor: '#ffffff',
    },
    fonts: [],
    // Kolor wiodacy projektu - warstwa z `currentColor` ma go przejac.
    primaryColor: '#8a1538',
    layers: [
      imageLayer('bez-tintu', 200),
      imageLayer('wlasny-hex', 590, '#1e6b3a'),
      imageLayer('kolor-wiodacy', 980, 'currentColor'),
    ],
  };

  const buffer = await renderPreview(
    {
      templateName: 'decoration-tint-check',
      templateVersion: 1,
      layoutConfig: layout,
      answers: {},
    } as any,
    { width: WIDTH_PX, height: HEIGHT_PX, scale: 1, deviceScaleFactor: 1, format: 'png' }
  );

  await fs.mkdir(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, 'render-decoration-tint.png');
  await fs.writeFile(target, buffer);
  console.log('OK:', target, `${Math.round(buffer.length / 1024)} kB`);
  console.log('Oczekiwane, od lewej: czern (currentColor bez podstawienia),');
  console.log('zielen #1e6b3a (wlasny hex), bordo #8a1538 (kolor wiodacy).');
}

main().catch((error) => {
  console.error('RENDER CHECK FAILED:', error);
  process.exit(1);
});
