import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  isMeaninglessFileName,
  suggestFromFileName,
  tokenizeFileName,
} from '../src/lib/decoration-naming';

const CATEGORIES = [
  { slug: 'SLUBNE', name: 'Ślubne' },
  { slug: 'KWIATOWE', name: 'Kwiatowe' },
  { slug: 'BOHO_RUSTYKALNE', name: 'Boho & rustykalne' },
];

describe('tagi z nazwy pliku', () => {
  test('rozbija po myslnikach, podkresleniach i camelCase', () => {
    assert.deepEqual(tokenizeFileName('kokardka-slubna.svg'), ['kokardka', 'slubna']);
    assert.deepEqual(tokenizeFileName('kokardka_slubna.svg'), ['kokardka', 'slubna']);
    // Eksporty z programow graficznych lubia camelCase.
    assert.deepEqual(tokenizeFileName('KokardkaSlubna.svg'), ['kokardka', 'slubna']);
  });

  test('odsiewa numeracje, wersje i wymiary', () => {
    assert.deepEqual(tokenizeFileName('roza-01.svg'), ['roza']);
    assert.deepEqual(tokenizeFileName('roza-v2.svg'), ['roza']);
    assert.deepEqual(tokenizeFileName('roza-100x100.svg'), ['roza']);
    assert.deepEqual(tokenizeFileName('roza wersja3.svg'), ['roza']);
  });

  test('odsiewa slady eksportu', () => {
    assert.deepEqual(tokenizeFileName('serce-final-kopia.svg'), ['serce']);
    assert.deepEqual(tokenizeFileName('export_serce_druk.svg'), ['serce']);
  });

  test('nazwa bez tresci nie daje nic', () => {
    // To wlasnie takie pliki warto oddac modelowi do nazwania.
    for (const name of ['Untitled-1.svg', 'export_v3.svg', 'asset 12.png', 'IMG_0042.png']) {
      assert.deepEqual(tokenizeFileName(name), [], name);
      assert.ok(isMeaninglessFileName(name), name);
    }

    assert.ok(!isMeaninglessFileName('kokardka.svg'));
  });

  test('ogonki znikaja tak samo jak przy recznym wpisywaniu', () => {
    // Tag w bazie ma jedna postac, niezaleznie od tego, skad przyszedl.
    assert.deepEqual(tokenizeFileName('róża-ślubna.svg'), ['roza', 'slubna']);
  });
});

describe('dopasowanie do biblioteki sprzedawcy', () => {
  test('czlon zgodny z nazwa kategorii wskazuje kategorie, nie tag', () => {
    const out = suggestFromFileName('slubne-kokardka.svg', { categories: CATEGORIES });
    assert.equal(out.category, 'SLUBNE');
    // `slubne` nie moze wrocic jako tag - kategoria juz to niesie.
    assert.deepEqual(out.tags, ['kokardka']);
  });

  test('dopasowanie po nazwie grupy, nie tylko po slugu', () => {
    const out = suggestFromFileName('kwiatowe-piwonia.svg', { categories: CATEGORIES });
    assert.equal(out.category, 'KWIATOWE');
    assert.deepEqual(out.tags, ['piwonia']);
  });

  test('znane tagi ida przed nowymi', () => {
    const out = suggestFromFileName('piwonia-roza-akwarela.svg', {
      tags: ['roza'],
      categories: CATEGORIES,
    });
    assert.equal(out.tags[0], 'roza', 'znany tag na poczatku');
    assert.deepEqual(out.matchedKnown, ['roza']);
    assert.deepEqual([...out.tags].sort(), ['akwarela', 'piwonia', 'roza']);
  });

  test('brak dopasowania nie wymysla kategorii', () => {
    const out = suggestFromFileName('kokardka.svg', { categories: CATEGORIES });
    assert.equal(out.category, undefined);
    assert.deepEqual(out.tags, ['kokardka']);
  });
});
