import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatTagLabel, normalizeTag, normalizeTags } from '../src/lib/template-tags';

/**
 * Tagi wpisuje recznie sprzedawca, wiec bez normalizacji biblioteka po
 * miesiacu mialaby „Slub”, „slub” i „ŚLUB” jako trzy osobne filtry.
 */

describe('normalizeTag', () => {
  it('sprowadza wielkosc liter i ogonki do jednej postaci', () => {
    assert.equal(normalizeTag('Ślub'), 'slub');
    assert.equal(normalizeTag('ŚLUB'), 'slub');
    assert.equal(normalizeTag('  slub  '), 'slub');
    assert.equal(normalizeTag('Róża'), 'roza');
  });

  it('radzi sobie z „ł”, ktorego NFD nie rozklada', () => {
    // Bez osobnej reguly „słub” zamienialoby sie w „sub”.
    assert.equal(normalizeTag('słub'), 'slub');
    assert.equal(normalizeTag('Żółty'), 'zolty');
  });

  it('laczy wyrazy myslnikiem i przycina smieci z brzegow', () => {
    assert.equal(normalizeTag('zaproszenie ślubne'), 'zaproszenie-slubne');
    assert.equal(normalizeTag('--- ślub ---'), 'slub');
    assert.equal(normalizeTag('numer   stołu'), 'numer-stolu');
  });

  it('zwraca pusty string dla wpisu bez tresci', () => {
    assert.equal(normalizeTag('   '), '');
    assert.equal(normalizeTag('!!!'), '');
  });

  it('przycina zbyt dlugi tag', () => {
    assert.equal(normalizeTag('a'.repeat(80)).length, 32);
  });
});

describe('normalizeTags', () => {
  it('usuwa powtorzenia po normalizacji', () => {
    assert.deepEqual(normalizeTags(['Ślub', 'slub', 'ŚLUB']), ['slub']);
  });

  it('wyrzuca puste wpisy i wartosci, ktore nie sa tekstem', () => {
    assert.deepEqual(normalizeTags(['ślub', '', '   ', null, 42, 'chrzest']), [
      'chrzest',
      'slub',
    ]);
  });

  it('zwraca posortowana liste - kolejnosc wpisywania nie ma znaczenia', () => {
    assert.deepEqual(normalizeTags(['winietka', 'chrzest', 'slub']), [
      'chrzest',
      'slub',
      'winietka',
    ]);
  });

  it('ogranicza liczbe tagow na szablonie', () => {
    const many = Array.from({ length: 30 }, (_, index) => `tag-${index}`);
    assert.equal(normalizeTags(many).length, 12);
  });

  it('cokolwiek innego niz tablica daje pusta liste', () => {
    assert.deepEqual(normalizeTags('slub'), []);
    assert.deepEqual(normalizeTags(undefined), []);
    assert.deepEqual(normalizeTags(null), []);
  });
});

describe('formatTagLabel', () => {
  it('robi z zapisu bazy etykiete dla czlowieka', () => {
    assert.equal(formatTagLabel('slub'), 'Slub');
    assert.equal(formatTagLabel('zaproszenie-slubne'), 'Zaproszenie slubne');
  });
});
