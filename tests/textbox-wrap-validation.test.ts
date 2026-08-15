import './helpers/test-env';
import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { validateAnswers } from '../src/services/renderer/text-validator.service';

/**
 * Walidacja pol w ramce ZAWIJAJACEJ (`textbox`).
 *
 * Walidator dzielil tresc po znakach nowej linii i mierzyl kazdy kawalek
 * wobec szerokosci ramki. Dla `text` to poprawne - taka warstwa jest
 * jednoliniowa. Dla `textbox` bylo falszywym alarmem: renderer i tak lamie
 * wpis po spacjach, a paczka do druku wracala jako FAILED_RENDER z bledem
 * "Linia 1 jest za długa" na tresci, ktora drukowala sie bez zarzutu.
 *
 * Zdanie ponizej wywrocilo pierwsza probe zamowienia na dwustronne
 * zaproszenie: 1132 px zmierzone wobec 827 px ramki, mimo ze w trzech
 * wierszach miescilo sie swobodnie.
 */
const LONG_SENTENCE = 'na przyjęcie z okazji moich dwudziestych urodzin, które odbędzie się dnia';

/** Ramka 70 mm przy 300 dpi - tyle ma kolumna tekstu w zaproszeniu 90x130. */
const FRAME_WIDTH_PX = 827;

function field(overrides: Record<string, unknown> = {}) {
  return {
    key: 'invite_body',
    label: 'Treść zaproszenia',
    type: 'text',
    required: true,
    width: FRAME_WIDTH_PX,
    maxLines: 3,
    // Krój Z REJESTRU, nie zmyślony: bez niego pomiar jest przybliżony,
    // a walidator zgłasza wtedy ostrzeżenie zamiast błędu i test sprawdzałby
    // co innego, niż zamierza.
    font: { family: 'Cormorant Garamond', size: 34, weight: 400 },
    ...overrides,
  } as any;
}

describe('walidacja pol w ramce zawijajacej', () => {
  test('dlugie zdanie w textboksie przechodzi, bo ramka je zawija', async () => {
    const result = await validateAnswers({ invite_body: LONG_SENTENCE }, [field({ wraps: true })]);

    assert.deepEqual(result.errors, []);
    assert.equal(result.isValid, true);
  });

  test('to samo zdanie w jednoliniowym polu nadal jest odrzucane', async () => {
    const result = await validateAnswers({ invite_body: LONG_SENTENCE }, [field({ wraps: false })]);

    assert.ok(result.errors.length > 0, 'pole bez zawijania powinno zgłosić błąd');
    assert.match(result.errors[0].message, /za długa/);
  });

  test('slowo szersze od ramki jest bledem takze przy zawijaniu', async () => {
    // Zawijanie lamie po spacjach, wiec jednego dlugiego slowa nie uratuje -
    // i to jest jedyny przypadek, ktory ma dotrzec do klienta.
    const monster = 'Konstantynopolitańczykiewiczówna'.repeat(3);
    const result = await validateAnswers({ invite_body: monster }, [field({ wraps: true })]);

    assert.ok(result.errors.length > 0, 'za szerokie słowo powinno zgłosić błąd');
    assert.match(result.errors[0].message, /Słowo|za długa/);
  });

  test('zawijanie liczy linie po zlamaniu, nie po znakach nowej linii', async () => {
    // Zdanie na pewno nie zmiesci sie w jednej linii przy tej szerokosci.
    const result = await validateAnswers({ invite_body: LONG_SENTENCE }, [field({ wraps: true, maxLines: 1 })]);

    assert.ok(
      result.errors.some((error: any) => /za dużo linii/.test(error.message)),
      `oczekiwano błędu o liczbie linii, dostano: ${JSON.stringify(result.errors)}`
    );
  });
});
