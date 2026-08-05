import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sanitizeLayoutOperations } from '../src/services/ai/layout-operations';
import type { EditorLayer } from '../src/schemas/ai-editor.schema';

/**
 * Odpowiedz modelu wraca do przegladarki klienta i steruje jego projektem,
 * a prompt zawiera tresci wpisane przez osoby trzecie (imiona gosci). Te
 * testy pilnuja, ze nic spoza zamknietego zbioru operacji nie przechodzi
 * i ze zadna z nich nie wyprowadzi elementu poza arkusz.
 */

const PAGE = { widthMm: 100, heightMm: 210, safeAreaMm: 5 };

function layer(overrides: Partial<EditorLayer> = {}): EditorLayer {
  return {
    id: 'napis',
    type: 'static_text',
    name: 'Napis',
    xMm: 50,
    yMm: 100,
    widthMm: 60,
    heightMm: 20,
    fontSize: 32,
    ...overrides,
  };
}

describe('sanitizeLayoutOperations', () => {
  it('przepuszcza poprawna zmiane geometrii', () => {
    const result = sanitizeLayoutOperations({
      operations: [{ op: 'setGeometry', layerId: 'napis', x: 50, y: 120 }],
      layers: [layer()],
      page: PAGE,
    });

    assert.equal(result.rejected.length, 0);
    assert.deepEqual(result.operations, [{ op: 'setGeometry', layerId: 'napis', x: 50, y: 120 }]);
  });

  it('odrzuca operacje na nieistniejacej warstwie', () => {
    const result = sanitizeLayoutOperations({
      operations: [{ op: 'setGeometry', layerId: 'wymyslona', x: 50 }],
      layers: [layer()],
      page: PAGE,
    });

    assert.equal(result.operations.length, 0);
    assert.match(result.rejected[0].reason, /nie istnieje/i);
  });

  it('odrzuca nieznana operacje', () => {
    const result = sanitizeLayoutOperations({
      operations: [{ op: 'deleteEverything', layerId: 'napis' }],
      layers: [layer()],
      page: PAGE,
    });

    assert.equal(result.operations.length, 0);
    assert.equal(result.rejected.length, 1);
  });

  it('nie pozwala ruszac warstw technicznych szablonu', () => {
    const result = sanitizeLayoutOperations({
      operations: [{ op: 'setVisibility', layerId: 'tlo', visible: false }],
      layers: [layer({ id: 'tlo', type: 'background' })],
      page: PAGE,
    });

    assert.equal(result.operations.length, 0);
    assert.match(result.rejected[0].reason, /techniczna/i);
  });

  it('przycina pozycje do arkusza z zachowaniem marginesu', () => {
    // Kotwica jest w SRODKU warstwy: przy szerokosci 60 mm i marginesie 5 mm
    // srodek nie moze zejsc ponizej 35 mm ani powyzej 65 mm.
    const result = sanitizeLayoutOperations({
      operations: [{ op: 'setGeometry', layerId: 'napis', x: 0, y: 9999 }],
      layers: [layer()],
      page: PAGE,
    });

    const [operation] = result.operations as Array<{ x: number; y: number }>;
    assert.equal(operation.x, 35);
    assert.equal(operation.y, 195);
  });

  it('trzyma rozmiar pisma w granicach szablonu', () => {
    const result = sanitizeLayoutOperations({
      operations: [{ op: 'setStyle', layerId: 'napis', fontSize: 400 }],
      layers: [layer({ fontSize: 32 })],
      page: PAGE,
    });

    const [operation] = result.operations as Array<{ fontSize: number }>;
    // Gorna granica to dwukrotnosc rozmiaru z szablonu.
    assert.equal(operation.fontSize, 64);
  });

  it('nie zmienia tresci pola z listy gosci', () => {
    const result = sanitizeLayoutOperations({
      operations: [{ op: 'setText', layerId: 'gosc', text: 'Wymyślone Nazwisko' }],
      layers: [layer({ id: 'gosc', type: 'text', individual: true })],
      page: PAGE,
    });

    assert.equal(result.operations.length, 0);
    assert.match(result.rejected[0].reason, /listy gosci/i);
  });

  it('respektuje blokady szablonu na ruch i wyglad', () => {
    const locked = layer({ canMove: false, canStyle: false });

    const geometry = sanitizeLayoutOperations({
      operations: [{ op: 'setGeometry', layerId: 'napis', x: 40 }],
      layers: [locked],
      page: PAGE,
    });
    const style = sanitizeLayoutOperations({
      operations: [{ op: 'setStyle', layerId: 'napis', fontSize: 20 }],
      layers: [locked],
      page: PAGE,
    });
    const visibility = sanitizeLayoutOperations({
      operations: [{ op: 'setVisibility', layerId: 'napis', visible: false }],
      layers: [locked],
      page: PAGE,
    });

    assert.equal(geometry.operations.length, 0);
    assert.equal(style.operations.length, 0);
    assert.equal(visibility.operations.length, 0);
  });

  it('odrzuca operacje bez zadnej wartosci', () => {
    const result = sanitizeLayoutOperations({
      operations: [{ op: 'setGeometry', layerId: 'napis' }],
      layers: [layer()],
      page: PAGE,
    });

    assert.equal(result.operations.length, 0);
    assert.match(result.rejected[0].reason, /bez zadnej wartosci/i);
  });

  it('znosi odpowiedz, ktora nie jest tablica', () => {
    const result = sanitizeLayoutOperations({
      operations: { op: 'setGeometry' },
      layers: [layer()],
      page: PAGE,
    });

    assert.deepEqual(result.operations, []);
  });
});
