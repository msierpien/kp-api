import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

/** Pole tekstowe z krojem, ktory lezy w rejestrze testowym. */
function field(overrides: Record<string, unknown> = {}) {
  return {
    key: 'przyjecie',
    label: 'Informacja o przyjęciu',
    type: 'textarea',
    required: false,
    font: { family: 'LindenHill-Regular', size: 12, weight: 400 },
    ...overrides,
  };
}

/**
 * Rejestr czcionek zyje w `storage/fonts`, ktory jest poza repozytorium -
 * na czystej maszynie nie ma czym sprawdzic glifow. Testy oparte o prawdziwy
 * plik pomijamy wtedy zamiast zglaszac falszywa porazke.
 */
async function firstPrintableFamily(): Promise<string | null> {
  const { listFonts, PRINTABLE_FONT_FORMATS } = await import('../src/services/admin/fonts.service');
  const fonts = await listFonts();
  const match = fonts.find((font) => PRINTABLE_FONT_FORMATS.includes(font.format.toLowerCase()));
  return match ? match.family : null;
}

test('polskie cudzyslowy i myslniki nie sa juz zglaszane', async (t) => {
  const family = await firstPrintableFamily();
  if (!family) return t.skip('brak czcionek w storage/fonts');

  const { validateAnswers } = await import('../src/services/renderer/text-validator.service');

  const result = await validateAnswers(
    { przyjecie: 'Przyjęcie w restauracji „Zacisze” – ul. Cicha 12/3 & okolice…' },
    [field({ font: { family, size: 12, weight: 400 } })] as any
  );

  const charWarnings = result.warnings.filter((warning) => warning.message.includes('kroju pisma'));
  assert.deepEqual(charWarnings, [], `nie oczekiwano ostrzezen, sa: ${JSON.stringify(charWarnings)}`);
});

test('znak spoza kroju nadal daje ostrzezenie', async (t) => {
  const family = await firstPrintableFamily();
  if (!family) return t.skip('brak czcionek w storage/fonts');

  const { validateAnswers } = await import('../src/services/renderer/text-validator.service');

  const result = await validateAnswers(
    { przyjecie: 'Zapraszamy 😀 всех' },
    [field({ font: { family, size: 12, weight: 400 } })] as any
  );

  const charWarning = result.warnings.find((warning) => warning.message.includes('kroju pisma'));
  assert.ok(charWarning, 'oczekiwano ostrzezenia o znakach bez glifu');
  assert.ok(charWarning!.message.includes('😀'), charWarning!.message);
});

test('bez kroju w rejestrze zostaje lista zapasowa - typografia przechodzi, emoji nie', async () => {
  const { validateAnswers } = await import('../src/services/renderer/text-validator.service');
  const missingFont = field({ font: { family: 'KrojKtoregoNieMa', size: 12, weight: 400 } });

  const ok = await validateAnswers({ przyjecie: 'Restauracja „Zacisze” – 12/3' }, [missingFont] as any);
  assert.deepEqual(
    ok.warnings.filter((warning) => warning.message.includes('kroju pisma')),
    []
  );

  const bad = await validateAnswers({ przyjecie: 'Zapraszamy 😀' }, [missingFont] as any);
  assert.ok(bad.warnings.some((warning) => warning.message.includes('😀')));
});
