import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

/**
 * Figury do niedawna wpadaly w `return null` na koncu `layerToFabricObject`:
 * warstwa byla w szablonie, przechodzila walidacje zapisu i znikala z wydruku
 * bez zadnego bledu. Te testy pilnuja, zeby cisza sie nie powtorzyla - kazdy
 * sprawdza piksele w konkretnym miejscu kartki, a nie sam fakt renderowania.
 */

const DPI = 300;
const CARD_MM = { width: 60, height: 40 };
const mmToPx = (mm: number) => Math.round((mm / 25.4) * DPI);

type ShapeOverrides = Record<string, unknown>;

function makeShapeLayout(properties: ShapeOverrides, geometry: ShapeOverrides = {}) {
  return {
    version: 2,
    canvas: {
      unit: 'mm',
      widthMm: CARD_MM.width,
      heightMm: CARD_MM.height,
      width: mmToPx(CARD_MM.width),
      height: mmToPx(CARD_MM.height),
      dpi: DPI,
      bleed: 0,
      safeArea: 0,
      backgroundColor: '#ffffff',
    },
    fonts: [],
    layers: [
      {
        id: 'figura',
        name: 'Figura',
        type: 'shape',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 0,
        x: mmToPx(CARD_MM.width / 2),
        y: mmToPx(CARD_MM.height / 2),
        width: mmToPx(30),
        height: mmToPx(20),
        rotation: 0,
        ...geometry,
        properties: {
          type: 'shape',
          shapeType: 'rectangle',
          fill: 'transparent',
          stroke: '#000000',
          strokeWidth: 1,
          borderRadius: 0,
          ...properties,
        },
      },
    ],
  };
}

async function readPixels(png: Buffer) {
  const { createCanvas, loadImage } = await import('canvas');
  const img = await loadImage(png);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);

  const at = (x: number, y: number) => {
    const index = (Math.round(y) * img.width + Math.round(x)) * 4;
    return [data[index], data[index + 1], data[index + 2]] as [number, number, number];
  };

  const isRed = ([r, g, b]: [number, number, number]) => r > 180 && g < 90 && b < 90;

  let red = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (isRed([data[i], data[i + 1], data[i + 2]])) red += 1;
  }

  return { at, isRed, redCount: red, width: img.width, height: img.height };
}

async function render(layout: unknown) {
  const { renderPreview } = await import('../src/services/renderer/fabric-renderer.service');

  return renderPreview(
    { answers: {}, templateName: 'test', layoutConfig: layout } as any,
    {
      width: mmToPx(CARD_MM.width),
      height: mmToPx(CARD_MM.height),
      scale: 1,
      deviceScaleFactor: 1,
      format: 'png' as const,
    }
  );
}

