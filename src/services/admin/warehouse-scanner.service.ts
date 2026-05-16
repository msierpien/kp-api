import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { resolveCatalogForProduct } from './warehouse-catalogs.service';

export interface ResolveWarehouseScanInput {
  ean: string;
  providerIds?: string[];
  includeWholesalePrice?: boolean;
}

export interface AcceptWholesaleScanInput {
  catalogId?: string | null;
}

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

function normalizeEan(ean: string) {
  return ean.trim();
}

function barcodePayload(barcode: {
  id: string;
  ean: string;
  label: string | null;
  quantityMultiplier: Prisma.Decimal | number | string;
  isPrimary: boolean;
  isActive: boolean;
}) {
  return {
    id: barcode.id,
    ean: barcode.ean,
    label: barcode.label,
    quantityMultiplier: barcode.quantityMultiplier,
    isPrimary: barcode.isPrimary,
    isActive: barcode.isActive,
  };
}

function warehouseMatchPayload(
  ean: string,
  barcode: Parameters<typeof barcodePayload>[0],
  product: unknown,
  source?: unknown,
) {
  return {
    status: 'WAREHOUSE_MATCH' as const,
    ean,
    barcode: barcodePayload(barcode),
    product,
    source,
  };
}

function wholesaleSource(mapping: {
  id: string;
  providerId: string;
  externalSku: string;
  externalEan: string | null;
  externalName: string | null;
  lastKnownStock: Prisma.Decimal | null;
  lastKnownPrice: Prisma.Decimal | null;
  provider: { id: string; name: string };
}) {
  return {
    type: 'WHOLESALE' as const,
    mappingId: mapping.id,
    providerId: mapping.providerId,
    providerName: mapping.provider.name,
    externalSku: mapping.externalSku,
    externalEan: mapping.externalEan,
    externalName: mapping.externalName,
    lastKnownStock: mapping.lastKnownStock,
    lastKnownPrice: mapping.lastKnownPrice,
  };
}

async function findWholesaleSourceForWarehouseMatch(input: {
  tenantId: string;
  ean: string;
  warehouseProductId: string;
  providerIds?: string[];
}) {
  if (input.providerIds?.length === 0) return undefined;

  const mapping = await prisma.wholesaleProductMapping.findFirst({
    where: {
      tenantId: input.tenantId,
      isActive: true,
      lastKnownPrice: { not: null },
      ...(input.providerIds ? { providerId: { in: input.providerIds } } : {}),
      provider: { isActive: true },
      OR: [
        { warehouseProductId: input.warehouseProductId },
        { externalEan: input.ean, warehouseProductId: null },
      ],
    },
    orderBy: [
      { lastKnownPrice: 'asc' },
      { lastSyncAt: 'desc' },
      { updatedAt: 'desc' },
      { externalName: 'asc' },
      { externalSku: 'asc' },
    ],
    include: { provider: true },
  });

  return mapping ? wholesaleSource(mapping) : undefined;
}

export async function resolveWarehouseScan(input: ResolveWarehouseScanInput) {
  const tenantId = requireTenantId();
  const ean = normalizeEan(input.ean);
  if (!ean) throw new Error('EAN jest wymagany');
  const providerIds = input.providerIds?.map((id) => id.trim()).filter(Boolean);

  const existingBarcode = await prisma.warehouseProductBarcode.findFirst({
    where: { tenantId, ean },
    include: { warehouseProduct: { include: { catalog: true } } },
  });

  if (existingBarcode) {
    if (!existingBarcode.isActive) {
      return {
        status: 'BLOCKED' as const,
        ean,
        reason: 'Kod EAN istnieje w magazynie, ale jest nieaktywny',
        barcode: barcodePayload(existingBarcode),
        product: existingBarcode.warehouseProduct,
      };
    }

    if (!existingBarcode.warehouseProduct.isActive) {
      return {
        status: 'BLOCKED' as const,
        ean,
        reason: 'Produkt przypisany do tego EAN jest nieaktywny',
        barcode: barcodePayload(existingBarcode),
        product: existingBarcode.warehouseProduct,
      };
    }

    const source = input.includeWholesalePrice
      ? await findWholesaleSourceForWarehouseMatch({
        tenantId,
        ean,
        warehouseProductId: existingBarcode.warehouseProductId,
        providerIds,
      })
      : undefined;

    return warehouseMatchPayload(ean, existingBarcode, existingBarcode.warehouseProduct, source);
  }

  const candidates = providerIds?.length === 0 ? [] : await prisma.wholesaleProductMapping.findMany({
    where: {
      tenantId,
      externalEan: ean,
      isActive: true,
      ...(providerIds ? { providerId: { in: providerIds } } : {}),
      provider: { isActive: true },
    },
    take: 20,
    orderBy: [{ lastKnownPrice: 'asc' }, { externalName: 'asc' }, { externalSku: 'asc' }],
    include: {
      provider: true,
      warehouseProduct: { include: { catalog: true } },
    },
  });

  if (candidates.length > 0) {
    return {
      status: 'WHOLESALE_CANDIDATES' as const,
      ean,
      candidates,
    };
  }

  return {
    status: 'NOT_FOUND' as const,
    ean,
    message: 'Nie znaleziono EAN w magazynie ani aktywnych hurtowniach',
  };
}

