import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import type { TemplateLayoutInput } from '../../schemas/admin.schema';
import type { TemplateLayoutJson, TemplateAssetItem } from '../../types/template-layout';
import { getTemplatePages, normalizeCanvasConfig } from '../../types/template-layout';
import { validateTemplateLayout, type TemplateLayoutWarning } from './template-layout-validation';
import { assertTemplateVersion, templateVersionToken } from './template-version';
import fs from 'fs/promises';
import path from 'path';
import { imageExtensionForMimeType } from '../../lib/upload-validation';
import { scheduleTemplateThumbnail } from './template-thumbnail.service';

const STORAGE_DIR = path.join(process.cwd(), 'storage', 'templates');
const MAX_ASSETS_PER_TEMPLATE = 50;
// SHEET_BACKGROUND - podklad calego arkusza do druku (ozdobna ramka pod
// uzytkami), inny niz BACKGROUND, ktory jest tlem pojedynczej kartki.
const ALLOWED_TEMPLATE_ASSET_TYPES = new Set([
  'BACKGROUND',
  'DECORATION',
  'LOGO',
  'CUT_LINE_SVG',
  'SHEET_BACKGROUND',
]);

// ============================================
// Layout CRUD
// ============================================

export async function getTemplateLayout(
  templateId: string
): Promise<{ layout: TemplateLayoutJson | null; version: string }> {
  const template = await prisma.personalizationTemplate.findUnique({
    where: { id: templateId },
    select: { layoutJson: true, updatedAt: true },
  });

  if (!template) {
    throw new Error('Szablon nie znaleziony');
  }

  return {
    layout: (template.layoutJson as unknown as TemplateLayoutJson) ?? null,
    version: templateVersionToken(template.updatedAt),
  };
}

/** Ile wersji trzymamy - starsze i tak nikt nie przywraca, a JSON waży. */
const LAYOUT_HISTORY_LIMIT = 20;

/** Krotki opis wersji na liste: liczba stron i wariantow. */
function describeLayout(layout: unknown): string {
  const parsed = layout as TemplateLayoutJson | null;
  if (!parsed) return 'pusty layout';

  const pages = getTemplatePages(parsed).length;
  const variants = Array.isArray(parsed.variants) ? parsed.variants.length : 1;
  const pageLabel = pages === 1 ? '1 strona' : `${pages} stron`;
  return variants > 1 ? `${pageLabel}, ${variants} warianty` : pageLabel;
}

/**
 * Odklada stan SPRZED nadpisania.
 *
 * Zapisujemy poprzednia wersje, nie nowa - dzieki temu najswiezszy wpis
 * historii to zawsze "to, co bylo przed ostatnim zapisem", czyli dokladnie
 * to, do czego projektant chce wrocic.
 */
async function snapshotLayout(templateId: string, layout: unknown): Promise<void> {
  if (!layout) return;

  await prisma.templateLayoutVersion.create({
    data: {
      templateId,
      layoutJson: layout as any,
      summary: describeLayout(layout),
    },
  });

  const stale = await prisma.templateLayoutVersion.findMany({
    where: { templateId },
    orderBy: { createdAt: 'desc' },
    skip: LAYOUT_HISTORY_LIMIT,
    select: { id: true },
  });

  if (stale.length > 0) {
    await prisma.templateLayoutVersion.deleteMany({
      where: { id: { in: stale.map((item) => item.id) } },
    });
  }
}

export async function listTemplateLayoutVersions(templateId: string) {
  const versions = await prisma.templateLayoutVersion.findMany({
    where: { templateId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, summary: true, createdAt: true },
  });

  return { versions };
}

/**
 * Przywraca layout z historii.
 *
 * Biezacy stan trafia najpierw do historii, wiec przywrocenie samo daje sie
 * cofnac - bez tego jedno klikniecie kasowaloby dzien pracy.
 */
export async function restoreTemplateLayoutVersion(templateId: string, versionId: string) {
  const [template, version] = await Promise.all([
    prisma.personalizationTemplate.findUnique({
      where: { id: templateId },
      select: { layoutJson: true },
    }),
    prisma.templateLayoutVersion.findFirst({
      where: { id: versionId, templateId },
      select: { layoutJson: true },
    }),
  ]);

  if (!template) throw new Error('Szablon nie znaleziony');
  if (!version) throw new Error('Wersja layoutu nie znaleziona');

  await snapshotLayout(templateId, template.layoutJson);

  const updated = await prisma.personalizationTemplate.update({
    where: { id: templateId },
    data: { layoutJson: version.layoutJson as any },
    select: { layoutJson: true, updatedAt: true },
  });

  // Przywrocony projekt to inny obrazek - miniatura musi za nim pojsc.
  scheduleTemplateThumbnail(templateId);

  return {
    layout: updated.layoutJson as unknown as TemplateLayoutJson,
    version: templateVersionToken(updated.updatedAt),
  };
}

