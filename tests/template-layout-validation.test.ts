import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectTemplateLayoutWarnings, validateTemplateLayoutStructure } from '../src/services/admin/template-layout-validation';

test('reports unmapped field keys as soft layout warnings', () => {
  const warnings = collectTemplateLayoutWarnings({
    version: 1,
    canvas: {} as any,
    fonts: [],
    layers: [
      {
        id: 'text_1',
        name: 'Imię',
        type: 'text',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 1,
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        rotation: 0,
        properties: { type: 'text', fieldKey: 'brakujace', placeholder: '{{ brakujace }}' } as any,
      },
    ],
  }, [{ fields: [{ key: 'imie' }] }]);

  assert.equal(warnings.some((warning) => warning.code === 'TEXT_LAYER_FIELD_KEY_UNMAPPED'), true);
  assert.equal(warnings.some((warning) => warning.code === 'BACKGROUND_LAYER_MISSING'), true);
});

test('keeps invalid layer geometry as a blocking validation error', () => {
  assert.throws(() => validateTemplateLayoutStructure({
    version: 1,
    canvas: {} as any,
    fonts: [],
    layers: [
      {
        id: 'text_1',
        name: 'Imię',
        type: 'text',
        visible: true,
        locked: false,
        opacity: 1,
        zIndex: 1,
        x: 0,
        y: 0,
        width: 0,
        height: 40,
        rotation: 0,
        properties: { type: 'text', fieldKey: 'imie', placeholder: '{{ imie }}' } as any,
      },
    ],
  }), /nieprawidłowe wymiary/);
});
