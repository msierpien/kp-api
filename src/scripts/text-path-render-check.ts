/**
 * Etap 3: pierwszy render tekstu po luku PRODUKCYJNA sciezka.
 *
 * Nie omijamy renderera: budujemy layout z warstwa `text_path` i wolamy
 * `renderPreview`, czyli dokladnie ten kod, ktory robi paczki do druku.
 * Chodzi o odpowiedz na jedno pytanie: czy wydruk wyglada jak podglad.
 */
import fs from 'fs/promises';
import path from 'path';
import { renderPreview } from '../services/renderer/fabric-renderer.service';
import { buildTextPathD, getTextPathBBox } from '@msierpien/kp-template-core';

const OUT_DIR = path.join(process.cwd(), 'storage', 'tmp');
const DPI = 300;
const WIDTH_PX = 1181; // 100 mm
const HEIGHT_PX = 1181;

function textPathLayer(
  id: string,
  overrides: Record<string, any>,
  position: { x: number; y: number }
) {
  const geometry = {
    pathShape: overrides.pathShape || 'arc',
    radiusMm: overrides.radiusMm ?? 30,
    startAngle: overrides.startAngle ?? 180,
    sweepAngle: overrides.sweepAngle ?? 180,
  };
  const box = getTextPathBBox(geometry, DPI);

  return {
    id,
    name: id,
    type: 'text_path',
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: 1,
    x: position.x,
    y: position.y,
    width: box.width,
    height: box.height,
    rotation: 0,
    properties: {
      type: 'text_path',
      pathShape: geometry.pathShape,
      radiusMm: geometry.radiusMm,
      startAngle: geometry.startAngle,
      sweepAngle: geometry.sweepAngle,
      pathSide: 'left',
      pathAlign: 'baseline',
      textPathAlign: 'center',
      pathD: buildTextPathD(geometry, DPI),
      fontSize: 20,
      fontUnit: 'pt',
      fontFamily: 'DejaVu Sans',
      fontWeight: 400,
      fontStyle: 'normal',
      fill: '#111111',
      ...overrides.properties,
    },
  };
}

async function main() {
  const layout: any = {
    version: 2,
    canvas: {
      unit: 'mm',
      widthMm: 100,
      heightMm: 100,
      width: WIDTH_PX,
      height: HEIGHT_PX,
      dpi: DPI,
      bleed: 0,
      safeArea: 0,
      backgroundColor: '#ffffff',
    },
    fonts: [],
    layers: [
      // Luk gorny - napis nad monogramem.
      textPathLayer('arc-top', { radiusMm: 30, startAngle: 180, sweepAngle: 180, properties: { text: 'ZAPRASZAMY' } }, { x: 590, y: 420 }),
      // Napis POD lukiem (druga strona krzywej).
      textPathLayer('arc-bottom', {
        radiusMm: 22,
        startAngle: 0,
        sweepAngle: 180,
        properties: { text: 'NA WESELE', pathSide: 'right' },
      }, { x: 590, y: 700 }),
      // Pelny okrag - tresc z pola formularza.
      textPathLayer('circle', {
        pathShape: 'circle',
        radiusMm: 14,
        startAngle: 180,
        properties: { fieldKey: 'para', fontSize: 11 },
      }, { x: 590, y: 560 }),
    ],
  };

  const buffer = await renderPreview(
    {
      templateName: 'text-path-check',
      templateVersion: 1,
      layoutConfig: layout,
      answers: { para: 'ANNA I JAN 2026' },
    } as any,
    { width: WIDTH_PX, height: HEIGHT_PX, scale: 1, deviceScaleFactor: 1, format: 'png' }
  );

  await fs.mkdir(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, 'render-text-path.png');
  await fs.writeFile(target, buffer);
  console.log('OK:', target, `${Math.round(buffer.length / 1024)} kB`);
}

main().catch((error) => {
  console.error('RENDER CHECK FAILED:', error);
  process.exit(1);
});
