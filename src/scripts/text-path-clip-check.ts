/**
 * Diagnoza: dlaczego tekst po luku jest przycinany do prostokata.
 *
 * Hipoteza: fabric rysuje obiekt na cache canvas o rozmiarze jego bboksu,
 * a glify stojace prostopadle do krzywej wystaja poza bbox SCIEZKI -
 * i to, co wystaje, jest ucinane.
 */
import fs from 'fs/promises';
import path from 'path';
import { IText, Path, StaticCanvas } from 'fabric/node';
import { buildTextPathD, getTextPathAnchorOffset } from '@msierpien/kp-template-core';

const OUT_DIR = path.join(process.cwd(), 'storage', 'tmp');
const DPI = 300;
const GEO = { pathShape: 'arc' as const, radiusMm: 25, startAngle: 180, sweepAngle: 180 };

async function render(name: string, extra: Record<string, unknown>) {
  const canvas = new StaticCanvas(undefined, { width: 900, height: 700, backgroundColor: '#ffffff' });
  const d = buildTextPathD(GEO, DPI);
  const anchor = getTextPathAnchorOffset(GEO, DPI);

  const text = new IText('ZAPRASZAMY', {
    path: new Path(d, { fill: '', stroke: '' } as any),
    pathSide: 'left',
    pathAlign: 'baseline',
    left: 450 + anchor.dx,
    top: 400 + anchor.dy,
    originX: 'center',
    originY: 'center',
    fontSize: 80,
    fontFamily: 'DejaVu Sans',
    fill: '#111111',
    ...extra,
  } as any);

  canvas.add(text as any);
  canvas.renderAll();

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, `${name}.png`), (canvas as any).getNodeCanvas().toBuffer('image/png'));

  const t = text as any;
  return { name, width: Math.round(t.width), height: Math.round(t.height), caching: t.objectCaching };
}

async function main() {
  console.log(JSON.stringify([
    await render('clip-default', {}),
    await render('clip-nocache', { objectCaching: false }),
  ], null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
