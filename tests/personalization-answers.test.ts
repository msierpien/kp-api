import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalizePersonalizationField,
  canonicalizeTemplateForms,
  getFieldScope,
} from '../src/lib/personalization-answers';

test('uses repeaterGroupKey only as a legacy fallback for field scope', () => {
  const legacyField = {
    id: 'field_1',
    key: 'guest_name',
    label: 'Gość',
    scope: 'SHARED' as const,
    repeaterGroupKey: 'guests',
  };

  assert.equal(getFieldScope(legacyField), 'INDIVIDUAL');

  const canonical = canonicalizePersonalizationField(legacyField);
  assert.equal(canonical.scope, 'INDIVIDUAL');
  assert.equal('repeaterGroupKey' in canonical, false);
  assert.equal(canonical.key, 'guest_name');
});

test('canonicalizes template form fields without exposing repeaterGroupKey', () => {
  const forms = canonicalizeTemplateForms([
    {
      id: 'form_1',
      name: 'Personalizacja',
      fields: [
        {
          id: 'field_1',
          key: 'dedykacja',
          label: 'Dedykacja',
          scope: 'SHARED' as const,
          repeaterGroupKey: null,
        },
        {
          id: 'field_2',
          key: 'imie',
          label: 'Imię',
          scope: null,
          repeaterGroupKey: 'guests',
        },
      ],
    },
  ]);

  assert.equal(forms[0].fields[0].scope, 'SHARED');
  assert.equal(forms[0].fields[1].scope, 'INDIVIDUAL');
  assert.equal('repeaterGroupKey' in forms[0].fields[0], false);
  assert.equal('repeaterGroupKey' in forms[0].fields[1], false);
});
