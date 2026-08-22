import './helpers/test-env';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decideOutcome, type ProductFacts, type CleanupMode } from '../src/services/admin/warehouse-product-cleanup.service';

/**
 * Czyszczenie katalogu kasuje produkty w sklepie i u nas, wiec ta decyzja jest
 * ostatnim miejscem, ktore stoi miedzy masowka a utracona historia. Testy
 * pilnuja dwoch rzeczy: ze blokada zawsze wygrywa z trybem, i ze pozycja z
 * jakakolwiek historia dostaje archiwizacje zamiast DELETE.
 */

function facts(overrides: Partial<Record<keyof ProductFacts, string[]>> = {}): ProductFacts {
  const set = (key: keyof ProductFacts) => new Set(overrides[key] ?? []);
  return {
    openOrderIds: set('openOrderIds'),
    reservationIds: set('reservationIds'),
    anyReservationIds: set('anyReservationIds'),
    personalizationIds: set('personalizationIds'),
    documentItemIds: set('documentItemIds'),
    soldIds: set('soldIds'),
  };
}

const MODES: CleanupMode[] = ['DEACTIVATE_ARCHIVE', 'SHOP_DELETE', 'PURGE', 'UNLINK'];

describe('decideOutcome — blokady', () => {
  it('otwarte zamówienie wstrzymuje pozycję w każdym trybie', () => {
    for (const mode of MODES) {
      assert.equal(decideOutcome('p1', mode, facts({ openOrderIds: ['p1'] })), 'BLOCKED_OPEN_ORDER');
    }
  });

  it('aktywna rezerwacja wstrzymuje pozycję w każdym trybie', () => {
    for (const mode of MODES) {
      assert.equal(decideOutcome('p1', mode, facts({ reservationIds: ['p1'] })), 'BLOCKED_RESERVATION');
    }
  });

  it('szablon personalizacji wstrzymuje pozycję w każdym trybie', () => {
    for (const mode of MODES) {
      assert.equal(decideOutcome('p1', mode, facts({ personalizationIds: ['p1'] })), 'BLOCKED_PERSONALIZATION');
    }
  });

  it('blokada zamówienia ma pierwszeństwo przed pozostałymi', () => {
    const outcome = decideOutcome('p1', 'PURGE', facts({
      openOrderIds: ['p1'],
      reservationIds: ['p1'],
      personalizationIds: ['p1'],
    }));
    assert.equal(outcome, 'BLOCKED_OPEN_ORDER');
  });
});

describe('decideOutcome — tryby', () => {
  it('tryb domyślny gasi w sklepie i archiwizuje, nawet gdy jest historia', () => {
    const outcome = decideOutcome('p1', 'DEACTIVATE_ARCHIVE', facts({ soldIds: ['p1'], documentItemIds: ['p1'] }));
    assert.equal(outcome, 'SHOP_DEACTIVATE_AND_ARCHIVE');
  });

  it('rozłączenie mapowania nie zależy od historii', () => {
    assert.equal(decideOutcome('p1', 'UNLINK', facts({ soldIds: ['p1'] })), 'UNLINK');
  });

  it('twarde usunięcie przechodzi tylko dla pozycji bez śladu', () => {
    assert.equal(decideOutcome('p1', 'PURGE', facts()), 'PURGE');
  });

  it('sprzedaż zamienia usunięcie na archiwizację', () => {
    assert.equal(decideOutcome('p1', 'PURGE', facts({ soldIds: ['p1'] })), 'ARCHIVE_INSTEAD_OF_PURGE');
  });

  it('pozycja dokumentu zamienia usunięcie na archiwizację', () => {
    assert.equal(decideOutcome('p1', 'PURGE', facts({ documentItemIds: ['p1'] })), 'ARCHIVE_INSTEAD_OF_PURGE');
  });

  it('zwolniona rezerwacja też chroni przed usunięciem — klucz obcy ma Restrict', () => {
    assert.equal(decideOutcome('p1', 'PURGE', facts({ anyReservationIds: ['p1'] })), 'ARCHIVE_INSTEAD_OF_PURGE');
  });
});
