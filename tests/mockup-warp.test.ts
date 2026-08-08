import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drawImageInQuad, quadToPixels, squareToQuad, type Quad } from '../src/lib/mockup-warp';

const quad: Quad = [
  { x: 100, y: 60 },
  { x: 500, y: 20 },
  { x: 520, y: 380 },
  { x: 80, y: 300 },
];

test('homografia odwzorowuje rogi kwadratu jednostkowego na rogi czworokata', () => {
  const map = squareToQuad(quad);
  const corners: Array<[number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];

  corners.forEach(([u, v], index) => {
    const point = map(u, v);
    assert.ok(Math.abs(point.x - quad[index].x) < 1e-6, `rog ${index}: x ${point.x}`);
    assert.ok(Math.abs(point.y - quad[index].y) < 1e-6, `rog ${index}: y ${point.y}`);
  });
});

test('perspektywa: srodek projektu nie jest srednia rogow', () => {
  const map = squareToQuad(quad);
  const center = map(0.5, 0.5);
  const average = {
    x: quad.reduce((sum, p) => sum + p.x, 0) / 4,
    y: quad.reduce((sum, p) => sum + p.y, 0) / 4,
  };

  // Przy zbieznych bokach punkt zbiegu przesuwa srodek - gdyby kod robil samo
  // bilinearne mieszanie rogow, obie wartosci bylyby identyczne.
  const distance = Math.hypot(center.x - average.x, center.y - average.y);
  assert.ok(distance > 0.5, `oczekiwano przesuniecia srodka, jest ${distance.toFixed(3)} px`);
});

test('rownoleglobok sprowadza sie do mapy afinicznej', () => {
  const parallelogram: Quad = [
    { x: 0, y: 0 },
    { x: 100, y: 20 },
    { x: 120, y: 120 },
    { x: 20, y: 100 },
  ];
  const map = squareToQuad(parallelogram);
  const center = map(0.5, 0.5);

  assert.ok(Math.abs(center.x - 60) < 1e-6, `x ${center.x}`);
  assert.ok(Math.abs(center.y - 60) < 1e-6, `y ${center.y}`);
});

test('quadToPixels skaluje rogi znormalizowane do rozmiaru zdjecia', () => {
  const normalized: Quad = [
    { x: 0.1, y: 0.2 },
    { x: 0.9, y: 0.2 },
    { x: 0.9, y: 0.8 },
    { x: 0.1, y: 0.8 },
  ];
  const pixels = quadToPixels(normalized, 1000, 500);

  assert.deepEqual(pixels[0], { x: 100, y: 100 });
  assert.deepEqual(pixels[2], { x: 900, y: 400 });
});

test('drawImageInQuad rysuje projekt w obrysie i respektuje multiply', async () => {
  const { createCanvas } = await import('canvas');

  // Zdjecie: szare tlo. Projekt: bialy prostokat z czarnym paskiem w srodku.
  const photo = createCanvas(400, 300);
  const photoCtx = photo.getContext('2d');
  photoCtx.fillStyle = '#808080';
  photoCtx.fillRect(0, 0, 400, 300);

  const design = createCanvas(200, 100);
  const designCtx = design.getContext('2d');
  designCtx.fillStyle = '#ffffff';
  designCtx.fillRect(0, 0, 200, 100);
  designCtx.fillStyle = '#000000';
  designCtx.fillRect(0, 40, 200, 20);

  const target: Quad = [
    { x: 100, y: 100 },
    { x: 300, y: 80 },
    { x: 300, y: 220 },
    { x: 100, y: 200 },
  ];

  drawImageInQuad(photoCtx, design as any, target, { subdivisions: 12, blendMode: 'multiply' });

  const pixel = (x: number, y: number) => {
    const data = photoCtx.getImageData(x, y, 1, 1).data;
    return [data[0], data[1], data[2]];
  };

  // Poza obrysem zdjecie zostaje nietkniete.
  const outside = pixel(20, 20);
  assert.deepEqual(outside, [128, 128, 128]);

  // Bialy obszar projektu przy multiply nie zmienia zdjecia (biel = identycznosc).
  const white = pixel(200, 110);
  assert.ok(Math.abs(white[0] - 128) <= 2, `bialy obszar: rgb(${white})`);

  // Czarny pasek zaciemnia zdjecie.
  const stripe = pixel(200, 150);
  assert.ok(stripe[0] < 20, `pasek powinien byc ciemny, jest rgb(${stripe})`);
});

test('multiply nie zostawia siatki na jednolitym projekcie', async () => {
  const { createCanvas } = await import('canvas');

  // Bialy podklad i jednolicie szary projekt: po `multiply` caly obrys ma byc
  // dokladnie taki sam. Trojkaty siatki celowo zachodza na siebie o ulamek
  // piksela - mieszane pojedynczo, kazde zachodzenie liczylo sie dwa razy
  // i na projekcie pojawiala sie siatka ciemniejszych kresek (widoczna na
  // ilustracji, nigdy na bieli).
  const photo = createCanvas(400, 300);
  const photoCtx = photo.getContext('2d');
  photoCtx.fillStyle = '#ffffff';
  photoCtx.fillRect(0, 0, 400, 300);

  const design = createCanvas(200, 100);
  const designCtx = design.getContext('2d');
  designCtx.fillStyle = '#c0c0c0';
  designCtx.fillRect(0, 0, 200, 100);

  const target: Quad = [
    { x: 100, y: 100 },
    { x: 300, y: 80 },
    { x: 300, y: 220 },
    { x: 100, y: 200 },
  ];

  drawImageInQuad(photoCtx, design as any, target, { subdivisions: 16, blendMode: 'multiply' });

  // Probka z wnetrza obrysu, z zapasem od krawedzi (tam antyaliasing miesza
  // projekt z tlem i roznice sa oczekiwane).
  const sample = photoCtx.getImageData(140, 120, 120, 60).data;
  let min = 255;
  let max = 0;
  for (let index = 0; index < sample.length; index += 4) {
    min = Math.min(min, sample[index]);
    max = Math.max(max, sample[index]);
  }

  // Prog z zapasem na wygladzone krawedzie komorek siatki - te zostawiaja
  // pojedyncze poziomy roznicy. Artefakt, ktory ten test pilnuje, byl o rzad
  // wielkosci wiekszy (szwy schodzily z 192 do 97).
  assert.ok(max - min <= 6, `jednolity projekt powinien wyjsc jednolicie, jest ${min}..${max}`);
});
