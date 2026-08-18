/**
 * Tagi wyczytane z nazwy pliku.
 *
 * Sprzedawca wgrywa paczkami po kilkadziesiat grafik i nikt nie opisuje ich
 * recznie jedna po drugiej. Nazwy z jego dysku zwykle cos znacza
 * („kokardka-slubna-01.svg”), wiec to najtansze zrodlo tagow - bez modelu,
 * bez kosztu, natychmiast.
 *
 * Propozycje, nie fakty: trafiaja do panelu jako podpowiedz do zatwierdzenia.
 */
import { normalizeTag } from './template-tags';

/**
 * Czlony bez tresci: numeracja, oznaczenia wersji, slady eksportu.
 * Wpisane jako TAGI (po normalizacji), bo tak wlasnie wygladaja po rozbiciu.
 */
const NOISE = new Set([
  'final', 'finalna', 'finalny', 'ostateczna', 'ostateczny',
  'kopia', 'copy', 'duplikat', 'new', 'nowy', 'nowa',
  'export', 'eksport', 'plik', 'file', 'image', 'img', 'grafika', 'vector', 'wektor',
  'svg', 'png', 'jpg', 'jpeg', 'webp', 'ai', 'eps', 'cdr',
  'untitled', 'bez-nazwy', 'beznazwy', 'asset', 'zasob',
  'edit', 'edytowany', 'poprawka', 'poprawiony', 'popr',
  'druk', 'print', 'web', 'small', 'big', 'duzy', 'maly',
]);

/** `v2`, `v10`, `wer2`, samo `2`, `01` - numeracja i wersje. */
const VERSION_OR_NUMBER = /^(v|ver|wer|wersja)?\d+$/;
/** `100x100`, `1920x1080` - wymiary z eksportu. */
const DIMENSIONS = /^\d+\s*[x×]\s*\d+$/;

/** Ile tagow ma sens wyciagnac z jednej nazwy - reszta to zwykle szum. */
const MAX_FROM_NAME = 5;

/**
 * Czy nazwa pliku niesie jakakolwiek tresc.
 *
 * „Untitled-1”, „export_v3”, „asset 12” nie mowia nic o grafice - takie
 * dopiero warto oddac modelowi do nazwania.
 */
export function isMeaninglessFileName(fileName: string): boolean {
  return tokenizeFileName(fileName).length === 0;
}

/** Czlony nazwy po odsianiu szumu - znormalizowane, bez powtorzen. */
export function tokenizeFileName(fileName: string): string[] {
  const base = fileName.replace(/\.[a-z0-9]+$/i, '');

  // Rozbijamy takze na granicy wielkich liter („KokardkaSlubna”), bo eksporty
  // z programow graficznych lubia camelCase.
  const parts = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s._\-–—+()[\]{}]+/);

  const seen = new Set<string>();
  for (const part of parts) {
    const raw = part.trim();
    if (!raw) continue;
    if (DIMENSIONS.test(raw)) continue;

    const tag = normalizeTag(raw);
    if (!tag) continue;
    if (VERSION_OR_NUMBER.test(tag)) continue;
    if (NOISE.has(tag)) continue;
    // Jedna litera to zwykle pozostalosc po rozbiciu, nie etykieta.
    if (tag.length < 2) continue;

    seen.add(tag);
    if (seen.size >= MAX_FROM_NAME) break;
  }

  return [...seen];
}

export interface NameSuggestion {
  tags: string[];
  /** Slug kategorii, jesli nazwa wprost wskazuje na jedna z istniejacych. */
  category?: string;
  /** Ktore czlony pokryly sie z tym, czego sprzedawca juz uzywa. */
  matchedKnown: string[];
}

/**
 * Propozycja tagow i kategorii dla jednego pliku.
 *
 * Czlony pokrywajace sie z ISTNIEJACYMI tagami sprzedawcy sa pewniejsze niz
 * dowolne slowo z nazwy, wiec ida na poczatek listy. Kategorie dopasowujemy
 * po slugu i po nazwie - „slubne-kokardka.svg” ma trafic do „Ślubne”, a nie
 * zalozyc tag `slubne` obok istniejacej grupy o tej samej tresci.
 */
export function suggestFromFileName(
  fileName: string,
  known: {
    tags?: string[];
    categories?: Array<{ slug: string; name: string }>;
  } = {}
): NameSuggestion {
  const tokens = tokenizeFileName(fileName);
  if (tokens.length === 0) return { tags: [], matchedKnown: [] };

  const knownTags = new Set(known.tags ?? []);

  // Kategoria: szukamy czlonu, ktory odpowiada slugowi albo nazwie grupy.
  let category: string | undefined;
  const categoryTokens = new Set<string>();

  for (const item of known.categories ?? []) {
    const slugTag = normalizeTag(item.slug);
    const nameTag = normalizeTag(item.name);
    for (const token of tokens) {
      if (token === slugTag || token === nameTag) {
        category = category ?? item.slug;
        categoryTokens.add(token);
      }
    }
  }

  // Czlon, ktory wskazal kategorie, nie musi byc jeszcze tagiem - kategoria
  // juz niesie te informacje, a podwojenie zasmieca liste filtrow.
  const tags = tokens.filter((token) => !categoryTokens.has(token));
  const matchedKnown = tags.filter((token) => knownTags.has(token));

  return {
    // Znane tagi pierwsze - to one realnie zawezaja biblioteke.
    tags: [...matchedKnown, ...tags.filter((token) => !knownTags.has(token))],
    ...(category ? { category } : {}),
    matchedKnown,
  };
}
