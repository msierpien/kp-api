import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDeletedFieldKeySet,
  buildFieldRenameMap,
  migrateLayoutFieldKeys,
  removeDeletedFieldLayers,
} from '../src/services/admin/template-field-key-migration';

test('cascades a form field key rename into layout layers', () => {
  const renameMap = buildFieldRenameMap(
    [{ fields: [{ key: 'imie', label: 'Imię', sortOrder: 0 }] }],
    [{
      name: 'Personalizacja',
      sortOrder: 0,
      isActive: true,
      fields: [{
        key: 'imie_i_nazwisko',
        label: 'Imię',
        type: 'text',
        scope: 'SHARED',
        required: true,
        sortOrder: 0,
      }],
    }]
  );

  assert.equal(renameMap.get('imie'), 'imie_i_nazwisko');

  const migrated = migrateLayoutFieldKeys({
    version: 1,
    layers: [
      { id: 'layer_1', type: 'text', properties: { fieldKey: 'imie' } },
      { id: 'layer_2', type: 'textbox', properties: { fieldKey: 'imie' } },
      { id: 'layer_3', type: 'text', properties: { fieldKey: 'data' } },
    ],
  }, renameMap) as any;

  assert.equal(migrated.layers[0].properties.fieldKey, 'imie_i_nazwisko');
  assert.equal(migrated.layers[1].properties.fieldKey, 'imie_i_nazwisko');
  assert.equal(migrated.layers[2].properties.fieldKey, 'data');
});

test('does not treat an inserted field at the same position as a rename', () => {
  const renameMap = buildFieldRenameMap(
    [{ fields: [{ key: 'imie', label: 'Imię', sortOrder: 0 }] }],
    [{
      name: 'Personalizacja',
      sortOrder: 0,
      isActive: true,
      fields: [
        {
          key: 'email',
          label: 'E-mail',
          type: 'text',
          scope: 'SHARED',
          required: true,
          sortOrder: 0,
        },
        {
          key: 'imie',
          label: 'Imię',
          type: 'text',
          scope: 'SHARED',
          required: true,
          sortOrder: 1,
        },
      ],
    }]
  );

  assert.equal(renameMap.size, 0);
});

test('removes layout layers for deleted form fields', () => {
  const deletedKeys = buildDeletedFieldKeySet(
    [{ fields: [
      { key: 'imie', label: 'Imię', sortOrder: 0 },
      { key: 'stol', label: 'Stół', sortOrder: 1 },
    ] }],
    [{
      name: 'Personalizacja',
      sortOrder: 0,
      isActive: true,
      fields: [{
        key: 'imie',
        label: 'Imię',
        type: 'text',
        scope: 'SHARED',
        required: true,
        sortOrder: 0,
      }],
    }],
    new Map()
  );

  assert.equal(deletedKeys.has('stol'), true);
  assert.equal(deletedKeys.has('imie'), false);

  const pruned = removeDeletedFieldLayers({
    version: 1,
    layers: [
      { id: 'layer_1', type: 'text', properties: { fieldKey: 'imie' } },
      { id: 'layer_2', type: 'textbox', properties: { fieldKey: 'stol' } },
      { id: 'layer_3', type: 'image', properties: { fieldKey: 'stol' } },
      { id: 'layer_4', type: 'background', properties: {} },
    ],
  }, deletedKeys) as any;

  assert.deepEqual(pruned.layers.map((layer: any) => layer.id), ['layer_1', 'layer_3', 'layer_4']);
});

test('does not remove a layer for a renamed form field', () => {
  const renameMap = new Map([['imie', 'imie_i_nazwisko']]);
  const deletedKeys = buildDeletedFieldKeySet(
    [{ fields: [{ key: 'imie', label: 'Imię', sortOrder: 0 }] }],
    [{
      name: 'Personalizacja',
      sortOrder: 0,
      isActive: true,
      fields: [{
        key: 'imie_i_nazwisko',
        label: 'Imię i nazwisko',
        type: 'text',
        scope: 'SHARED',
        required: true,
        sortOrder: 0,
      }],
    }],
    renameMap
  );

  assert.equal(deletedKeys.has('imie'), false);
});
