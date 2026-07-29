import '../tests/helpers/test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';

import {
  cleanupVerdict,
  classifyStorageFile,
} from '../src/services/storage/cleanup-storage.service';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function p(...parts: string[]) {
  return parts.join(path.sep);
}

test('czcionki nigdy nie sa kandydatem do usuniecia', () => {
  // Czcionki zyja wylacznie na dysku - `fonts.service` nie ma wpisu w bazie,
  // bo `Asset` wymaga `caseId`. Bez ochrony katalogu nocne czyszczenie
  // kasowalo je jako "osierocone", a szablony traciły kroje.
  const verdict = cleanupVerdict({
    relativePath: p('fonts', 'Lato-Regular.ttf'),
    ageMs: 400 * DAY,
    knownInDb: false,
  });

  assert.equal(verdict, 'protected');
});

test('szablony sa chronione tak samo', () => {
  assert.equal(
    cleanupVerdict({
      relativePath: p('templates', 'winietka', 'tlo.png'),
      ageMs: 400 * DAY,
      knownInDb: false,
    }),
    'protected'
  );
});

test('ozdobnik opisany w bazie zostaje', () => {
  // `DecorationAsset` nie byl czytany przy zbieraniu sciezek z bazy, wiec
  // biblioteka ozdobnikow sprzedawcy kwalifikowala sie do skasowania.
  assert.equal(
    cleanupVerdict({
      relativePath: p('decorations', 'tenant-1', 'serce.svg'),
      ageMs: 400 * DAY,
      knownInDb: true,
    }),
    'known'
  );
});

test('swiezy plik nie jest osierocony, tylko za mlody', () => {
  // Worker zapisuje plik, a rekord w bazie tworzy chwile pozniej. W tym oknie
  // plik nie ma wlasciciela - czyszczenie w trakcie renderu paczki kasowalo
  // pliki, ktore wlasnie powstawaly.
  assert.equal(
    cleanupVerdict({
      relativePath: p('order-1', 'v1', 'final-case-abc.pdf'),
      ageMs: 5 * 60 * 1000,
      knownInDb: false,
    }),
    'too-young'
  );

  // Godzine przed progiem nadal za mlody.
  assert.equal(
    cleanupVerdict({
      relativePath: p('order-1', 'v1', 'final-case-abc.pdf'),
      ageMs: 23 * HOUR,
      knownInDb: false,
    }),
    'too-young'
  );
});

test('dopiero plik bez wlasciciela i starszy niz doba idzie do usuniecia', () => {
  assert.equal(
    cleanupVerdict({
      relativePath: p('order-1', 'v1', 'preview-case-abc.png'),
      ageMs: 2 * DAY,
      knownInDb: false,
    }),
    'orphaned'
  );
});

test('dodatkowy prog wieku moze tylko podniesc wymagania', () => {
  const relativePath = p('order-1', 'v1', 'preview-case-abc.png');

  // 2 dni przy progu 30 dni - za mlody.
  assert.equal(
    cleanupVerdict({ relativePath, ageMs: 2 * DAY, knownInDb: false, minAgeMs: 30 * DAY }),
    'too-young'
  );

  // Prog nizszy od wymuszonej doby nie oslabia bariery.
  assert.equal(
    cleanupVerdict({ relativePath, ageMs: 2 * HOUR, knownInDb: false, minAgeMs: 1000 }),
    'too-young'
  );
});

test('rodzaj pliku rozpoznawany po sciezce', () => {
  assert.equal(classifyStorageFile(p('order-1', 'v1', 'preview-abc-x1.png')), 'preview');
  assert.equal(classifyStorageFile(p('order-1', 'v1', 'final-abc-x1.pdf')), 'print');
  assert.equal(classifyStorageFile(p('decorations', 'tenant-1', 'serce.svg')), 'decoration');
  assert.equal(classifyStorageFile(p('order-1', 'v1', 'cos-innego.bin')), 'other');
});
