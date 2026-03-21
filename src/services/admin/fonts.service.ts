import fs from 'fs/promises';
import path from 'path';

const FONTS_DIR = path.join(process.cwd(), 'storage', 'fonts');
const ALLOWED_MIME_TYPES = [
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'application/font-woff',
  'application/font-woff2',
  'application/x-font-ttf',
  'application/x-font-opentype',
  'application/octet-stream', // Some browsers send this for fonts
];
const ALLOWED_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'];

export interface FontItem {
  id: string;       // fileName without extension (safe name)
  family: string;   // Display name (original name without extension)
  fileName: string;
  filePath: string; // relative from storage/
  fileSize: number;
  format: string;   // ttf | otf | woff | woff2
}

async function ensureFontsDir(): Promise<void> {
  await fs.mkdir(FONTS_DIR, { recursive: true });
}

export async function listFonts(): Promise<FontItem[]> {
  await ensureFontsDir();
  const entries = await fs.readdir(FONTS_DIR, { withFileTypes: true });
  const fonts: FontItem[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) continue;

    const fullPath = path.join(FONTS_DIR, entry.name);
    const stat = await fs.stat(fullPath);
    const baseName = path.basename(entry.name, ext);
    const family = baseName.replace(/_/g, ' ');

    fonts.push({
      id: baseName,
      family,
      fileName: entry.name,
      filePath: `fonts/${entry.name}`,
      fileSize: stat.size,
      format: ext.replace('.', ''),
    });
  }

  return fonts.sort((a, b) => a.family.localeCompare(b.family));
}

export async function uploadFont(
  fileBuffer: Buffer,
  originalFileName: string,
  mimeType: string
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
  } catch {
    throw new Error(`Czcionka nie znaleziona: ${safeName}`);
  }
}
