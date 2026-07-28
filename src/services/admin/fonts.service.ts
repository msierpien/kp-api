import fs from 'fs/promises';
import path from 'path';
import * as fontkit from 'fontkit';

const FONTS_DIR = path.join(process.cwd(), 'storage', 'fonts');
const ALLOWED_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'];
const FONTS_LIST_CACHE_TTL_MS = Number(process.env.FONTS_LIST_CACHE_TTL_MS ?? 5 * 60_000);

/**
 * Formaty, ktore node-canvas potrafi zarejestrowac do druku. woff/woff2 sa
 * przydatne w przegladarce (podglad klienta), ale renderer serwerowy je pomija
 * i wydruk cicho spada na krój systemowy - dlatego kazdy font niesie flage
 * `printable`, a panel na jej podstawie ostrzega.
 */
export const PRINTABLE_FONT_FORMATS = ['ttf', 'otf'];

export interface FontItem {
  id: string;       // fileName without extension (safe name)
  family: string;   // Display name (original name without extension)
  fileName: string;
  filePath: string; // relative from storage/
  fileSize: number;
  format: string;   // ttf | otf | woff | woff2
  /** Czy krój zadziała w druku (renderer serwerowy rejestruje tylko TTF/OTF). */
  printable: boolean;
  /**
   * Rodzina typograficzna z pliku (name ID 16, z fallbackiem na ID 1).
   * Laczy warianty jednego kroju: LobsterTwo-Bold i LobsterTwo-Italic maja
   * tu obie "Lobster Two", wiec panel pokazuje jedna pozycje z wyborem wagi.
   */
  typographicFamily: string;
  /** Waga z OS/2 (100-900). */
  weight: number;
  style: 'normal' | 'italic';
  /** Nazwa wariantu w rodzinie, np. "SemiBold Italic". */
  variantLabel: string;
  /** Krój zmienny - plik niesie os wagi, nie pojedyncza wartosc. */
  variable: boolean;
}

/** Metadane odczytane z pliku; brak = plik nie do rozczytania. */
type FontMetadata = Pick<FontItem, 'typographicFamily' | 'weight' | 'style' | 'variantLabel' | 'variable'>;

function pickNameRecord(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, string>;
    return record.en || Object.values(record)[0] || '';
  }
  return '';
}

/**
 * Rodzina, waga i styl wprost z pliku.
 *
 * Nazwa pliku klamie: "CormorantInfant-SemiBold.ttf" to rodzina
 * "Cormorant Infant" w wadze 600, a nie osobny krój "CormorantInfant SemiBold".
 * Bez tego panel pokazywal kilkanascie pozycji tego samego kroju, a wybor wagi
 * nie mial czego zmieniac.
 */
async function readFontMetadata(fullPath: string, format: string): Promise<FontMetadata | null> {
  if (!PRINTABLE_FONT_FORMATS.includes(format)) return null;

  try {
    const font: any = await fontkit.open(fullPath);
    if (!font || font.type === 'TTC' || font.type === 'DFont') return null;

    const records = font.name?.records ?? {};
    const preferredFamily = pickNameRecord(records.preferredFamily);
    const preferredSubfamily = pickNameRecord(records.preferredSubfamily);
    const family = preferredFamily || font.familyName || '';
    if (!family) return null;

    const subfamily = preferredSubfamily || font.subfamilyName || 'Regular';
    const weight = Number(font['OS/2']?.usWeightClass) || 400;
    const italic = /italic|oblique/i.test(subfamily) || Number(font.italicAngle) !== 0;
    const variable = Boolean(font.variationAxes && Object.keys(font.variationAxes).length > 0);

    return {
      typographicFamily: family.trim(),
      weight: Math.min(900, Math.max(100, weight)),
      style: italic ? 'italic' : 'normal',
      variantLabel: subfamily.trim() || 'Regular',
      variable,
    };
  } catch (error) {
    console.warn(`[Fonts] Nie udalo sie odczytac metadanych z ${path.basename(fullPath)}:`, error);
    return null;
  }
}

/** Metadane zastepcze, gdy pliku nie da sie rozczytac (np. woff2). */
function fallbackMetadata(family: string): FontMetadata {
  return {
    typographicFamily: family,
    weight: 400,
    style: /italic/i.test(family) ? 'italic' : 'normal',
    variantLabel: 'Regular',
    variable: false,
  };
}

type FontsListCacheEntry = {
  fonts: FontItem[];
  expiresAt: number;
};

let fontsListCache: FontsListCacheEntry | null = null;

/**
 * Rosnie przy kazdym wgraniu i usunieciu kroju. Konsumenci, ktorzy trzymaja
 * WLASNY cache pochodny od rejestru (np. walidator tekstu pamieta rozparsowane
 * pliki i zapamietane braki), moga po tej liczbie poznac, ze rejestr sie
 * zmienil - bez importu w druga strone, ktory zrobilby cykl.
 */
let fontsRegistryVersion = 0;

export function getFontsRegistryVersion(): number {
  return fontsRegistryVersion;
}

async function ensureFontsDir(): Promise<void> {
  await fs.mkdir(FONTS_DIR, { recursive: true });
}

export function clearFontsListCache(): void {
  fontsListCache = null;
  fontsRegistryVersion += 1;
}

