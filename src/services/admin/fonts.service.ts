import fs from 'fs/promises';
import path from 'path';

const FONTS_DIR = path.join(process.cwd(), 'storage', 'fonts');
const ALLOWED_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'];
const FONTS_LIST_CACHE_TTL_MS = Number(process.env.FONTS_LIST_CACHE_TTL_MS ?? 5 * 60_000);

export interface FontItem {
  id: string;       // fileName without extension (safe name)
  family: string;   // Display name (original name without extension)
  fileName: string;
  filePath: string; // relative from storage/
  fileSize: number;
  format: string;   // ttf | otf | woff | woff2
}

type FontsListCacheEntry = {
  fonts: FontItem[];
  expiresAt: number;
};

let fontsListCache: FontsListCacheEntry | null = null;

async function ensureFontsDir(): Promise<void> {
  await fs.mkdir(FONTS_DIR, { recursive: true });
}

export function clearFontsListCache(): void {
  fontsListCache = null;
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
