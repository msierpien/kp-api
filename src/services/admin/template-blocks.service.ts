import fs from 'fs/promises';
import path from 'path';
import prisma from '../../lib/prisma';
import { config } from '../../config';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { normalizeTags } from '../../lib/template-tags';
import { uploadTemplateAsset } from './templates-layout.service';
import type { TemplateBlockPayload } from '../../schemas/admin.schema';

/**
 * Biblioteka blokow wielokrotnego uzytku.
 *
 * Blok to kawalek projektu bez wlasnej kartki: stopka RSVP, ramka, monogram,
 * blok adresowy. Rozni sie tym od szablonu, ktory jest calym produktem
 * (format, formularz, sklad do druku) - i wlasnie dlatego przenoszenie
 * gotowej stopki do kolejnego projektu szlo dotad przez kopiuj-wklej miedzy
 * zakladkami albo duplikowanie calego szablonu.
 *
 * Zapisujemy WSPOLRZEDNE WZGLEDNE (lewy gorny rog bounding boxa = 0,0) i
 * rozmiar w mm. Piksele zalezа od dpi szablonu, a blok ma wchodzic i do
 * winietki 90x50, i do zaproszenia 105x148.
 */

/** Ta sama bramka, co w bibliotece ozdobnikow - biblioteka jest per sprzedawca. */
function requireTenantId(): string {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;
  if (!tenantId) {
    throw new Error('Tenant context is required for template blocks');
  }
  return tenantId;
}

export interface TemplateBlockView {
  id: string;
  category: string;
  name: string;
  payload: TemplateBlockPayload;
  widthMm: number;
  heightMm: number;
  tags: string[];
  sourceTemplateId: string | null;
  isActive: boolean;
  sortOrder: number;
  /** Ile warstw niesie blok - kafel pokazuje to zamiast pustego podgladu. */
  layerCount: number;
  createdAt: Date;
}

function toView(row: {
  id: string;
  category: string;
  name: string;
  payload: unknown;
  widthMm: number;
  heightMm: number;
  tags: string[];
  sourceTemplateId: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
}): TemplateBlockView {
  const payload = row.payload as TemplateBlockPayload;
  return {
    id: row.id,
    category: row.category,
    name: row.name,
    payload,
    widthMm: row.widthMm,
    heightMm: row.heightMm,
    tags: row.tags,
    sourceTemplateId: row.sourceTemplateId,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    layerCount: Array.isArray(payload?.layers) ? payload.layers.length : 0,
    createdAt: row.createdAt,
  };
}

export async function listTemplateBlocks(options: { includeInactive?: boolean } = {}): Promise<{
  blocks: TemplateBlockView[];
  categories: string[];
}> {
  const tenantId = requireTenantId();

  const rows = await prisma.templateBlock.findMany({
    where: {
      tenantId,
      ...(options.includeInactive ? {} : { isActive: true }),
    },
    orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
  });

  const blocks = rows.map(toView);
  return {
    blocks,
    categories: [...new Set(blocks.map((block) => block.category))].sort(),
  };
}

export async function createTemplateBlock(input: {
  name: string;
  category: string;
  payload: TemplateBlockPayload;
  widthMm: number;
  heightMm: number;
  tags?: string[];
  sourceTemplateId?: string;
}): Promise<TemplateBlockView> {
  const tenantId = requireTenantId();

  const name = input.name.trim();
  if (!name) throw new Error('Podaj nazwę bloku');
  if (!Array.isArray(input.payload?.layers) || input.payload.layers.length === 0) {
    throw new Error('Blok bez warstw nie ma czego wstawiać');
  }

  const row = await prisma.templateBlock.create({
    data: {
      tenantId,
      name,
      category: input.category.trim() || 'INNE',
      payload: input.payload as any,
      widthMm: input.widthMm,
      heightMm: input.heightMm,
      tags: normalizeTags(input.tags ?? []),
      sourceTemplateId: input.sourceTemplateId ?? null,
    },
  });

  return toView(row);
}

export async function updateTemplateBlock(
  id: string,
  patch: { name?: string; category?: string; tags?: string[]; isActive?: boolean; sortOrder?: number }
): Promise<TemplateBlockView> {
  const tenantId = requireTenantId();

  const row = await prisma.templateBlock.findFirst({ where: { id, tenantId } });
  if (!row) throw new Error('Nie znaleziono bloku');

  const updated = await prisma.templateBlock.update({
    where: { id: row.id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.category !== undefined ? { category: patch.category.trim() || 'INNE' } : {}),
      ...(patch.tags !== undefined ? { tags: normalizeTags(patch.tags) } : {}),
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
    },
  });

  return toView(updated);
}

export async function deleteTemplateBlock(id: string): Promise<void> {
  const tenantId = requireTenantId();

  const row = await prisma.templateBlock.findFirst({ where: { id, tenantId } });
  if (!row) throw new Error('Nie znaleziono bloku');

  await prisma.templateBlock.delete({ where: { id: row.id } });
}

export interface CopiedAsset {
  /** Sciezka z bloku - po niej panel podmienia `imageUrl` w warstwach. */
  from: string;
  /** Sciezka juz w assetach szablonu docelowego. */
  to: string;
}

/**
 * Kopiuje grafiki bloku do assetow szablonu docelowego.
 *
 * Bez tego wstawiony blok wskazywalby pliki INNEGO szablonu: dzialaloby do
 * pierwszego porzadku w tamtych assetach, a potem zostawaloby puste miejsce
 * na wydruku. Kopiujemy fizycznie, bo assety sa wlasnoscia szablonu i razem
 * z nim znikaja.
 */
export async function copyBlockAssets(
  id: string,
  templateId: string
): Promise<{ assets: CopiedAsset[]; missing: string[] }> {
  const tenantId = requireTenantId();

  const block = await prisma.templateBlock.findFirst({ where: { id, tenantId } });
  if (!block) throw new Error('Nie znaleziono bloku');

  const template = await prisma.personalizationTemplate.findFirst({
    where: { id: templateId, tenantId },
    select: { id: true },
  });
  if (!template) throw new Error('Nie znaleziono szablonu docelowego');

  const payload = block.payload as TemplateBlockPayload;
  const sources = [...new Set((payload.assets ?? []).filter(Boolean))];

  const assets: CopiedAsset[] = [];
  const missing: string[] = [];

  for (const source of sources) {
    // Sciezka z payloadu jest relatywna do storage - `path.resolve` z kontrola
    // prefiksu odcina proby wyjscia poza katalog (`../../etc/passwd`).
    const absolute = path.resolve(config.storage.path, source);
    if (!absolute.startsWith(path.resolve(config.storage.path))) {
      missing.push(source);
      continue;
    }

    try {
      const buffer = await fs.readFile(absolute);
      const fileName = path.basename(source);
      const uploaded = await uploadTemplateAsset(
        templateId,
        buffer,
        fileName,
        mimeTypeForFile(fileName),
        'image',
        { originalName: fileName }
      );
      assets.push({ from: source, to: uploaded.filePath });
    } catch {
      // Plik mogl zostac skasowany razem z szablonem zrodlowym - panel
      // powie o tym wprost, zamiast wstawiac warstwe z martwym odwolaniem.
      missing.push(source);
    }
  }

  return { assets, missing };
}

function mimeTypeForFile(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}
