import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import type { TemplateLayoutInput } from '../../schemas/admin.schema';
import type { TemplateLayoutJson, TemplateAssetItem } from '../../types/template-layout';
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
): Promise<TemplateLayoutJson> {
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

  validateLayout(layoutJson, template.forms);

  const updated = await prisma.personalizationTemplate.update({
    where: { id: templateId },
    data: {
      layoutJson: layoutJson as any,
    },
    select: { layoutJson: true },
  });

  return updated.layoutJson as unknown as TemplateLayoutJson;
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

function validateLayout(layout: TemplateLayoutInput, forms: Array<{ fields: Array<{ key: string }> }> | null) {
  // unikalne id
  const ids = new Set<string>();
  for (const layer of layout.layers) {
    if (ids.has(layer.id)) {
      throw new Error(`Duplikat id warstwy: ${layer.id}`);
    }
    ids.add(layer.id);
    if (layer.width <= 0 || layer.height <= 0) {
      throw new Error(`Warstwa ${layer.name} ma nieprawidłowe wymiary`);
    }
  }

  // mapowanie pól tekstowych do istniejących fieldKey
  const formKeys = new Set(forms?.flatMap(f => f.fields.map(fl => fl.key)) || []);
  const seenKeys = new Set<string>();
  for (const layer of layout.layers) {
    if (layer.type === 'text') {
      const fk = (layer.properties as any).fieldKey;
      if (!fk) {
        throw new Error(`Warstwa tekstowa ${layer.name} nie ma fieldKey`);
      }
      if (!formKeys.has(fk)) {
        throw new Error(`fieldKey ${fk} nie istnieje w formularzu`);
      }
      if (seenKeys.has(fk)) {
        // nie blokujemy, ale ostrzegamy
        console.warn(`[layout] Powielony fieldKey ${fk} w warstwach (dopuszczalne, ale sprawdź)`);
      } else {
        seenKeys.add(fk);
      }
    }
  }

  // ostrzeżenie o braku tła
  const hasBackground = layout.layers.some(l => l.type === 'background');
  if (!hasBackground) {
    console.warn('[layout] Brak warstwy background');
  }
}
