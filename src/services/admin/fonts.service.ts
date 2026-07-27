import fs from 'fs/promises';
import path from 'path';

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

    return {
      id: baseName,
      family,
      fileName: entry.name,
      filePath: `fonts/${entry.name}`,
      fileSize: stat.size,
      format: ext.replace('.', ''),
      printable: PRINTABLE_FONT_FORMATS.includes(ext.replace('.', '')),
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

  return {
    id: safeBaseName,
    family,
    fileName,
    filePath: `fonts/${fileName}`,
    fileSize: fileBuffer.length,
    format: ext.replace('.', ''),
    printable: PRINTABLE_FONT_FORMATS.includes(ext.replace('.', '')),
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
