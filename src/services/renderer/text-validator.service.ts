// @ts-expect-error - opentype.js nie ma oficjalnych typów
import opentype from 'opentype.js';
import path from 'path';
import fs from 'fs/promises';

interface ValidationError {
  field: string;
  message: string;
  severity: 'error' | 'warning';
  details?: {
    actualWidth?: number;
    maxWidth?: number;
    actualLines?: number;
    maxLines?: number;
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

// Cache dla załadowanych fontów
const fontCache = new Map<string, opentype.Font>();
const FONTS_DIR = path.join(__dirname, '../../templates/fonts');

// Domyślne ograniczenia
const DEFAULT_MAX_LINES = 10;
const DEFAULT_FONT_SIZE = 16;

// Dozwolone znaki (polskie + podstawowe)
const ALLOWED_CHARS_REGEX = /^[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ0-9\s.,!?():\-'"\n]+$/;

/**
 * Ładuje font z pliku
 */
async function loadFont(fontFamily: string, weight: number = 400): Promise<opentype.Font | null> {
  const cacheKey = `${fontFamily}-${weight}`;

  if (fontCache.has(cacheKey)) {
    return fontCache.get(cacheKey)!;
  }

  // Mapowanie nazwy fontu na plik
  const fontFiles: Record<string, string> = {
    'Playfair Display-400': 'PlayfairDisplay-Regular.ttf',
    'Playfair Display-700': 'PlayfairDisplay-Bold.ttf',
    'Inter-400': 'Inter-Regular.ttf',
    'Inter-700': 'Inter-Bold.ttf',
  };

  const fontFile = fontFiles[cacheKey] || fontFiles['Inter-400'];
  const fontPath = path.join(FONTS_DIR, fontFile);

  try {
    await fs.access(fontPath);
    const font = await opentype.load(fontPath);
    fontCache.set(cacheKey, font);
    return font;
  } catch (error) {
    console.warn(`[TextValidator] Font not found: ${fontPath}, using fallback`);
    return null;
  }
}

/**
 * Mierzy szerokość tekstu w danym foncie
 */
async function measureTextWidth(
  text: string,
  fontFamily: string = 'Inter',
  fontSize: number = DEFAULT_FONT_SIZE,
  fontWeight: number = 400
): Promise<number> {
  const font = await loadFont(fontFamily, fontWeight);

  if (!font) {
    // Fallback: przybliżone obliczenie (0.6 * fontSize na znak)
    return text.length * fontSize * 0.6;
  }

  // opentype.js getAdvanceWidth zwraca szerokość w jednostkach fontu
  // Trzeba przeskalować do pikseli: width * fontSize / unitsPerEm
  const advanceWidth = font.getAdvanceWidth(text, fontSize);
  return advanceWidth;
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
      const lineWidth = await measureTextWidth(lines[i], fontFamily, fontSize, fontWeight);

      if (lineWidth > maxWidth) {
        errors.push({
          field: fieldConfig.key,
          message: `Linia ${i + 1} w polu "${fieldConfig.label}" jest za długa`,
          severity: 'error',
          details: {
            actualWidth: Math.round(lineWidth),
            maxWidth: maxWidth,
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
