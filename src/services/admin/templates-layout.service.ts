import prisma from '../../lib/prisma';
import type { TemplateLayoutInput } from '../../schemas/admin.schema';
import type { TemplateLayoutJson, TemplateAssetItem } from '../../types/template-layout';
import fs from 'fs/promises';
import path from 'path';

const STORAGE_DIR = path.join(process.cwd(), 'storage', 'templates');

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

  return (template.layoutJson as TemplateLayoutJson) ?? null;
}

export async function updateTemplateLayout(
  templateId: string,
  layoutJson: TemplateLayoutInput
): Promise<TemplateLayoutJson> {
  const template = await prisma.personalizationTemplate.findUnique({
    where: { id: templateId },
    select: { id: true },
  });

  if (!template) {
    throw new Error('Szablon nie znaleziony');
  }

  const updated = await prisma.personalizationTemplate.update({
    where: { id: templateId },
    data: {
      layoutJson: layoutJson as any,
    },
    select: { layoutJson: true },
  });

  return updated.layoutJson as TemplateLayoutJson;
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
  // Pobierz kod szablonu dla ścieżki
  const template = await prisma.personalizationTemplate.findUnique({
    where: { id: templateId },
    select: { code: true },
  });

  if (!template) {
    throw new Error('Szablon nie znaleziony');
  }

  // Utwórz katalog jeśli nie istnieje
  const assetDir = path.join(STORAGE_DIR, template.code, assetType.toLowerCase());
  await fs.mkdir(assetDir, { recursive: true });

  // Generuj unikatową nazwę pliku
  const timestamp = Date.now();
  const ext = path.extname(fileName);
  const baseName = path.basename(fileName, ext);
  const safeFileName = `${baseName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${timestamp}${ext}`;
  const filePath = path.join(assetDir, safeFileName);

  // Zapisz plik
  await fs.writeFile(filePath, fileBuffer);

  // Ścieżka relatywna dla bazy (od storage/)
  const relativePath = path.join('templates', template.code, assetType.toLowerCase(), safeFileName);

  // Zapisz do bazy
  const asset = await prisma.templateAsset.create({
    data: {
      templateId,
      assetType,
      fileName: safeFileName,
      filePath: relativePath,
      fileSize: fileBuffer.length,
      mimeType,
      metadata: metadata ?? null,
    },
  });

  return mapAssetToItem(asset);
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
