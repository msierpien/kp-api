import './helpers/test-env';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  buildTextPathD,
  getTextPathAnchorOffset,
  getTextPathArcLength,
  getTextPathBBox,
  resolveTextPathStartOffset,
} from '@msierpien/kp-template-core';

/**
 * Kontrakt geometrii tekstu po luku widziany z renderera.
 *
 * Testy pilnuja tego, co przy rozjazdzie edytora z wydrukiem widac dopiero
 * na papierze: renderer wola te same funkcje co edytor, tylko bez skali
 * podgladu. Jesli ktos doda tu druga implementacje `d` albo offsetu, ta
 * asercja przestanie miec sens - i o to chodzi, zeby wtedy pekla.
 */

const DPI = 300;

const ARC = {
  pathShape: 'arc' as const,
  radiusMm: 30,
  startAngle: 180,
  sweepAngle: 180,
};

describe('geometria luku w rendererze', () => {
  test('renderer i edytor licza `d` ta sama funkcja, roznia sie tylko dpi', () => {
    // Edytor: dpi * skala podgladu. Renderer: samo dpi.
    const previewScale = 0.4;
    const forPrint = buildTextPathD(ARC, DPI);
    const forPreview = buildTextPathD(ARC, DPI * previewScale);

    // Ten sam ksztalt polecenia, inny promien - czyli skala siedzi wylacznie
    // w jednostce, a nie w drugiej implementacji wzoru.
    assert.match(forPrint, /^M -\d+ 0 A \d+ \d+ 0 0 1 \d+ (0|-0)$/);
    assert.match(forPreview, /^M -\d+ 0 A \d+ \d+ 0 0 1 \d+ (0|-0)$/);

    const printRadius = Number(/A (\d+)/.exec(forPrint)![1]);
    const previewRadius = Number(/A (\d+)/.exec(forPreview)![1]);
    assert.ok(
      Math.abs(previewRadius - printRadius * previewScale) <= 1,
      `promien podgladu ${previewRadius} ma byc ~${printRadius * previewScale}`
    );
  });

  test('pelny okrag ma dwa luki - jeden `A` na 360 stopni sie degeneruje', () => {
    const d = buildTextPathD({ ...ARC, pathShape: 'circle' }, DPI);
    assert.equal((d.match(/A /g) || []).length, 2);
  });

  test('kotwica przesuwa obiekt o polowe promienia dla poluku', () => {
    // To ta liczba decyduje, czy napis wyladuje tam, gdzie projektant ustawil
    // srodek okregu.
    const radiusPx = Math.round((ARC.radiusMm / 25.4) * DPI);
    const { dx, dy } = getTextPathAnchorOffset(ARC, DPI);

    assert.ok(Math.abs(dx) <= 1, `dx ${dx} ma byc ~0`);
    assert.ok(Math.abs(dy + radiusPx / 2) <= 1, `dy ${dy} ma byc ~${-radiusPx / 2}`);
  });

  test('offset wysrodkowania zostawia rowne zapasy', () => {
    const arcLength = getTextPathArcLength(ARC, DPI);
    const textWidth = arcLength / 2;

    assert.equal(resolveTextPathStartOffset('center', arcLength, textWidth), arcLength / 4);
  });

  test('napis dluzszy niz luk nie cofa sie przed jego poczatek', () => {
    const arcLength = getTextPathArcLength(ARC, DPI);
    assert.equal(resolveTextPathStartOffset('center', arcLength, arcLength * 2), 0);
  });

  test('bbox daje niezerowe wymiary warstwy', () => {
    // Walidacja struktury layoutu odrzuca warstwy o zerowej szerokosci
    // albo wysokosci, wiec `width`/`height` musza sie z czegos wziac.
    const box = getTextPathBBox(ARC, DPI);

    assert.ok(box.width > 0);
    assert.ok(box.height > 0);
  });
});

describe('render warstwy text_path', () => {
  test('renderer rysuje warstwe po luku i nie pomija jej po cichu', async () => {
    const { renderPreview } = await import('../src/services/renderer/fabric-renderer.service');

    const box = getTextPathBBox(ARC, DPI);
    const layout: any = {
      version: 2,
      canvas: { unit: 'mm', widthMm: 100, heightMm: 100, width: 1181, height: 1181, dpi: DPI, bleed: 0, safeArea: 0, backgroundColor: '#ffffff' },
      fonts: [],
      layers: [
        {
          id: 'arc-1',
          name: 'Luk',
          type: 'text_path',
          visible: true,
          locked: false,
          opacity: 1,
          zIndex: 1,
          x: 590,
          y: 500,
          width: box.width,
          height: box.height,
          rotation: 0,
          properties: {
            type: 'text_path',
            fieldKey: 'haslo',
            ...ARC,
            pathSide: 'left',
            pathAlign: 'baseline',
            textPathAlign: 'center',
            fontSize: 20,
            fontUnit: 'pt',
            fontFamily: 'DejaVu Sans',
            fontWeight: 400,
            fontStyle: 'normal',
            fill: '#111111',
          },
        },
      ],
    };

    const withText = await renderPreview(
      { templateName: 't', templateVersion: 1, layoutConfig: layout, answers: { haslo: 'ZAPRASZAMY' } } as any,
      { width: 1181, height: 1181, scale: 1, deviceScaleFactor: 1, format: 'png' }
    );

    const empty = await renderPreview(
      { templateName: 't', templateVersion: 1, layoutConfig: layout, answers: {} } as any,
      { width: 1181, height: 1181, scale: 1, deviceScaleFactor: 1, format: 'png' }
    );

    // Warstwa z trescia musi dac WIEKSZY plik niz pusta kartka - inaczej
    // znaczy, ze renderer wyrzucil ja po cichu (galaz typu nie zlapala).
    assert.ok(withText.length > 0, 'render zwraca bufor');
    assert.ok(
      withText.length > empty.length,
      `render z napisem (${withText.length} B) ma byc ciezszy niz bez (${empty.length} B)`
    );
  });
});
