import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import type { TemplateLayoutInput } from '../../schemas/admin.schema';
import type { TemplateLayoutJson, TemplateAssetItem } from '../../types/template-layout';
import { normalizeCanvasConfig } from '../../types/template-layout';
import { validateTemplateLayout, type TemplateLayoutWarning } from './template-layout-validation';
import fs from 'fs/promises';
import path from 'path';
import { imageExtensionForMimeType } from '../../lib/upload-validation';

const STORAGE_DIR = path.join(process.cwd(), 'storage', 'templates');
const MAX_ASSETS_PER_TEMPLATE = 50;
const ALLOWED_TEMPLATE_ASSET_TYPES = new Set(['BACKGROUND', 'DECORATION', 'LOGO', 'CUT_LINE_SVG']);

// ============================================
// Layout CRUD
// ============================================

export async function getTemplateLayout(templateId: string): Promise<TemplateLayoutJson | null> {
  const template = await prisma.personalizationTemplate.findUnique({
    where: { id: templateId },
    select: { layoutJson: true },
  });

  if (!template) {
    throw new Error('Szablon nie znaleziony');
  }

  return (template.layoutJson as unknown as TemplateLayoutJson) ?? null;
}

export async function updateTemplateLayout(
  templateId: string,
  layoutJson: TemplateLayoutInput
): Promise<{ layout: TemplateLayoutJson; warnings: TemplateLayoutWarning[] }> {
  const template = await prisma.personalizationTemplate.findUnique({
    where: { id: templateId },
    select: {
      id: true,
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

  const normalizedLayout = {
    ...layoutJson,
    canvas: normalizeCanvasConfig(layoutJson.canvas as any),
  } as TemplateLayoutInput;

  const warnings = validateTemplateLayout(normalizedLayout, template.forms);

  const updated = await prisma.personalizationTemplate.update({
    where: { id: templateId },
    data: {
      layoutJson: normalizedLayout as any,
    },
    select: { layoutJson: true },
  });

  return {
    layout: updated.layoutJson as unknown as TemplateLayoutJson,
    warnings,
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
