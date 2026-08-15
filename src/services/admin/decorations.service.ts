import fs from 'fs/promises';
import path from 'path';
import { nanoid } from 'nanoid';
import prisma from '../../lib/prisma';
import { config } from '../../config';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { buildStorageUrl } from '../storage/local-storage.service';
import { prepareSvgArtwork, sanitizeSvg, svgSupportsTint } from '../../lib/svg-sanitizer';
import { assertAllowedImageUpload } from '../../lib/upload-validation';

/**
 * Kategorie startowe - te same, ktore do 2026-08-16 byly zaszyte w kodzie.
 * Dzis siedza w tabeli `decoration_categories` (wsiane migracja) i sluza juz
 * tylko za komplet dla tenanta, ktory kasowal wszystko do zera.
 */
export const DEFAULT_DECORATION_CATEGORIES: Array<{ slug: string; name: string; sortOrder: number }> = [
  { slug: 'SLUBNE', name: 'Ślubne', sortOrder: 0 },
  { slug: 'KWIATOWE', name: 'Kwiatowe', sortOrder: 1 },
  { slug: 'LINIE', name: 'Linie', sortOrder: 2 },
  { slug: 'MONOGRAMY', name: 'Monogramy', sortOrder: 3 },
];

export const MAX_DECORATION_BYTES = 2 * 1024 * 1024;

/** Ozdobniki leza poza katalogami spraw - to biblioteka, nie plik zamowienia. */
const DECORATIONS_DIR = 'decorations';

export interface DecorationCategoryView {
  id: string;
  slug: string;
  name: string;
  sortOrder: number;
  /** Ile ozdobnikow siedzi w tej grupie - panel blokuje kasowanie niepustej. */
  itemCount: number;
}

export interface DecorationView {
  id: string;
  category: string;
  name: string;
  filePath: string;
  url: string;
  mimeType: string;
  fileSize: number;
  /** SVG z `currentColor` da sie przebarwic na kolor z palety projektu. */
  tintable: boolean;
  isActive: boolean;
  sortOrder: number;
}

/** Wynik przygotowania SVG - panel raportuje z tego, co realnie zrobil. */
export interface SvgArtworkReport {
  tintableFills: number;
  removedCutPaths: number;
}

function requireTenantId(): string {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;
  if (!tenantId) {
    throw new Error('Tenant context is required for decorations');
  }
  return tenantId;
}

/**
 * Slug kategorii z nazwy podanej przez sprzedawce.
 *
 * Wielkie litery bez ogonkow, jak SLUBNE z pierwszej wersji - slug trafia
 * do `decoration_assets.category` i ma byc czytelny takze w bazie.
 */
export function slugifyCategory(name: string): string {
  const map: Record<string, string> = {
    ą: 'A', ć: 'C', ę: 'E', ł: 'L', ń: 'N', ó: 'O', ś: 'S', ź: 'Z', ż: 'Z',
  };
  return name
    .trim()
    .toLowerCase()
    .replace(/[ąćęłńóśźż]/g, (char) => map[char] || char)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function toView(row: {
  id: string;
  category: string;
  name: string;
  filePath: string;
  mimeType: string;
  fileSize: number;
  tintable: boolean;
  isActive: boolean;
  sortOrder: number;
}): DecorationView {
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    filePath: row.filePath,
    url: buildStorageUrl(row.filePath),
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    tintable: row.tintable,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
  };
}

// ============================================
// Kategorie
// ============================================

/**
 * Grupy ozdobnikow sprzedawcy razem z licznikiem plikow.
 *
 * `tenantId` podawany wprost przez publiczny portal - nie ma tam kontekstu
 * admina, tenant bierze sie ze sprawy.
 */
export async function listCategories(
  options: { tenantId?: string; ensureDefaults?: boolean } = {}
): Promise<DecorationCategoryView[]> {
  const tenantId = options.tenantId || requireTenantId();

  // Sprzedawca zalozony PO migracji nie ma jeszcze zadnej grupy, a bez grupy
  // nie da sie wgrac ozdobnika - upload nie mialby gdzie trafic. Komplet
  // startowy dosiewamy przy pierwszym wejsciu do panelu; portal klienta
  // niczego nie zapisuje, wiec wola bez tej flagi.
  if (options.ensureDefaults) {
    const existing = await prisma.decorationCategory.count({ where: { tenantId } });
    if (existing === 0) {
      await prisma.decorationCategory.createMany({
        data: DEFAULT_DECORATION_CATEGORIES.map((category) => ({ tenantId, ...category })),
        skipDuplicates: true,
      });
    }
  }

  const [rows, counts] = await Promise.all([
    prisma.decorationCategory.findMany({
      where: { tenantId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    }),
    prisma.decorationAsset.groupBy({
      by: ['category'],
      where: { tenantId },
      _count: { _all: true },
    }),
  ]);

  const countBySlug = new Map(counts.map((row) => [row.category, row._count._all]));

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    sortOrder: row.sortOrder,
    itemCount: countBySlug.get(row.slug) ?? 0,
  }));
}

