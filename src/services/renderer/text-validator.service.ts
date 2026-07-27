// @ts-expect-error - opentype.js nie ma oficjalnych typów
import opentype from 'opentype.js';
import path from 'path';
import fs from 'fs/promises';
import { getFontsRegistryVersion, listFonts, PRINTABLE_FONT_FORMATS } from '../admin/fonts.service';

interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  details?: {
    actualWidth?: number;
    maxWidth?: number;
    actualLines?: number;
    maxLines?: number;
    /** Czy szerokosc zmierzono realnym plikiem fontu (patrz measureTextWidth). */
    measured?: boolean;
  };
}

interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

interface FieldConfig {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  // Layout config
  width?: number; // max width w px
  maxLines?: number;
  font?: {
    family?: string;
    size?: number;
    weight?: number;
  };
}

interface AnswersData {
  [key: string]: string | number | boolean | undefined;
}

// Cache dla załadowanych fontów. `null` to zapamietany brak kroju w rejestrze -
// bez tego kazde pole kazdej sztuki czytaloby katalog na nowo. Cache pada
// w calosci, gdy rejestr sie zmieni: inaczej krój wgrany minute temu wciaz
// byloby widziany jako brakujacy.
const fontCache = new Map<string, opentype.Font | null>();
let fontCacheRegistryVersion = getFontsRegistryVersion();

function invalidateFontCacheOnRegistryChange(): void {
  const current = getFontsRegistryVersion();
  if (current !== fontCacheRegistryVersion) {
    fontCache.clear();
    fontCacheRegistryVersion = current;
  }
}

// Domyślne ograniczenia
const DEFAULT_MAX_LINES = 10;
const DEFAULT_FONT_SIZE = 16;

// Dozwolone znaki (polskie + podstawowe)
const ALLOWED_CHARS_REGEX = /^[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ0-9\s.,!?():\-'"\n]+$/;

/**
 * Nazwy wariantow, ktore w rejestrze wystepuja jako osobne pliki
 * ("Montserrat_Bold.ttf" -> rodzina "Montserrat Bold"). Dla wagi 700 chcemy
 * zmierzyc tekst faktycznym boldem, bo jest zauwazalnie szerszy od regulara.
 */
function familyCandidates(fontFamily: string, weight: number): string[] {
  const base = fontFamily.trim();
  if (!base) return [];
  if (weight >= 600) return [`${base} Bold`, `${base} SemiBold`, base];
  if (weight <= 300) return [`${base} Light`, base];
  return [base, `${base} Regular`];
}

/**
 * Laduje krój z REJESTRU czcionek (`storage/fonts`) - tego samego, z ktorego
 * korzysta renderer.
 *
 * Wczesniej funkcja siegala po zaszyta mape czterech plikow w
 * `src/templates/fonts` - katalog nie istnieje, wiec KAZDY pomiar spadal na
 * `0.6 * fontSize` na znak i komunikat "za dlugie" nie znaczyl nic.
 *
 * Ograniczenie do TTF/OTF jest celowe: to jedyne formaty, ktore renderer
 * potrafi zarejestrowac do druku, wiec tylko dla nich pomiar odpowiada temu,
 * co realnie wyjdzie na wydruku.
 */
async function loadFont(fontFamily: string, weight: number = 400): Promise<opentype.Font | null> {
  const cacheKey = `${fontFamily}-${weight}`;

  invalidateFontCacheOnRegistryChange();

  if (fontCache.has(cacheKey)) {
    return fontCache.get(cacheKey)!;
  }

  try {
    const available = await listFonts();
    const printable = available.filter((font) =>
      PRINTABLE_FONT_FORMATS.includes(font.format.toLowerCase())
    );

    const match = familyCandidates(fontFamily, weight)
      .map((candidate) =>
        printable.find((font) => font.family.toLowerCase() === candidate.toLowerCase())
      )
      .find((font) => Boolean(font));

    if (!match) {
      console.warn(
        `[TextValidator] Brak czcionki "${fontFamily}" (${weight}) w rejestrze - ` +
          `pomiar szerokosci bedzie przyblizony. Wgraj plik TTF/OTF w panelu (Czcionki).`
      );
      fontCache.set(cacheKey, null);
      return null;
    }

    const fontPath = path.join(process.cwd(), 'storage', match.filePath);
    await fs.access(fontPath);
    const font = await opentype.load(fontPath);
    fontCache.set(cacheKey, font);
    return font;
  } catch (error) {
    console.warn(`[TextValidator] Nie udalo sie zaladowac czcionki "${fontFamily}":`, error);
    fontCache.set(cacheKey, null);
    return null;
  }
}

/**
 * Mierzy szerokość tekstu w danym foncie.
 *
 * `measured: false` oznacza, ze kroju nie bylo w rejestrze i szerokosc jest
 * zgadywana - wolajacy ma wtedy zejsc z bledu na ostrzezenie, zamiast blokowac
 * klienta na podstawie zmyslonej liczby.
 */
async function measureTextWidth(
  text: string,
  fontFamily: string = 'Inter',
  fontSize: number = DEFAULT_FONT_SIZE,
  fontWeight: number = 400
): Promise<{ width: number; measured: boolean }> {
  const font = await loadFont(fontFamily, fontWeight);

  if (!font) {
    // Fallback: przybliżone obliczenie (0.6 * fontSize na znak)
    return { width: text.length * fontSize * 0.6, measured: false };
  }

  // opentype.js getAdvanceWidth zwraca szerokość w jednostkach fontu
  // Trzeba przeskalować do pikseli: width * fontSize / unitsPerEm
  return { width: font.getAdvanceWidth(text, fontSize), measured: true };
}

/**
 * Normalizuje tekst (trim, usuwa podwójne spacje)
 */
function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .trim()
    .replace(/  +/g, ' ') // podwójne spacje na pojedyncze
    .replace(/\n\n+/g, '\n'); // podwójne entery na pojedyncze
}

