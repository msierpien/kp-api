import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { aiSettingsSchema } from '../src/schemas/admin.schema';

/**
 * Pola asystenta sa opcjonalne bez wartosci domyslnej i to jest cala rzecz,
 * ktorej pilnuje ten test: gdyby `editorEnabled` mialo `default(false)`,
 * zapis ustawien z panelu, ktory tego pola nie zna, wylaczylby asystenta
 * po cichu - przy okazji zmiany czegos zupelnie innego.
 */

const BASE = {
  activeProvider: 'ANTHROPIC',
  textProvider: 'ANTHROPIC',
  visionProvider: 'ANTHROPIC',
  openaiTextModel: 'gpt-4.1-mini',
  openaiVisionModel: 'gpt-4.1-mini',
  anthropicTextModel: 'claude-sonnet-5',
  anthropicVisionModel: 'claude-haiku-4-5',
  deepseekTextModel: 'deepseek-chat',
  dailyLimit: 200,
  monthlyLimit: 5000,
  timeoutMs: 45000,
  maxBatchSize: 20,
};

describe('aiSettingsSchema - asystent w edytorze', () => {
  it('nie podstawia wartosci dla pol asystenta, gdy ich nie ma w zadaniu', () => {
    const parsed = aiSettingsSchema.parse(BASE);

    assert.equal(parsed.editorEnabled, undefined);
    assert.equal(parsed.editorDailyLimit, undefined);
    assert.equal(parsed.editorPerCaseLimit, undefined);
  });

  it('przyjmuje komplet ustawien asystenta', () => {
    const parsed = aiSettingsSchema.parse({
      ...BASE,
      editorEnabled: true,
      editorProvider: 'ANTHROPIC',
      editorModel: 'claude-sonnet-5',
      editorDailyLimit: 80,
      editorPerCaseLimit: 5,
      editorSystemPrompt: 'Trzymaj formę grzecznościową „Państwo”.',
    });

    assert.equal(parsed.editorEnabled, true);
    assert.equal(parsed.editorModel, 'claude-sonnet-5');
    assert.equal(parsed.editorPerCaseLimit, 5);
  });

  it('odrzuca limit na projekt poza rozsadnym zakresem', () => {
    assert.equal(aiSettingsSchema.safeParse({ ...BASE, editorPerCaseLimit: 0 }).success, false);
    assert.equal(aiSettingsSchema.safeParse({ ...BASE, editorPerCaseLimit: 999 }).success, false);
  });

  it('puste editorProvider oznacza dziedziczenie, nie blad', () => {
    const parsed = aiSettingsSchema.parse({ ...BASE, editorProvider: null, editorModel: null });

    assert.equal(parsed.editorProvider, null);
    assert.equal(parsed.editorModel, null);
  });
});
