/**
 * Ostrzezenia o tresci, ktora nie pasuje do TEJ uroczystosci.
 *
 * Wzory zaproszen sprzedaja sie latami i noszą w sobie napisy z czasu, gdy
 * powstawaly: "OSIEMNASTYCH URODZIN" na wzorze kupionym pod trzydziestke,
 * data z zeszlego roku, godzina z przykladu. Klient, ktory formularza nie
 * przeczytal w calosci, zatwierdza to bez mrugniecia - bo formularz wygladal
 * na wypelniony.
 *
 * Te ostrzezenia niczego nie blokuja (rocznica slubu w przeszlosci bywa
 * poprawna, a "80 lat" na zaproszeniu wnuczki tez). Maja tylko postawic
 * pytanie w kroku Zatwierdzenie, zanim paczka pojdzie do druku.
 */

/** Liczebniki porzadkowe w formie, w jakiej wystepuja na kartkach. */
const ORDINAL_WORDS: Array<[RegExp, number]> = [
  [/pierwsz\w*/, 1],
  [/dziesiat\w*/, 10],
  [/dwunast\w*/, 12],
  [/trzynast\w*/, 13],
  [/czternast\w*/, 14],
  [/pietnast\w*/, 15],
  [/szesnast\w*/, 16],
  [/siedemnast\w*/, 17],
  [/osiemnast\w*/, 18],
  [/dziewietnast\w*/, 19],
  [/dwudziest\w*/, 20],
  [/trzydziest\w*/, 30],
  [/czterdziest\w*/, 40],
  [/piecdziesiat\w*/, 50],
  [/szescdziesiat\w*/, 60],
  [/siedemdziesiat\w*/, 70],
  [/osiemdziesiat\w*/, 80],
  [/dziewiecdziesiat\w*/, 90],
  [/setn\w*/, 100],
];

/** Klucze pol, w ktorych trzymana jest liczba lat / rocznica. */
const AGE_FIELD_HINTS = ['age', 'wiek', 'lat', 'rocznic'];

const MONTHS = [
  'stycznia',
  'lutego',
  'marca',
  'kwietnia',
  'maja',
  'czerwca',
  'lipca',
  'sierpnia',
  'wrzesnia',
  'pazdziernika',
  'listopada',
  'grudnia',
];

export interface StaleContentIssue {
  field: string;
  message: string;
}

function flatten(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Liczba lat wskazana przez klienta - z pola, ktore o nia pyta.
 *
 * Bierzemy wylacznie wartosci czysto liczbowe do trzech cyfr: pole "Liczba
 * lat" ma na kartce postac cyfry, a wszystko inne (data, kwota) nie jest tym,
 * z czym mamy porownywac tresc.
 */
function findAge(values: Record<string, unknown>): { key: string; age: number } | null {
  for (const [key, raw] of Object.entries(values)) {
    const flatKey = flatten(key);
    if (!AGE_FIELD_HINTS.some((hint) => flatKey.includes(hint))) continue;

    const text = String(raw ?? '').trim();
    if (!/^\d{1,3}$/.test(text)) continue;

    return { key, age: Number(text) };
  }

  return null;
}

/** Liczebnik wieku ukryty w tresci - slownie ("osiemnastych") albo cyfra ("18. urodzin"). */
function findAgeInText(text: string): { age: number; excerpt: string } | null {
  const flat = flatten(text);

  const digits = flat.match(/\b(\d{1,3})\s*[.-]?\s*(?:tych|tego|lecia|lecie)?\s*(urodzin|rocznic)/);
  if (digits) return { age: Number(digits[1]), excerpt: digits[0].trim() };

  for (const [pattern, age] of ORDINAL_WORDS) {
    const match = flat.match(new RegExp(`\\b${pattern.source}\\s+(urodzin\\w*|rocznic\\w*)`));
    if (match) return { age, excerpt: match[0].trim() };
  }

  return null;
}

/** Data z tresci - "16.08.2029", "12 czerwca 2026" albo sam rok. */
function findDate(text: string): { date: Date; excerpt: string; yearOnly: boolean } | null {
  const numeric = text.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\b/);
  if (numeric) {
    const [excerpt, day, month, year] = numeric;
    return { date: new Date(Number(year), Number(month) - 1, Number(day)), excerpt, yearOnly: false };
  }

  const flat = flatten(text);
  const spelled = flat.match(/\b(\d{1,2})\s+([a-z]+)\s+(\d{4})\b/);
  if (spelled) {
    const monthIndex = MONTHS.indexOf(spelled[2]);
    if (monthIndex >= 0) {
      return {
        date: new Date(Number(spelled[3]), monthIndex, Number(spelled[1])),
        excerpt: spelled[0],
        yearOnly: false,
      };
    }
  }

  const year = text.match(/\b(20\d{2})\b/);
  if (year) return { date: new Date(Number(year[1]), 11, 31), excerpt: year[1], yearOnly: true };

  return null;
}

/**
 * Przeglada odpowiedzi wspolne pod katem tresci z innej uroczystosci.
 *
 * `now` jest parametrem, zeby test nie zalezal od dnia uruchomienia.
 */
export function findStaleContent(
  fields: Array<{ key: string; label: string; type: string }>,
  values: Record<string, unknown>,
  now: Date = new Date()
): StaleContentIssue[] {
  const issues: StaleContentIssue[] = [];
  const age = findAge(values);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  for (const field of fields) {
    // Data z kalendarza ma wlasna walidacje formatu, a jej tresc pochodzi
    // z klikniecia, nie z przepisywania cudzego przykladu.
    if (field.type === 'date') continue;

    const text = String(values[field.key] ?? '').trim();
    if (!text) continue;
    if (age && field.key === age.key) continue;

    const inText = findAgeInText(text);
    if (age && inText && inText.age !== age.age) {
      issues.push({
        field: field.key,
        message: `treść mówi o „${inText.excerpt}”, a liczba lat na zaproszeniu to ${age.age} — sprawdź, czy to celowe`,
      });
    }

    const date = findDate(text);
    if (date && date.date < today) {
      issues.push({
        field: field.key,
        message: date.yearOnly
          ? `rok ${date.excerpt} w treści już minął — sprawdź, czy to nie zapis z przykładu`
          : `data ${date.excerpt} już minęła — sprawdź, czy to nie zapis z przykładu`,
      });
    }
  }

  return issues;
}