export async function acceptWholesaleScanMapping(mappingId: string, input: AcceptWholesaleScanInput = {}) {
  const tenantId = requireTenantId();

  return prisma.$transaction(async (tx) => {
    const mapping = await tx.wholesaleProductMapping.findFirst({
      where: { id: mappingId, tenantId },
      include: {
        provider: true,
        warehouseProduct: { include: { catalog: true } },
      },
    });

    if (!mapping) throw new Error('Oferta hurtowni nie znaleziona');
    if (!mapping.isActive) throw new Error('Oferta hurtowni jest nieaktywna');
    if (!mapping.provider.isActive) throw new Error('Hurtownia jest nieaktywna');
    if (!mapping.externalEan) throw new Error('Oferta hurtowni nie ma EAN');
    if (!mapping.externalSku.trim()) throw new Error('Oferta hurtowni nie ma SKU');

    const existingBarcode = await tx.warehouseProductBarcode.findFirst({
      where: { tenantId, ean: mapping.externalEan },
      include: { warehouseProduct: { include: { catalog: true } } },
    });

    if (existingBarcode) {
      if (!existingBarcode.isActive || !existingBarcode.warehouseProduct.isActive) {
        throw new Error('Ten EAN istnieje w magazynie, ale jest nieaktywny. Aktywuj go ręcznie zamiast tworzyć duplikat.');
      }

      if (mapping.warehouseProductId && mapping.warehouseProductId !== existingBarcode.warehouseProductId) {
        throw new Error('Ten EAN jest już przypisany do innego produktu magazynowego');
      }

      if (!mapping.warehouseProductId) {
        await tx.wholesaleProductMapping.update({
          where: { id: mapping.id },
          data: { warehouseProductId: existingBarcode.warehouseProductId },
        });
      }

      return warehouseMatchPayload(
        mapping.externalEan,
        existingBarcode,
        existingBarcode.warehouseProduct,
        wholesaleSource(mapping),
      );
    }

    let product = mapping.warehouseProduct;

    if (!product) {
      const existingProduct = await tx.warehouseProduct.findUnique({
        where: { tenantId_sku: { tenantId, sku: mapping.externalSku } },
        include: { catalog: true },
      });

      if (existingProduct) {
        product = existingProduct;
        await tx.wholesaleProductMapping.update({
          where: { id: mapping.id },
          data: { warehouseProductId: existingProduct.id },
        });
      }
    }

    if (!product) {
      const catalog = await resolveCatalogForProduct(tenantId, input.catalogId, tx);

      product = await tx.warehouseProduct.create({
        data: {
          tenantId,
          catalogId: catalog.id,
          sku: mapping.externalSku,
          name: mapping.externalName || mapping.externalSku,
          unit: 'szt',
          purchasePrice: mapping.lastKnownPrice,
          isActive: true,
        },
        include: { catalog: true },
      });

      await tx.wholesaleProductMapping.update({
        where: { id: mapping.id },
        data: { warehouseProductId: product.id },
      });
    }

    if (!product.isActive) throw new Error('Produkt magazynowy powiązany z ofertą jest nieaktywny');

    const activeBarcodeCount = await tx.warehouseProductBarcode.count({
      where: { tenantId, warehouseProductId: product.id, isActive: true },
    });

    const barcode = await tx.warehouseProductBarcode.create({
      data: {
        tenantId,
        warehouseProductId: product.id,
        ean: mapping.externalEan,
        label: mapping.provider.name,
        quantityMultiplier: new Prisma.Decimal(1),
        isPrimary: activeBarcodeCount === 0,
        isActive: true,
      },
    });

    return warehouseMatchPayload(mapping.externalEan, barcode, product, wholesaleSource(mapping));
  });
}
