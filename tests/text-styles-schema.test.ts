import './helpers/test-env';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { templateLayoutSchema } from '../src/schemas/admin.schema';

/**
 * Nazwane style tekstu przezywaja zapis layoutu.
 *
 * `z.object` wycina nieznane klucze BEZ bledu, wiec pole formatu, ktorego nie
 * ma w schemacie, ginie po cichu: projektant zapisuje szablon, dostaje
 * "zapisano", a po przeladowaniu edytora stylow nie ma. Ten test pilnuje
 * dokladnie tego progu.
 */

const baseLayout = {
  version: 2,
  canvas: {
    width: 1181,
    height: 1772,
    unit: 'mm',
    widthMm: 100,
    heightMm: 150,
    dpi: 300,
    bleed: 0,
    safeArea: 0,
    backgroundColor: '#ffffff',
  },
  fonts: [],
  layers: [],
};

const STYLE = {
  id: 'style_naglowek',
  name: 'Nagłówek',
  properties: {
    fontFamily: 'Bodoni Moda',
    fontSize: 32,
    fontUnit: 'pt',
    fontWeight: 700,
    fontStyle: 'italic',
    lineHeight: 1.35,
    letterSpacing: 50,
    fill: '#8a1538',
    textAlign: 'center',
    textTransform: 'uppercase',
  },
};

describe('style tekstu w schemacie layoutu', () => {
  test('definicje stylow przechodza przez zapis w calosci', () => {
    const parsed = templateLayoutSchema.parse({ ...baseLayout, textStyles: [STYLE] });

    assert.equal(parsed.textStyles?.length, 1);
    assert.deepEqual(parsed.textStyles?.[0], STYLE);
  });

  test('warstwa zachowuje przypisanie do stylu', () => {
    const parsed = templateLayoutSchema.parse({
      ...baseLayout,
      layers: [
        {
          id: 'text-1',
          name: 'Nagłówek',
          type: 'text',
          visible: true,
          locked: false,
          opacity: 1,
          zIndex: 1,
          x: 100,
          y: 100,
          width: 500,
          height: 100,
          rotation: 0,
          properties: {
            type: 'text',
            fieldKey: 'imie',
            placeholder: '',
            fontSize: 32,
            fontFamily: 'Bodoni Moda',
            styleId: 'style_naglowek',
            // Przy okazji: obrys i wersaliki z tego samego wydania.
            stroke: '#ffffff',
            strokeWidthMm: 0.4,
            textTransform: 'uppercase',
          },
        },
      ],
    });

    const props = parsed.layers[0].properties as Record<string, unknown>;
    assert.equal(props.styleId, 'style_naglowek');
    assert.equal(props.stroke, '#ffffff');
    assert.equal(props.strokeWidthMm, 0.4);
    assert.equal(props.textTransform, 'uppercase');
  });

  test('styl bez nazwy albo bez id nie przechodzi', () => {
    assert.throws(() =>
      templateLayoutSchema.parse({
        ...baseLayout,
        textStyles: [{ id: '', name: 'Bez id', properties: {} }],
      })
    );
    assert.throws(() =>
      templateLayoutSchema.parse({
        ...baseLayout,
        textStyles: [{ id: 'style_1', name: '', properties: {} }],
      })
    );
  });

  test('nieznana wartosc wielkosci liter nie przechodzi', () => {
    assert.throws(() =>
      templateLayoutSchema.parse({
        ...baseLayout,
        textStyles: [
          { id: 'style_1', name: 'X', properties: { textTransform: 'SMALL-CAPS' } },
        ],
      })
    );
  });
});
