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
