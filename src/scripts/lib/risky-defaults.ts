/**
 * Rozpoznawanie tresci startowej, ktora klient wydrukuje nie zauwazywszy.
 *
 * Wspolne dla audytu (`audit-template-form-defaults.ts`) i dla poprawki
 * (`defuse-template-defaults.ts`) - obie musza oceniac tak samo, inaczej
 * raport obiecywalby zmiany, ktorych poprawka nie zrobi.
 *
 * Zasada jest jedna: `default_value` ma byc SZKIELETEM, nie tresci. "xx.xx.xxxx"
 * widac na pierwszy rzut oka, "16.08.2029" wyglada jak decyzja klienta - i tak
 * wlasnie idzie na papier, gdy klient przewinie formularz nie czytajac.
 */

/** Typy pol, przy ktorych `placeholder` sie nie pokazuje w portalu. */
export const NO_PLACEHOLDER_TYPES = new Set(['select', 'date', 'checkbox', 'radio', 'upload']);

/** Typy, przy ktorych domyslka jest widocznym wyborem, a nie cicha tresci. */
export const CHOICE_TYPES = new Set(['select', 'radio', 'checkbox']);

/**
 * Liczebniki przywiazujace napis do konkretnego wieku albo rocznicy.
 *
 * Sama liczba nie wystarcza jako sygnal - "ul. Lipowa 12" tez ma cyfry.
 * Chodzi o slowa i formy, ktore wystepuja w formulach okazji.
 */
const AGE_WORDS = [
  'osiemnast',
  'dwudziest',
  'trzydziest',
  'czterdziest',
  'piecdziesiat',
  'szesnast',
  'siedemdziesiat',
  'szescdziesiat',
  'osiemdziesiat',
  'dziewiecdziesiat',
  'setnych',
  'pierwszych urodzin',
  'roczek',
  'rocznic',
];

/**
 * Slowa, ktore wygladaja na nazwe wlasna, a sa zwyklym naglowkiem karty.
 *
 * "Menu" w polu naglowka to nie jest cudza tresc do wyczyszczenia - to napis,
 * ktory ma tam stac.
 */
const GENERIC_HEADINGS = ['menu', 'program', 'zaproszenie', 'winietka', 'zyczenia', 'jadlospis'];

/** Slowa, po ktorych poznajemy nazwe wlasna lokalu. */
const VENUE_WORDS = ['sala', 'restauracj', 'hotel', 'dworek', 'karczm', 'palac', 'willa'];

/** Wzorzec do uzupelnienia - "xx.xx.xxxx", "___", "XX". Tego nikt nie wydrukuje. */
const PLACEHOLDER_SHAPED = /(x{2,}|_{2,}|\.{3,})/i;

const DATE_LIKE = /\b\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b/;
const YEAR_LIKE = /\b(19|20)\d{2}\b/;
const TIME_LIKE = /\bgodz\w*\.?\s*\d{1,2}([.:]\d{2})?\b/i;
const ORDINAL_LIKE = /\b\d{1,3}\s*[.-]?\s*(tych|tego|ta|te|lecia|lecie)?\s*(urodzin|rocznic)/i;

export function stripDiacritics(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Dlaczego ta tresc startowa jest ryzykowna - albo `null`, gdy jest bezpieczna.
 *
 * Bezpieczne sa wzorce z iksami i formuly bez faktow ("SERDECZNIE ZAPRASZAM").
 */
export function describeRisk(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  if (PLACEHOLDER_SHAPED.test(text)) return null;

  const flat = stripDiacritics(text);

  if (DATE_LIKE.test(text)) return 'konkretna data';
  if (YEAR_LIKE.test(text)) return 'konkretny rok';
  if (TIME_LIKE.test(text)) return 'konkretna godzina';
  if (ORDINAL_LIKE.test(flat)) return 'liczebnik przywiazany do wieku / rocznicy';

  const ageWord = AGE_WORDS.find((word) => flat.includes(word));
  if (ageWord) return `liczebnik przywiazany do wieku / rocznicy ("${ageWord}")`;

  const venueWord = VENUE_WORDS.find((word) => flat.includes(word));
  if (venueWord) return `nazwa lokalu ("${venueWord}")`;

  // Jednowyrazowa wartosc z wielkiej litery w polu imienia albo podpisu -
  // "Dorota" wyglada jak tresc klienta, bo nia jest, tylko cudza.
  if (/^[A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż]{2,}$/.test(text) && !GENERIC_HEADINGS.includes(flat)) {
    return 'imie albo nazwa wlasna';
  }

  return null;
}

/**
 * Podpowiedz zbudowana z dotychczasowej tresci startowej.
 *
 * Miniatura szablonu bierze `placeholder` bez wiodacego "np." jako przykladowa
 * odpowiedz (`template-thumbnail.service.ts` -> `sampleValue`), wiec tresc
 * przeniesiona tutaj nadal maluje zdjecie produktu - znika tylko z odpowiedzi
 * zamowienia, gdzie udawala decyzje klienta.
 */
export function hintFromDefault(defaultValue: string) {
  return `np. ${defaultValue.replace(/\s*\n\s*/g, ' ').trim()}`;
}
