import fs from 'fs/promises';
import path from 'path';
import { nanoid } from 'nanoid';
import prisma from '../../lib/prisma';
import { config } from '../../config';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { buildStorageUrl } from '../storage/local-storage.service';
import { sanitizeSvg, svgSupportsTint } from '../../lib/svg-sanitizer';
import { assertAllowedImageUpload } from '../../lib/upload-validation';

/** Kategorie z makiety edytora klienta. */
export const DECORATION_CATEGORIES = ['SLUBNE', 'KWIATOWE', 'LINIE', 'MONOGRAMY'] as const;
export type DecorationCategory = (typeof DECORATION_CATEGORIES)[number];

export const DECORATION_CATEGORY_LABELS: Record<DecorationCategory, string> = {
  SLUBNE: 'Ślubne',
  KWIATOWE: 'Kwiatowe',
  LINIE: 'Linie',
  MONOGRAMY: 'Monogramy',
};

export const MAX_DECORATION_BYTES = 2 * 1024 * 1024;

/** Ozdobniki leza poza katalogami spraw - to biblioteka, nie plik zamowienia. */
const DECORATIONS_DIR = 'decorations';

export interface DecorationView {
  id: string;
  category: DecorationCategory;
  name: string;
  filePath: string;
  url: string;
  mimeType: string;
  fileSize: number;
  /** SVG z `currentColor` da sie przebarwic na kolor z palety projektu. */
  tintable: boolean;
  sortOrder: number;
}

function requireTenantId(): string {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;
  if (!tenantId) {
    throw new Error('Tenant context is required for decorations');
  }
  return tenantId;
}

export function isDecorationCategory(value: unknown): value is DecorationCategory {
  return typeof value === 'string' && (DECORATION_CATEGORIES as readonly string[]).includes(value);
}

function toView(row: {
  id: string;
  category: string;
  name: string;
  filePath: string;
  mimeType: string;
  fileSize: number;
  tintable: boolean;
  sortOrder: number;
}): DecorationView {
  return {
    id: row.id,
    category: row.category as DecorationCategory,
    name: row.name,
    filePath: row.filePath,
    url: buildStorageUrl(row.filePath),
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    tintable: row.tintable,
    sortOrder: row.sortOrder,
  };
}

/**
 * Lista ozdobnikow sprzedawcy. `tenantId` podawany wprost przez publiczny
 * portal (nie ma tam kontekstu admina - tenant bierze sie ze sprawy).
 */
export async function listDecorations(options: { tenantId?: string } = {}): Promise<DecorationView[]> {
  const tenantId = options.tenantId || requireTenantId();

  const rows = await prisma.decorationAsset.findMany({
    where: { tenantId, isActive: true },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  return rows.map(toView);
}

export async function uploadDecoration(options: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  category: DecorationCategory;
  name?: string;
}): Promise<DecorationView> {
  const tenantId = requireTenantId();
  const { buffer, fileName, mimeType, category } = options;

  const isSvg = mimeType === 'image/svg+xml' || fileName.toLowerCase().endsWith('.svg');
  let payload = buffer;
  let tintable = false;
  let extension = 'png';
  let finalMime = mimeType;

  if (isSvg) {
    // Sanityzacja przed zapisem: plik trafia do storage i na nasza domene,
    // wiec czyscimy go raz, u wejscia.
    const clean = sanitizeSvg(buffer.toString('utf-8'));
    payload = Buffer.from(clean, 'utf-8');
    tintable = svgSupportsTint(clean);
    extension = 'svg';
    finalMime = 'image/svg+xml';
  } else {
    assertAllowedImageUpload(buffer, mimeType, { maxBytes: MAX_DECORATION_BYTES });
    extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png';
  }

  if (payload.length > MAX_DECORATION_BYTES) {
    throw new Error('Plik jest za duży (maksymalnie 2 MB)');
  }

  const baseName = path.basename(fileName, path.extname(fileName));
  const safeName = baseName.replace(/[^a-zA-Z0-9_\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ ]/g, '_').slice(0, 60);
  const storedName = `${nanoid(10)}.${extension}`;
  const relativePath = path.join(DECORATIONS_DIR, tenantId, storedName);
  const fullPath = path.join(config.storage.path, relativePath);

  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, payload);

  const row = await prisma.decorationAsset.create({
    data: {
      tenantId,
      category,
      name: options.name?.trim() || safeName || 'Ozdobnik',
      filePath: relativePath,
      mimeType: finalMime,
      fileSize: payload.length,
      tintable,
    },
  });

  return toView(row);
}

export async function deleteDecoration(id: string): Promise<void> {
  const tenantId = requireTenantId();

  const row = await prisma.decorationAsset.findFirst({ where: { id, tenantId } });
  if (!row) throw new Error('Nie znaleziono ozdobnika');

  await prisma.decorationAsset.delete({ where: { id: row.id } });

  // Plik kasujemy best-effort: brak pliku nie moze blokowac usuniecia wpisu.
  try {
    await fs.unlink(path.join(config.storage.path, row.filePath));
  } catch {
    /* plik mogl juz zniknac */
  }
}
