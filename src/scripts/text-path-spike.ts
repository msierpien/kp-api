/**
 * Etap 0 planu "tekst po luku": czy fabric/node rysuje IText po sciezce
 * i co raportuje jako wymiary obiektu.
 *
 * Uruchomienie: node --import tsx src/scripts/text-path-spike.ts
 * Wynik: PNG w storage/tmp + wypis metryk do porownania z przegladarka.
 */
import fs from 'fs/promises';
import path from 'path';
import { IText, Path, StaticCanvas, FabricText } from 'fabric/node';

const OUT_DIR = path.join(process.cwd(), 'storage', 'tmp');

/** Luk gorny: promien 100, od 180 do 360 stopni (czyli gora okregu). */
const ARC_D = 'M -100 0 A 100 100 0 0 1 100 0';

/** Pelny okrag jako DWA luki po 180 - jeden `A` na 360 stopni sie degeneruje. */
const CIRCLE_D = 'M -100 0 A 100 100 0 0 1 100 0 A 100 100 0 0 1 -100 0';

async function render(name: string, d: string, options: Record<string, unknown>) {
  const canvas = new StaticCanvas(undefined, { width: 600, height: 400, backgroundColor: '#ffffff' });

  const pathObject = new Path(d, { fill: '', stroke: '' });
  const text = new IText('ZAPRASZAMY', {
    path: pathObject,
    left: 300,
    top: 200,
    originX: 'center',
    originY: 'center',
    fontSize: 28,
    fontFamily: 'DejaVu Sans',
    fill: '#111111',
    ...options,
  } as any);

  canvas.add(text as any);
  canvas.renderAll();

  // Tak samo jak produkcyjny renderer: bufor bierzemy z node-canvas pod spodem.
  const buffer = (canvas as any).getNodeCanvas().toBuffer('image/png');
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(path.join(OUT_DIR, `${name}.png`), buffer);

  const anyText = text as any;
  return {
    name,
    width: Math.round(anyText.width),
    height: Math.round(anyText.height),
    scaledWidth: Math.round(anyText.getScaledWidth()),
    scaledHeight: Math.round(anyText.getScaledHeight()),
    left: Math.round(anyText.left),
    top: Math.round(anyText.top),
    pathBBox: (() => {
      const box = pathObject.getBoundingRect();
      return {
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    })(),
  };
}

async function main() {
  const results = [];

  results.push(await render('arc-baseline-left', ARC_D, { pathSide: 'left', pathAlign: 'baseline' }));
  results.push(await render('arc-baseline-right', ARC_D, { pathSide: 'right', pathAlign: 'baseline' }));
  results.push(await render('arc-center', ARC_D, { pathSide: 'left', pathAlign: 'center' }));
  results.push(await render('circle-full', CIRCLE_D, { pathSide: 'left', pathAlign: 'baseline' }));
  results.push(
    await render('arc-offset', ARC_D, { pathSide: 'left', pathAlign: 'baseline', pathStartOffset: 60 })
  );

  // Szerokosc napisu BEZ sciezki - do policzenia offsetu wysrodkowania.
  const plain = new FabricText('ZAPRASZAMY', { fontSize: 28, fontFamily: 'DejaVu Sans' } as any);

  console.log(JSON.stringify({ results, plainTextWidth: Math.round((plain as any).width) }, null, 2));
  console.log('\nPNG w:', OUT_DIR);
}

main().catch((error) => {
  console.error('SPIKE FAILED:', error);
  process.exit(1);
});
