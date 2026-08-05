/**
 * Tagi szablonow: normalizacja i etykiety.
 *
 * Sprzedawca wpisuje je recznie przy szablonie, wiec bez normalizacji
 * biblioteka po miesiacu mialaby „Slub”, „slub”, „ŚLUB” i „Śluby” jako
 * cztery osobne filtry. Do bazy trafia postac znormalizowana; etykieta
 * dla czlowieka powstaje przy wyswietlaniu.
 */

/** Maksymalna dlugosc pojedynczego tagu - to etykieta, nie opis. */
export const MAX_TAG_LENGTH = 32;
/** Ile tagow ma sens na jednym szablonie. */
export const MAX_TAGS_PER_TEMPLATE = 12;

/**
 * Postac zapisywana w bazie: male litery, bez ogonkow, spacje na myslniki.
 *
 * Ogonki znikaja celowo - „róża” i „roza” to dla sprzedawcy ten sam tag,
 * a wpisanie go bez polskich znakow na telefonie jest nagminne.
 */
export function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // `ł` nie ma rozkladu kanonicznego, wiec NFD go nie rusza - stad
    // osobna regula, inaczej „słub” zamienialoby sie w „sub”.
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_LENGTH);
}

/**
 * Czysta lista tagow gotowa do zapisu: znormalizowana, bez pustych,
 * bez powtorzen, przycieta do rozsadnej liczby.
 */
export function normalizeTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const tag = normalizeTag(value);
    if (tag) seen.add(tag);
    if (seen.size >= MAX_TAGS_PER_TEMPLATE) break;
  }

  return [...seen].sort();
}

/**
 * Etykieta dla czlowieka: „zaproszenie-slubne” -> „Zaproszenie slubne”.
 *
 * Ogonkow nie odtwarzamy - nie da sie zgadnac, czy „roza” to „róża”, czy
 * nazwisko. Panel pokazuje wiec zapis bez nich, spojny z tym, co w bazie.
 */
export function formatTagLabel(tag: string): string {
  const spaced = tag.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