export async function isDecorationCategory(value: unknown): Promise<boolean> {
  if (typeof value !== 'string' || !value.trim()) return false;
  const tenantId = requireTenantId();
  const row = await prisma.decorationCategory.findFirst({
    where: { tenantId, slug: value },
    select: { id: true },
  });
  return row !== null;
}

export async function createCategory(options: { name: string }): Promise<DecorationCategoryView> {
  const tenantId = requireTenantId();
  const name = options.name.trim();
  if (!name) throw new Error('Nazwa kategorii nie może być pusta');

  const slug = slugifyCategory(name);
  if (!slug) throw new Error('Nazwa kategorii musi zawierać litery lub cyfry');

  const existing = await prisma.decorationCategory.findFirst({ where: { tenantId, slug } });
  if (existing) throw new Error(`Kategoria „${existing.name}” już istnieje`);

  // Nowa grupa lezy na koncu listy - kolejnosc ustala sprzedawca, a nie
  // przypadkowy moment dodania.
  const last = await prisma.decorationCategory.findFirst({
    where: { tenantId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });

  const row = await prisma.decorationCategory.create({
    data: { tenantId, slug, name, sortOrder: (last?.sortOrder ?? -1) + 1 },
  });

  return { id: row.id, slug: row.slug, name: row.name, sortOrder: row.sortOrder, itemCount: 0 };
}

/**
 * Zmiana nazwy albo kolejnosci grupy.
 *
 * `slug` zostaje nietkniety: to on siedzi w `decoration_assets.category`,
 * wiec przepisanie go przy kazdej korekcie literowki osierocaloby pliki.
 */
export async function updateCategory(
  id: string,
  patch: { name?: string; sortOrder?: number }
): Promise<DecorationCategoryView> {
  const tenantId = requireTenantId();

  const row = await prisma.decorationCategory.findFirst({ where: { id, tenantId } });
  if (!row) throw new Error('Nie znaleziono kategorii');

  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) throw new Error('Nazwa kategorii nie może być pusta');

  const updated = await prisma.decorationCategory.update({
    where: { id: row.id },
    data: {
      ...(name ? { name } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    },
  });

  const itemCount = await prisma.decorationAsset.count({ where: { tenantId, category: row.slug } });

  return {
    id: updated.id,
    slug: updated.slug,
    name: updated.name,
    sortOrder: updated.sortOrder,
    itemCount,
  };
}

export async function deleteCategory(id: string): Promise<void> {
  const tenantId = requireTenantId();

  const row = await prisma.decorationCategory.findFirst({ where: { id, tenantId } });
  if (!row) throw new Error('Nie znaleziono kategorii');

  // Kategoria z plikami nie znika po cichu: ozdobniki zostalyby w bazie
  // z nieistniejacym slugiem i wypadly z biblioteki bez sladu.
  const itemCount = await prisma.decorationAsset.count({ where: { tenantId, category: row.slug } });
  if (itemCount > 0) {
    throw new Error(
      `Kategoria „${row.name}” zawiera ${itemCount} ${itemCount === 1 ? 'ozdobnik' : 'ozdobników'} — najpierw przenieś je gdzie indziej`
    );
  }

  await prisma.decorationCategory.delete({ where: { id: row.id } });
}

// ============================================
// Ozdobniki
// ============================================

/**
 * Lista ozdobnikow sprzedawcy. `tenantId` podawany wprost przez publiczny
 * portal (nie ma tam kontekstu admina - tenant bierze sie ze sprawy).
 *
 * `includeInactive` widzi tylko panel: portal klienta dostaje wylacznie
 * ozdobniki wlaczone.
 */
export async function listDecorations(
  options: { tenantId?: string; includeInactive?: boolean } = {}
): Promise<DecorationView[]> {
  const tenantId = options.tenantId || requireTenantId();

  const rows = await prisma.decorationAsset.findMany({
    where: { tenantId, ...(options.includeInactive ? {} : { isActive: true }) },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  return rows.map(toView);
}

export async function uploadDecoration(options: {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  category: string;
  name?: string;
  /**
   * Przygotowac plik do przebarwiania: twarde wypelnienia zamieniamy na
   * `currentColor`. Bez tego typowy eksport (`fill="#000000"`) trafia do
   * biblioteki jako nieprzebarwialny i nikt juz tego nie odkreci.
   */
  tintable?: boolean;
}): Promise<DecorationView & { artwork?: SvgArtworkReport }> {
  const tenantId = requireTenantId();
  const { buffer, fileName, mimeType, category } = options;

  const isSvg = mimeType === 'image/svg+xml' || fileName.toLowerCase().endsWith('.svg');
  let payload = buffer;
  let tintable = false;
  let extension = 'png';
  let finalMime = mimeType;
  let artwork: SvgArtworkReport | undefined;

  if (isSvg) {
    // Sanityzacja przed zapisem: plik trafia do storage i na nasza domene,
    // wiec czyscimy go raz, u wejscia. Zaraz potem - przygotowanie grafiki:
    // zdjecie sciezek noza z eksportow Silhouette i (na zyczenie) zamiana
    // wypelnien na `currentColor`.
    const clean = sanitizeSvg(buffer.toString('utf-8'));
    const prepared = prepareSvgArtwork(clean, { tintable: options.tintable === true });
    payload = Buffer.from(prepared.svg, 'utf-8');
    tintable = svgSupportsTint(prepared.svg);
    artwork = { tintableFills: prepared.tintableFills, removedCutPaths: prepared.removedCutPaths };
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

  // Nowy plik na koncu swojej kategorii - tak samo jak nowa kategoria
  // na koncu listy grup.
  const last = await prisma.decorationAsset.findFirst({
    where: { tenantId, category },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });

  const row = await prisma.decorationAsset.create({
    data: {
      tenantId,
      category,
      name: options.name?.trim() || safeName || 'Ozdobnik',
      filePath: relativePath,
      mimeType: finalMime,
      fileSize: payload.length,
      tintable,
      sortOrder: (last?.sortOrder ?? -1) + 1,
    },
  });

  return { ...toView(row), ...(artwork ? { artwork } : {}) };
}

/** Metadane ozdobnika: nazwa, przynaleznosc do grupy, kolejnosc, widocznosc. */
export async function updateDecoration(
  id: string,
  patch: { name?: string; category?: string; sortOrder?: number; isActive?: boolean }
): Promise<DecorationView> {
  const tenantId = requireTenantId();

  const row = await prisma.decorationAsset.findFirst({ where: { id, tenantId } });
  if (!row) throw new Error('Nie znaleziono ozdobnika');

  const name = patch.name?.trim();
  if (patch.name !== undefined && !name) throw new Error('Nazwa ozdobnika nie może być pusta');

  if (patch.category !== undefined && !(await isDecorationCategory(patch.category))) {
    throw new Error('Nieprawidłowa kategoria');
  }

  const updated = await prisma.decorationAsset.update({
    where: { id: row.id },
    data: {
      ...(name ? { name } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
    },
  });

  return toView(updated);
}

/**
 * Przygotowanie wgranego juz SVG do przebarwiania.
 *
 * Ratunek dla plikow z czasow, gdy upload tylko SPRAWDZAL obecnosc
 * `currentColor` zamiast ja wprowadzac - inaczej jedyna droga to skasowanie
 * ozdobnika i wgranie go od nowa, razem z utrata jego miejsca w bibliotece.
 */
export async function retintDecoration(
  id: string
): Promise<DecorationView & { artwork: SvgArtworkReport }> {
  const tenantId = requireTenantId();

  const row = await prisma.decorationAsset.findFirst({ where: { id, tenantId } });
  if (!row) throw new Error('Nie znaleziono ozdobnika');
  if (row.mimeType !== 'image/svg+xml') {
    throw new Error('Przebarwianie działa tylko dla plików SVG');
  }

  const fullPath = path.join(config.storage.path, row.filePath);
  const raw = await fs.readFile(fullPath, 'utf-8');
  const prepared = prepareSvgArtwork(raw, { tintable: true });

  await fs.writeFile(fullPath, prepared.svg, 'utf-8');

  const updated = await prisma.decorationAsset.update({
    where: { id: row.id },
    data: {
      tintable: svgSupportsTint(prepared.svg),
      fileSize: Buffer.byteLength(prepared.svg, 'utf-8'),
    },
  });

  return {
    ...toView(updated),
    artwork: { tintableFills: prepared.tintableFills, removedCutPaths: prepared.removedCutPaths },
  };
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
