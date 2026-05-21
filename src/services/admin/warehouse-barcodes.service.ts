import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';

export interface CreateBarcodeInput {
  ean: string;
  label?: string;
  quantityMultiplier?: number;
  isPrimary?: boolean;
  isActive?: boolean;
}

export interface UpdateBarcodeInput {
  ean?: string;
  label?: string | null;
  quantityMultiplier?: number;
  isPrimary?: boolean;
  isActive?: boolean;
}

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

function normalizeEan(ean: string) {
  return ean.trim();
}

function validateBarcodeInput(input: { ean?: string; quantityMultiplier?: number }) {
  if (input.ean !== undefined && normalizeEan(input.ean).length === 0) {
    throw new Error('EAN nie może być pusty');
  }

  if (input.quantityMultiplier !== undefined && input.quantityMultiplier <= 0) {
    throw new Error('Przelicznik EAN musi być większy od 0');
  }
}

async function unsetPrimaryBarcodes(tenantId: string, warehouseProductId: string, exceptId?: string) {
  await prisma.warehouseProductBarcode.updateMany({
    where: {
      tenantId,
      warehouseProductId,
      isPrimary: true,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { isPrimary: false },
  });
}

export async function lookupBarcode(ean: string) {
  const tenantId = requireTenantId();
  const normalizedEan = normalizeEan(ean);
  if (!normalizedEan) throw new Error('EAN nie może być pusty');

  return prisma.warehouseProductBarcode.findFirst({
    where: {
      tenantId,
      ean: normalizedEan,
      isActive: true,
      warehouseProduct: { isActive: true },
    },
    include: { warehouseProduct: true },
  });
}

export async function getProductBarcodes(warehouseProductId: string) {
  const tenantId = requireTenantId();

  return prisma.warehouseProductBarcode.findMany({
    where: { tenantId, warehouseProductId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
}

export async function createBarcode(warehouseProductId: string, input: CreateBarcodeInput) {
  const tenantId = requireTenantId();
  validateBarcodeInput(input);

  const product = await prisma.warehouseProduct.findFirst({
    where: { id: warehouseProductId, tenantId },
  });
  if (!product) throw new Error('Produkt nie znaleziony');

  const ean = normalizeEan(input.ean);
  const isPrimary = input.isPrimary ?? false;

  const existing = await prisma.warehouseProductBarcode.findUnique({
    where: { tenantId_ean: { tenantId, ean } },
  });
  if (existing) throw new Error(`Kod EAN "${ean}" już istnieje`);

  if (isPrimary) {
    await unsetPrimaryBarcodes(tenantId, warehouseProductId);
  }

  return prisma.warehouseProductBarcode.create({
    data: {
      tenantId,
      warehouseProductId,
      ean,
      label: input.label,
      quantityMultiplier: input.quantityMultiplier ?? 1,
      isPrimary,
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateBarcode(id: string, input: UpdateBarcodeInput) {
  const tenantId = requireTenantId();
  validateBarcodeInput(input);

  const barcode = await prisma.warehouseProductBarcode.findFirst({
    where: { id, tenantId },
  });
  if (!barcode) throw new Error('Kod EAN nie znaleziony');

  if (input.ean !== undefined) {
    const ean = normalizeEan(input.ean);
    const existing = await prisma.warehouseProductBarcode.findUnique({
      where: { tenantId_ean: { tenantId, ean } },
    });
    if (existing && existing.id !== id) throw new Error(`Kod EAN "${ean}" już istnieje`);
  }

  if (input.isPrimary === true) {
    await unsetPrimaryBarcodes(tenantId, barcode.warehouseProductId, id);
  }

  return prisma.warehouseProductBarcode.update({
    where: { id },
    data: {
      ...(input.ean !== undefined ? { ean: normalizeEan(input.ean) } : {}),
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.quantityMultiplier !== undefined ? { quantityMultiplier: input.quantityMultiplier } : {}),
      ...(input.isPrimary !== undefined ? { isPrimary: input.isPrimary } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
}

export interface BulkFillEanFromMappingsResult {
  scanned: number;
  filled: number;
  skippedNoEanInMapping: number;
  skippedAlreadyHasEan: number;
  skippedEanTaken: number;
  errors: Array<{ productId: string; message: string }>;
}

/**
 * Dla listy produktów magazynowych: szuka ich mapowań sklepowych z externalEan
 * i jeśli produkt nie ma jeszcze żadnego EAN — dodaje go automatycznie.
 */
export async function bulkFillEanFromShopMappings(
  productIds: string[],
  shopId?: string,
): Promise<BulkFillEanFromMappingsResult> {
  const tenantId = requireTenantId();
  const result: BulkFillEanFromMappingsResult = {
    scanned: productIds.length,
    filled: 0,
    skippedNoEanInMapping: 0,
    skippedAlreadyHasEan: 0,
    skippedEanTaken: 0,
    errors: [],
  };

  for (const productId of productIds) {
    try {
      const product = await prisma.warehouseProduct.findFirst({
        where: { id: productId, tenantId },
        select: { id: true },
      });

      if (!product) { result.errors.push({ productId, message: 'Produkt nie znaleziony' }); continue; }

      const existingBarcode = await prisma.warehouseProductBarcode.findFirst({
        where: { tenantId, warehouseProductId: productId, isActive: true },
        select: { id: true },
      });
      if (existingBarcode) { result.skippedAlreadyHasEan++; continue; }

      const mapping = await prisma.shopProductMapping.findFirst({
        where: {
          tenantId,
          warehouseProductId: productId,
          isActive: true,
          externalEan: { not: null },
          ...(shopId ? { shopId } : {}),
        },
        select: { externalEan: true },
        orderBy: { lastSyncAt: 'desc' },
      });

      const ean = mapping?.externalEan?.trim();
      if (!ean) { result.skippedNoEanInMapping++; continue; }

      const taken = await prisma.warehouseProductBarcode.findFirst({
        where: { tenantId, ean },
        select: { id: true },
      });
      if (taken) { result.skippedEanTaken++; continue; }

      await prisma.warehouseProductBarcode.create({
        data: {
          tenantId,
          warehouseProductId: productId,
          ean,
          isPrimary: true,
          isActive: true,
        },
      });

      result.filled++;
    } catch (error) {
      result.errors.push({ productId, message: error instanceof Error ? error.message : 'Błąd' });
    }
  }

  return result;
}

export async function deleteBarcode(id: string) {
  const tenantId = requireTenantId();

  const barcode = await prisma.warehouseProductBarcode.findFirst({
    where: { id, tenantId },
  });
  if (!barcode) throw new Error('Kod EAN nie znaleziony');

  const itemCount = await prisma.warehouseDocumentItem.count({ where: { barcodeId: id } });
  if (itemCount > 0) {
    const barcode = await prisma.warehouseProductBarcode.update({
      where: { id },
      data: { isActive: false, isPrimary: false },
    });
    return { action: 'deactivated' as const, barcode };
  }

  await prisma.warehouseProductBarcode.delete({ where: { id } });
  return { action: 'deleted' as const };
}
