// MUSI byc pierwszy - ustawia env, zanim zaladuje sie config.
import './helpers/test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { templateLayoutSchema } from '../src/schemas/admin.schema';

/**
 * Skladanie do druku przechodzi przez `z.object`, ktory po cichu usuwa klucze
 * spoza schematu. Dokladnie tak znikaly juz w tym projekcie inne pola, wiec
 * round-trip ma tu swoj test.
 */
function layoutWithPrint(print: unknown) {
  return {
    version: 2 as const,
    canvas: { width: 1240, height: 591, dpi: 300, unit: 'mm' as const, widthMm: 105, heightMm: 50 },
    fonts: [],
    layers: [],
    pages: [
      {
        id: 'page-1',
        name: 'Przód',
        canvas: { width: 1240, height: 591, dpi: 300, unit: 'mm' as const, widthMm: 105, heightMm: 50 },
        layers: [],
      },
      {
        id: 'page-2',
        name: 'Tył',
        canvas: { width: 1240, height: 591, dpi: 300, unit: 'mm' as const, widthMm: 105, heightMm: 50 },
        layers: [],
      },
    ],
    print,
  };
}

test('skladanie do druku przezywa zapis (nie jest wycinane przez schemat)', () => {
  const print = {
    sheet: { widthMm: 105, heightMm: 100 },
    placements: [
      { pageId: 'page-1', xMm: 0, yMm: 0, rotation: 180 },
      { pageId: 'page-2', xMm: 0, yMm: 50, rotation: 0 },
    ],
  };

  const result = templateLayoutSchema.safeParse(layoutWithPrint(print));

  assert.equal(result.success, true, JSON.stringify(result.success ? null : result.error.issues));
  assert.deepEqual(result.success && result.data.print, print);
});

test('kazdy dozwolony obrot przechodzi', () => {
  for (const rotation of [0, 90, 180, 270]) {
    const result = templateLayoutSchema.safeParse(
      layoutWithPrint({
        sheet: { widthMm: 105, heightMm: 100 },
        placements: [{ pageId: 'page-1', xMm: 0, yMm: 0, rotation }],
      })
    );
    assert.equal(result.success, true, `obrot ${rotation}`);
  }
});

test('obrot jako TEKST jest odrzucany - typowy blad przy selekcie w formularzu', () => {
  const result = templateLayoutSchema.safeParse(
    layoutWithPrint({
      sheet: { widthMm: 105, heightMm: 100 },
      placements: [{ pageId: 'page-1', xMm: 0, yMm: 0, rotation: '180' }],
    })
  );

  assert.equal(result.success, false);
});

test('brak skladania jest poprawny - oznacza domyslne ulozenie stron', () => {
  const layout = layoutWithPrint(undefined);
  delete (layout as Record<string, unknown>).print;

  const result = templateLayoutSchema.safeParse(layout);

  assert.equal(result.success, true);
  assert.equal(result.success && result.data.print, undefined);
});