/**
 * Waliduje pojedynczą wartość pola
 */
async function validateField(
  fieldConfig: FieldConfig,
  value: string | number | boolean | undefined
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];
  const strValue = value !== undefined ? String(value) : '';
  const normalizedValue = normalizeText(strValue);

  // Pole wymagane
  if (fieldConfig.required && !normalizedValue) {
    errors.push({
      field: fieldConfig.key,
      message: `Pole "${fieldConfig.label}" jest wymagane`,
      severity: 'error',
    });
    return errors; // nie kontynuuj walidacji pustego pola
  }

  // Jeśli pole puste i niewymagane - OK
  if (!normalizedValue) {
    return errors;
  }

  // Minimalna długość
  if (fieldConfig.minLength && normalizedValue.length < fieldConfig.minLength) {
    errors.push({
      field: fieldConfig.key,
      message: `Pole "${fieldConfig.label}" musi mieć minimum ${fieldConfig.minLength} znaków`,
      severity: 'error',
    });
  }

  // Maksymalna długość
  if (fieldConfig.maxLength && normalizedValue.length > fieldConfig.maxLength) {
    errors.push({
      field: fieldConfig.key,
      message: `Pole "${fieldConfig.label}" może mieć maksimum ${fieldConfig.maxLength} znaków`,
      severity: 'error',
    });
  }

  // Pattern (regex)
  if (fieldConfig.pattern) {
    const regex = new RegExp(fieldConfig.pattern);
    if (!regex.test(normalizedValue)) {
      errors.push({
        field: fieldConfig.key,
        message: `Pole "${fieldConfig.label}" ma nieprawidłowy format`,
        severity: 'error',
      });
    }
  }

  // Walidacja znaków
  if (fieldConfig.type === 'text' || fieldConfig.type === 'textarea') {
    if (!ALLOWED_CHARS_REGEX.test(normalizedValue)) {
      // Znajdź niedozwolone znaki
      const invalidChars = normalizedValue
        .split('')
        .filter(char => !ALLOWED_CHARS_REGEX.test(char))
        .filter((char, index, arr) => arr.indexOf(char) === index);

      errors.push({
        field: fieldConfig.key,
        message: `Pole "${fieldConfig.label}" zawiera niedozwolone znaki: ${invalidChars.join(', ')}`,
        severity: 'warning',
      });
    }
  }

  // Walidacja email
  if (fieldConfig.type === 'email') {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedValue)) {
      errors.push({
        field: fieldConfig.key,
        message: `Nieprawidłowy format email w polu "${fieldConfig.label}"`,
        severity: 'error',
      });
    }
  }

  // Walidacja szerokości tekstu (dla pól z layoutem)
  if (fieldConfig.width && (fieldConfig.type === 'text' || fieldConfig.type === 'textarea')) {
    const maxWidth = fieldConfig.width;
    const fontSize = fieldConfig.font?.size || DEFAULT_FONT_SIZE;
    const fontFamily = fieldConfig.font?.family || 'Inter';
    const fontWeight = fieldConfig.font?.weight || 400;

    const lines = normalizedValue.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const { width: lineWidth, measured } = await measureTextWidth(
        lines[i],
        fontFamily,
        fontSize,
        fontWeight
      );

      if (lineWidth > maxWidth) {
        // Bez kroju w rejestrze szerokosc jest zgadywana - nie blokujemy
        // klienta liczba, ktorej sami nie umiemy obronic.
        errors.push({
          field: fieldConfig.key,
          message: measured
            ? `Linia ${i + 1} w polu "${fieldConfig.label}" jest za długa`
            : `Linia ${i + 1} w polu "${fieldConfig.label}" może być za długa (brak kroju w rejestrze — pomiar przybliżony)`,
          severity: measured ? 'error' : 'warning',
          details: {
            actualWidth: Math.round(lineWidth),
            maxWidth: maxWidth,
            measured,
          },
        });
      }
    }

    // Walidacja liczby linii
    const maxLines = fieldConfig.maxLines || DEFAULT_MAX_LINES;
    if (lines.length > maxLines) {
      errors.push({
        field: fieldConfig.key,
        message: `Pole "${fieldConfig.label}" ma za dużo linii (max ${maxLines})`,
        severity: 'error',
        details: {
          actualLines: lines.length,
          maxLines: maxLines,
        },
      });
    }
  }

  return errors;
}

/**
 * Waliduje wszystkie odpowiedzi
 */
export async function validateAnswers(
  answers: AnswersData,
  fields: FieldConfig[]
): Promise<ValidationResult> {
  const allErrors: ValidationError[] = [];

  for (const field of fields) {
    const value = answers[field.key];
    const fieldErrors = await validateField(field, value);
    allErrors.push(...fieldErrors);
  }

  const errors = allErrors.filter(e => e.severity === 'error');
  const warnings = allErrors.filter(e => e.severity === 'warning');

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Pobiera informacje o foncie
 */
export async function getFontMetrics(
  fontFamily: string,
  fontSize: number,
  fontWeight: number = 400
): Promise<{
  ascender: number;
  descender: number;
  lineHeight: number;
} | null> {
  const font = await loadFont(fontFamily, fontWeight);

  if (!font) return null;

  const scale = fontSize / font.unitsPerEm;

  return {
    ascender: font.ascender * scale,
    descender: font.descender * scale,
    lineHeight: (font.ascender - font.descender) * scale * 1.2, // 1.2 line-height
  };
}

/**
 * Czyści cache fontów
 */
export function clearFontCache(): void {
  fontCache.clear();
}
