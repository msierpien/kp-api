/**
 * Weryfikacja krzyzowa pakiet <-> fabric.
 *
 * Sprawdza, czy `d` i wymiary policzone w `@msierpien/kp-template-core`
 * zgadzaja sie z tym, co fabric faktycznie rysuje. To jedyna bariera przed
 * rozjazdem geometrii miedzy edytorem i wydrukiem - jesli tu pojawi sie
 * roznica, wynik bedzie widoczny na papierze i po fakcie.
 *
 * Pakiet czytamy z dist lokalnego repo, bo wersja 0.5.0 nie jest jeszcze
 * opublikowana w rejestrze.
 */
import fs from 'fs/promises';
import path from 'path';
import { IText, Path, StaticCanvas, FabricText } from 'fabric/node';

import {
  buildTextPathD,
  getTextPathArcLength,
  getTextPathAnchorOffset,
  getTextPathBBox,
  resolveTextPathStartOffset,
} from '@msierpien/kp-template-core';

const OUT_DIR = path.join(process.cwd(), 'storage', 'tmp');
const DPI = 300;

interface Case {
  name: string;
  props: { pathShape: 'arc' | 'circle'; radiusMm: number; startAngle: number; sweepAngle: number };
  text: string;
}

const CASES: Case[] = [
  { name: 'contract-arc-top', props: { pathShape: 'arc', radiusMm: 30, startAngle: 180, sweepAngle: 180 }, text: 'ZAPRASZAMY' },
  { name: 'contract-arc-bottom', props: { pathShape: 'arc', radiusMm: 30, startAngle: 0, sweepAngle: 180 }, text: 'NA WESELE' },
  { name: 'contract-arc-270', props: { pathShape: 'arc', radiusMm: 25, startAngle: 135, sweepAngle: 270 }, text: 'ANNA I JAN' },
  { name: 'contract-circle', props: { pathShape: 'circle', radiusMm: 25, startAngle: 180, sweepAngle: 360 }, text: 'ANNA I JAN 2026' },
];

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const report: any[] = [];
  let mismatches = 0;

  for (const testCase of CASES) {
    const d = buildTextPathD(testCase.props, DPI);
    const expectedBBox = getTextPathBBox(testCase.props, DPI);
    const expectedArc = getTextPathArcLength(testCase.props, DPI);
    const anchor = getTextPathAnchorOffset(testCase.props, DPI);

    // Fabric: bbox sciezki liczony przez sama biblioteke.
    const probe = new Path(d, { fill: '', stroke: '' } as any);
    const fabricBox = probe.getBoundingRect();

    const fontSize = 40;
    const plain = new FabricText(testCase.text, { fontSize, fontFamily: 'DejaVu Sans' } as any) as any;
    const startOffset = resolveTextPathStartOffset('center', expectedArc, plain.width);

    // Rysunek kontrolny: srodek okregu celowo w (300, 300).
    const canvas = new StaticCanvas(undefined, { width: 600, height: 600, backgroundColor: '#ffffff' });

    const guide = new Path(d, {
      fill: '',
      stroke: '#ff00aa',
      strokeWidth: 1,
      left: 300 + anchor.dx,
      top: 300 + anchor.dy,
      originX: 'center',
      originY: 'center',
    } as any);
    canvas.add(guide as any);

    // Znacznik zadanego srodka okregu - ma wypasc w geometrycznym srodku luku.
    canvas.add(new Path('M -8 0 L 8 0 M 0 -8 L 0 8', {
      fill: '', stroke: '#00aa55', strokeWidth: 1,
      left: 300, top: 300, originX: 'center', originY: 'center',
    } as any) as any);

    canvas.add(new IText(testCase.text, {
      path: new Path(d, { fill: '', stroke: '' } as any),
      pathSide: 'left',
      pathAlign: 'baseline',
      pathStartOffset: startOffset,
      left: 300 + anchor.dx,
      top: 300 + anchor.dy,
      originX: 'center',
      originY: 'center',
      fontSize,
      fontFamily: 'DejaVu Sans',
      fill: '#111111',
    } as any) as any);

    canvas.renderAll();
    await fs.writeFile(
      path.join(OUT_DIR, `${testCase.name}.png`),
      (canvas as any).getNodeCanvas().toBuffer('image/png')
    );

    // Tolerancja 2 px: fabric dolicza polowe grubosci obrysu do bboksu.
    const widthDiff = Math.abs(fabricBox.width - expectedBBox.width);
    const heightDiff = Math.abs(fabricBox.height - expectedBBox.height);
    const ok = widthDiff <= 2 && heightDiff <= 2;
    if (!ok) mismatches += 1;

    report.push({
      name: testCase.name,
      d,
      arcLengthFromPackage: expectedArc,
      anchor,
      bboxPackage: { w: expectedBBox.width, h: expectedBBox.height },
      bboxFabric: { w: Math.round(fabricBox.width), h: Math.round(fabricBox.height) },
      diff: { width: Math.round(widthDiff), height: Math.round(heightDiff) },
      textWidth: Math.round(plain.width),
      startOffset,
      match: ok,
    });
  }

  console.log(JSON.stringify(report, null, 2));
  console.log(mismatches === 0 ? '\nKONTRAKT OK: pakiet zgadza sie z fabric' : `\nROZJAZD w ${mismatches} przypadkach`);
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('CONTRACT CHECK FAILED:', error);
  process.exit(1);
});
