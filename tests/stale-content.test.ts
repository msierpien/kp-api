import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findStaleContent } from '../src/services/renderer/stale-content';

/**
 * Ostrzezenia o tresci z innej uroczystosci. Kosztem falszywego alarmu jest
 * jedno zdanie w kroku Zatwierdzenie, kosztem przeoczenia - wydrukowane
 * "OSIEMNASTYCH URODZIN" na trzydziestce, wiec prog czulosci jest tu nisko.
 * Te testy pilnuja, zeby nie zszedl za nisko: data w przyszlosci i tresc
 * zgodna z liczba lat maja przechodzic bez slowa.
 */

const NOW = new Date(2026, 7, 20); // 20 sierpnia 2026

const FIELDS = [
  { key: 'age_number', label: 'Liczba lat', type: 'text' },
  { key: 'occasion_text', label: 'Okazja', type: 'select' },
  { key: 'quote_text', label: 'Motto', type: 'select' },
  { key: 'party_datetime', label: 'Data i godzina', type: 'textarea' },
  { key: 'party_date_picker', label: 'Data z kalendarza', type: 'date' },
];

describe('findStaleContent - liczebnik wieku', () => {
  it('zglasza formule z innym wiekiem niz pole liczby lat', () => {
    const issues = findStaleContent(
      FIELDS,
      { age_number: '30', occasion_text: 'NA PRZYJĘCIE Z OKAZJI MOICH\nOSIEMNASTYCH URODZIN' },
      NOW
    );

    assert.equal(issues.length, 1);
    assert.equal(issues[0].field, 'occasion_text');
    assert.match(issues[0].message, /liczba lat na zaproszeniu to 30/);
  });

  it('milczy, gdy formula zgadza sie z liczba lat', () => {
    const issues = findStaleContent(
      FIELDS,
      { age_number: '18', occasion_text: 'NA PRZYJĘCIE Z OKAZJI MOICH\nOSIEMNASTYCH URODZIN' },
      NOW
    );

    assert.deepEqual(issues, []);
  });

  it('lapie takze zapis cyfra', () => {
    const issues = findStaleContent(
      FIELDS,
      { age_number: '40', occasion_text: 'z okazji 18. urodzin' },
      NOW
    );

    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /liczba lat na zaproszeniu to 40/);
  });

  it('milczy, gdy szablon nie pyta o liczbe lat', () => {
    const issues = findStaleContent(
      [{ key: 'occasion_text', label: 'Okazja', type: 'select' }],
      { occasion_text: 'NA PRZYJĘCIE Z OKAZJI MOICH OSIEMNASTYCH URODZIN' },
      NOW
    );

    assert.deepEqual(issues, []);
  });
});

describe('findStaleContent - daty', () => {
  it('zglasza date, ktora juz minela', () => {
    const issues = findStaleContent(FIELDS, { party_datetime: '16.08.2025\nO GODZ. 18' }, NOW);

    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /16\.08\.2025 już minęła/);
  });

  it('milczy przy dacie w przyszlosci', () => {
    const issues = findStaleContent(FIELDS, { party_datetime: '16.08.2029\nO GODZ. 18' }, NOW);

    assert.deepEqual(issues, []);
  });

  it('rozumie zapis slowny', () => {
    const issues = findStaleContent(FIELDS, { party_datetime: '12 czerwca 2025 roku o godz. 16:00' }, NOW);

    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /12 czerwca 2025 już minęła/);
  });

  it('zglasza sam rok z przeszlosci', () => {
    const issues = findStaleContent(FIELDS, { quote_text: 'Rocznik 2024 – nasza klasa' }, NOW);

    assert.equal(issues.length, 1);
    assert.match(issues[0].message, /rok 2024 w treści już minął/);
  });

  it('nie rusza pol z kalendarza - te maja wlasna walidacje', () => {
    const issues = findStaleContent(FIELDS, { party_date_picker: '16.08.2025' }, NOW);

    assert.deepEqual(issues, []);
  });

  it('rok biezacy przechodzi, bo koncem roku jest 31 grudnia', () => {
    const issues = findStaleContent(FIELDS, { quote_text: 'Studniówka 2026' }, NOW);

    assert.deepEqual(issues, []);
  });
});
