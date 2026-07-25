import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const CLIENT = readFileSync(join(ROOT, 'src/services/prestashop/prestashop-client.ts'), 'utf8');

test('odczyty z PrestaShop sa ponawiane, zapisy nigdy', () => {
  // Retry dotyczy tylko metod idempotentnych - ponowiony POST/PUT moglby
  // zdublowac zamowienie albo produkt po stronie sklepu.
  assert.match(CLIENT, /const isRetryable = method === 'GET' \|\| method === 'HEAD'/);
  assert.match(CLIENT, /const maxAttempts = isRetryable \? PRESTASHOP_READ_RETRIES : 1/);
});

test('ponawiane sa wylacznie bledy przejsciowe (5xx, 429) i sieciowe', () => {
  assert.match(CLIENT, /const isTransient = response\.status >= 500 \|\| response\.status === 429/);
  // Blad HTTP rozstrzygniety w petli nie moze wpasc w ponowienie po raz drugi.
  assert.match(CLIENT, /if \(isApiError \|\| attempt >= maxAttempts\) throw error/);
});

test('odstep miedzy probami rosnie i jest konfigurowalny', () => {
  assert.match(CLIENT, /PRESTASHOP_RETRY_DELAY_MS \* attempt/);
  assert.match(CLIENT, /process\.env\.PRESTASHOP_READ_RETRIES/);
});