export async function updateTemplateLayout(
  templateId: string,
  layoutJson: TemplateLayoutInput,
  expectedVersion?: string
): Promise<{ layout: TemplateLayoutJson; warnings: TemplateLayoutWarning[]; version: string }> {
  const template = await prisma.personalizationTemplate.findUnique({
    where: { id: templateId },
    select: {
      id: true,
      updatedAt: true,
      layoutJson: true,
      forms: {
        select: {
          fields: {
            select: { key: true },
          },
        },
      },
    },
  });

  if (!template) {
    throw new Error('Szablon nie znaleziony');
  }

  assertTemplateVersion(template.updatedAt, expectedVersion);
  const previousLayout = template.layoutJson;

  const normalizedLayout = {
    ...layoutJson,
    canvas: normalizeCanvasConfig(layoutJson.canvas as any),
  } as TemplateLayoutInput;

  const warnings = validateTemplateLayout(normalizedLayout, template.forms);

  await snapshotLayout(templateId, previousLayout);

  const updated = await prisma.personalizationTemplate.update({
    where: { id: templateId },
    data: {
      layoutJson: normalizedLayout as any,
    },
    select: { layoutJson: true, updatedAt: true },
  });

  // Miniatura do biblioteki - w tle, zeby zapis projektu nie czekal na render.
  scheduleTemplateThumbnail(templateId);

  return {
    layout: updated.layoutJson as unknown as TemplateLayoutJson,
    warnings,
    version: templateVersionToken(updated.updatedAt),
  };
}

// ============================================
// Template Assets (pliki graficzne)
// ============================================

export async function listTemplateAssets(templateId: string): Promise<TemplateAssetItem[]> {
  const assets = await prisma.templateAsset.findMany({
    where: { templateId },
    orderBy: { sortOrder: 'asc' },
  });

  return assets.map(mapAssetToItem);
}

export async function uploadTemplateAsset(
  templateId: string,
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  assetType: string,
  metadata?: { width?: number; height?: number; originalName?: string }
): Promise<TemplateAssetItem> {
  if (!ALLOWED_TEMPLATE_ASSET_TYPES.has(assetType)) {
    throw new Error('Niedozwolony typ assetu');
  }

  const currentCount = await prisma.templateAsset.count({ where: { templateId } });
  if (currentCount >= MAX_ASSETS_PER_TEMPLATE) {
    throw new Error(`Osiagnieto limit ${MAX_ASSETS_PER_TEMPLATE} plików dla tego szablonu`);
  }

  // Pobierz kod szablonu dla ścieżki
  const template = await prisma.personalizationTemplate.findUnique({
    where: { id: templateId },
    select: { code: true },
  });

  if (!template) {
    throw new Error('Szablon nie znaleziony');
  }

  const safeTemplateCode = sanitizePathPart(template.code) || templateId;
  const safeAssetType = assetType.toLowerCase();

  // Utwórz katalog jeśli nie istnieje
  const assetDir = path.join(STORAGE_DIR, safeTemplateCode, safeAssetType);
  await fs.mkdir(assetDir, { recursive: true });

  // Generuj unikatową nazwę pliku
  const timestamp = Date.now();
  const ext = `.${imageExtensionForMimeType(mimeType)}`;
  const baseName = path.basename(fileName, path.extname(fileName));
  const safeBaseName = sanitizePathPart(baseName) || 'asset';
  const safeFileName = `${safeBaseName}_${timestamp}${ext}`;
  const filePath = path.join(assetDir, safeFileName);

  // Zapisz plik
  await fs.writeFile(filePath, fileBuffer);

  // Ścieżka relatywna dla bazy (od storage/)
  const relativePath = path.join('templates', safeTemplateCode, safeAssetType, safeFileName);

  // Zapisz do bazy
  const asset = await prisma.templateAsset.create({
    data: {
      templateId,
      assetType,
      fileName: safeFileName,
      filePath: relativePath,
      fileSize: fileBuffer.length,
      mimeType,
      metadata: metadata ?? Prisma.JsonNull,
    },
  });

  return mapAssetToItem(asset);
}

function sanitizePathPart(value: string) {
  return path
    .basename(value)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

export async function deleteTemplateAsset(assetId: string): Promise<void> {
  const asset = await prisma.templateAsset.findUnique({
    where: { id: assetId },
  });

  if (!asset) {
    throw new Error('Zasób nie znaleziony');
  }

  // Usuń plik z dysku
  const fullPath = path.join(process.cwd(), 'storage', asset.filePath);
  try {
    await fs.unlink(fullPath);
  } catch {
    // Plik może nie istnieć - kontynuuj
  }

  // Usuń z bazy
  await prisma.templateAsset.delete({
    where: { id: assetId },
  });
}

// ============================================
// Helpers
// ============================================

function mapAssetToItem(asset: any): TemplateAssetItem {
  return {
    id: asset.id,
    templateId: asset.templateId,
    assetType: asset.assetType,
    fileName: asset.fileName,
    filePath: asset.filePath,
    fileSize: asset.fileSize,
    mimeType: asset.mimeType,
    metadata: asset.metadata,
    sortOrder: asset.sortOrder,
    createdAt: asset.createdAt,
  };
}