describe('renderowanie figur', () => {
  test('wypelniony prostokat maluje wnetrze i zostawia tlo poza soba', async () => {
    const png = await render(makeShapeLayout({ fill: '#ff0000', strokeWidth: 0 }));
    const { at, isRed, redCount } = await readPixels(png);

    const center = { x: mmToPx(CARD_MM.width / 2), y: mmToPx(CARD_MM.height / 2) };
    assert.ok(isRed(at(center.x, center.y)), 'srodek prostokata ma byc czerwony');

    // Prostokat 30x20 mm na kartce 60x40 mm - rog kartki musi zostac bialy.
    assert.deepEqual(at(5, 5), [255, 255, 255], 'tlo poza figura ma zostac biale');

    // 30 x 20 mm przy 300 dpi to ~354 x 236 px, czyli ~83 tys. pikseli.
    assert.ok(redCount > 70_000, `oczekiwano wypelnionego prostokata, jest ${redCount} px`);
  });

  test('ramka bez wypelnienia maluje tylko obrys', async () => {
    const png = await render(
      makeShapeLayout({ fill: 'transparent', stroke: '#ff0000', strokeWidthMm: 1 })
    );
    const { at, isRed, redCount } = await readPixels(png);

    const center = { x: mmToPx(CARD_MM.width / 2), y: mmToPx(CARD_MM.height / 2) };
    assert.ok(!isRed(at(center.x, center.y)), 'wnetrze ramki ma zostac puste');

    // Gorna krawedz figury: 20 mm wysokosci, wiec 10 mm nad srodkiem kartki.
    const topEdge = mmToPx(CARD_MM.height / 2 - 10);
    assert.ok(isRed(at(center.x, topEdge)), 'krawedz ramki ma byc narysowana');

    // Sam obrys 1 mm dokola prostokata 30x20 mm to rzad kilkunastu tysiecy px,
    // czyli wyraznie mniej niz wypelnienie z testu wyzej.
    assert.ok(redCount > 5_000 && redCount < 40_000, `obrys ma ${redCount} px`);
  });

  test('kreska idzie przez srodek warstwy, a rotacja stawia ja w pionie', async () => {
    const lineProps = { shapeType: 'line', stroke: '#ff0000', strokeWidthMm: 2 };
    const center = { x: mmToPx(CARD_MM.width / 2), y: mmToPx(CARD_MM.height / 2) };

    const horizontal = await readPixels(
      await render(makeShapeLayout(lineProps, { height: mmToPx(2) }))
    );
    assert.ok(horizontal.isRed(horizontal.at(center.x, center.y)), 'srodek kreski');
    // 15 mm w lewo od srodka to jeszcze kreska (dlugosc 30 mm), 5 mm wyzej juz nie.
    assert.ok(horizontal.isRed(horizontal.at(mmToPx(CARD_MM.width / 2 - 14), center.y)));
    assert.ok(!horizontal.isRed(horizontal.at(center.x, mmToPx(CARD_MM.height / 2 - 5))));

    const vertical = await readPixels(
      await render(makeShapeLayout(lineProps, { height: mmToPx(2), rotation: 90 }))
    );
    // Po obrocie jest odwrotnie: kreska idzie w gore, a nie w bok.
    assert.ok(vertical.isRed(vertical.at(center.x, mmToPx(CARD_MM.height / 2 - 5))));
    assert.ok(!vertical.isRed(vertical.at(mmToPx(CARD_MM.width / 2 - 14), center.y)));
  });

  test('kolo jest kolem takze wtedy, gdy ramka warstwy jest prostokatna', async () => {
    const png = await render(
      makeShapeLayout({ shapeType: 'circle', fill: '#ff0000', strokeWidth: 0 })
    );
    const { at, isRed } = await readPixels(png);

    const center = { x: mmToPx(CARD_MM.width / 2), y: mmToPx(CARD_MM.height / 2) };
    assert.ok(isRed(at(center.x, center.y)), 'srodek kola');

    // Warstwa ma 30x20 mm, wiec kolo trzyma sie krotszego boku: promien 10 mm.
    // 9 mm w bok jest jeszcze w kole, 13 mm juz poza nim - mimo ze ramka
    // warstwy siega tam 15 mm.
    assert.ok(isRed(at(mmToPx(CARD_MM.width / 2 + 9), center.y)), 'wnetrze kola');
    assert.ok(!isRed(at(mmToPx(CARD_MM.width / 2 + 13), center.y)), 'poza kolem');
  });

  test('kreskowanie zostawia przerwy - linia przerywana ma mniej pikseli', async () => {
    const solid = await readPixels(
      await render(
        makeShapeLayout(
          { shapeType: 'line', stroke: '#ff0000', strokeWidthMm: 1 },
          { height: mmToPx(1) }
        )
      )
    );

    const strokeWidthPx = (1 / 25.4) * DPI;
    const dashed = await readPixels(
      await render(
        makeShapeLayout(
          {
            shapeType: 'line',
            stroke: '#ff0000',
            strokeWidthMm: 1,
            strokeDashArray: [strokeWidthPx * 3, strokeWidthPx * 2],
          },
          { height: mmToPx(1) }
        )
      )
    );

    assert.ok(dashed.redCount > 0, 'kreskowana linia ma byc widoczna');
    assert.ok(
      dashed.redCount < solid.redCount * 0.8,
      `kreskowana (${dashed.redCount} px) ma miec wyrazne przerwy wobec ciaglej (${solid.redCount} px)`
    );
  });

  test('ukryta warstwa nie trafia na wydruk', async () => {
    const png = await render(
      makeShapeLayout({ fill: '#ff0000', strokeWidth: 0 }, { visible: false })
    );
    const { redCount } = await readPixels(png);

    assert.equal(redCount, 0);
  });
});
