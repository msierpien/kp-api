import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFieldRenameMap, migrateLayoutFieldKeys } from '../src/services/admin/template-field-key-migration';

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