export async function listFonts(): Promise<FontItem[]> {
  if (fontsListCache && fontsListCache.expiresAt > Date.now()) {
    return fontsListCache.fonts;
  }

  await ensureFontsDir();
  const entries = await fs.readdir(FONTS_DIR, { withFileTypes: true });

  const fonts = await Promise.all(entries.map(async (entry): Promise<FontItem | null> => {
    if (!entry.isFile()) return null;
    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) return null;

    const fullPath = path.join(FONTS_DIR, entry.name);
    const stat = await fs.stat(fullPath);
    const baseName = path.basename(entry.name, ext);
    const family = baseName.replace(/_/g, ' ');
    const format = ext.replace('.', '');
    const metadata = (await readFontMetadata(fullPath, format)) ?? fallbackMetadata(family);

    return {
      id: baseName,
      family,
      fileName: entry.name,
      filePath: `fonts/${entry.name}`,
      fileSize: stat.size,
      format,
      printable: PRINTABLE_FONT_FORMATS.includes(format),
      ...metadata,
    };
  }));

  const result = fonts
    .filter((font): font is FontItem => Boolean(font))
    .sort((a, b) => a.family.localeCompare(b.family));

  fontsListCache = {
    fonts: result,
    expiresAt: Date.now() + FONTS_LIST_CACHE_TTL_MS,
  };

  return result;
}

/**
 * Plik kroju dla rodziny, wagi i stylu z warstwy.
 *
 * Layout moze trzymac nazwe pliku ("LobsterTwo-Bold" - starsze szablony) albo
 * rodzine typograficzna ("Lobster Two" - panel po zgrupowaniu wariantow).
 * Obie drogi musza trafiac w ten sam plik, inaczej podglad i wydruk pokazuja
 * inny krój niz edytor.
 */
export async function resolveFontFile(
  fontFamily: string,
  weight: number = 400,
  style: 'normal' | 'italic' = 'normal'
): Promise<FontItem | null> {
  const wanted = fontFamily.trim().toLowerCase();
  if (!wanted) return null;

  const available = await listFonts();
  const printable = available.filter((font) => PRINTABLE_FONT_FORMATS.includes(font.format.toLowerCase()));

  const variants = printable.filter((font) => font.typographicFamily.toLowerCase() === wanted);
  if (variants.length > 0) return pickFontVariant(variants, weight, style);

  // Starsze szablony trzymaja nazwe pliku - wtedy rodzina jest jednoelementowa.
  const byFileName = printable.find((font) => font.family.toLowerCase() === wanted);
  if (byFileName) return byFileName;

  // Ostatnia proba: rodzina z nazwy pliku bez wariantu ("Montserrat Bold").
  const looseMatch = printable.filter((font) => font.family.toLowerCase().startsWith(`${wanted} `));
  return looseMatch.length > 0 ? pickFontVariant(looseMatch, weight, style) : null;
}

/**
 * Wariant o zadanym stylu i najblizszej wadze.
 *
 * Pliki stale maja pierwszenstwo przed krojem zmiennym: node-canvas rejestruje
 * krój zmienny w instancji domyslnej i nie umie ruszyc osi wagi, wiec przy
 * wyborze 600 wydrukowalby Light. Krój zmienny zostaje jako ostatnia deska
 * ratunku, gdy rodzina nie ma plikow statycznych.
 */
export function pickFontVariant(variants: FontItem[], weight: number, style: 'normal' | 'italic'): FontItem {
  const sameStyle = variants.filter((font) => font.style === style);
  const pool = sameStyle.length > 0 ? sameStyle : variants;
  const staticFonts = pool.filter((font) => !font.variable);
  const candidates = staticFonts.length > 0 ? staticFonts : pool;

  return candidates.reduce(
    (best, font) => (Math.abs(font.weight - weight) < Math.abs(best.weight - weight) ? font : best),
    candidates[0]
  );
}

export async function uploadFont(
  fileBuffer: Buffer,
  originalFileName: string
): Promise<FontItem> {
  await ensureFontsDir();

  const ext = path.extname(originalFileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(`Niedozwolony format czcionki: ${ext}. Dozwolone: TTF, OTF, WOFF, WOFF2`);
  }

  const baseName = path.basename(originalFileName, ext);
  const safeBaseName = baseName.replace(/[^a-zA-Z0-9_\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, '_');
  const fileName = `${safeBaseName}${ext}`;
  const fullPath = path.join(FONTS_DIR, fileName);

  await fs.writeFile(fullPath, fileBuffer);
  clearFontsListCache();

  const family = safeBaseName.replace(/_/g, ' ');
  const format = ext.replace('.', '');
  const metadata = (await readFontMetadata(fullPath, format)) ?? fallbackMetadata(family);

  return {
    id: safeBaseName,
    family,
    fileName,
    filePath: `fonts/${fileName}`,
    fileSize: fileBuffer.length,
    format,
    printable: PRINTABLE_FONT_FORMATS.includes(format),
    ...metadata,
  };
}

export async function deleteFont(fileName: string): Promise<void> {
  await ensureFontsDir();
  const ext = path.extname(fileName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error('Niedozwolona nazwa pliku');
  }
  // Prevent path traversal
  const safeName = path.basename(fileName);
  const fullPath = path.join(FONTS_DIR, safeName);

  try {
    await fs.unlink(fullPath);
    clearFontsListCache();
  } catch {
    throw new Error(`Czcionka nie znaleziona: ${safeName}`);
  }
}
