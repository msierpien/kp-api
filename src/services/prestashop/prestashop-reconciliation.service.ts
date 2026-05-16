import type { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { createShopStockClient } from '../shops/shop-client.factory';

export interface PrestaShopReconciliationQuery {
  shopId?: string;
  warehouseProductId?: string;
  limit?: number;
  includeInSync?: boolean;
  priceTolerance?: number;
}

export type PrestaShopReconciliationStatus = 'IN_SYNC' | 'MISMATCH' | 'ERROR' | 'UNSUPPORTED';

export interface PrestaShopReconciliationEntry {
  status: PrestaShopReconciliationStatus;
  differences: Array<'PRICE' | 'STOCK'>;
  action: 'NONE' | 'REMOTE_SHOULD_BE_UPDATED' | 'CHECK_MAPPING_OR_ACCESS';
  errorMessage?: string;
  shop: {
    id: string;
    name: string;
    platform: string;
  };
  mapping: {
    id: string;
    externalProductId: string;
    externalSku: string;
    externalName: string | null;
  };
  warehouseProduct: {
    id: string;
    sku: string;
    name: string;
    retailPrice: number | null;
    currentStock: number;
  };
  remote: {
    price?: number;
    stock?: number;
    stockAvailableId?: string;
  };
  comparison: {
    priceDifference: number | null;
    stockDifference: number | null;
  };
}

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

export async function getPrestaShopReconciliation(query: PrestaShopReconciliationQuery = {}) {
  const tenantId = requireTenantId();
  return reconcilePrestaShopForTenant(tenantId, query);
}

export async function reconcilePrestaShopForTenant(
  tenantId: string,
  query: PrestaShopReconciliationQuery = {},
) {
  const limit = normalizeLimit(query.limit);
  const priceTolerance = normalizePriceTolerance(query.priceTolerance);

  const where: Prisma.ShopProductMappingWhereInput = {
    tenantId,
    isActive: true,
    warehouseProductId: { not: null },
    shop: {
      status: 'ACTIVE',
      platform: 'PRESTASHOP',
    },
  };

  if (query.shopId) where.shopId = query.shopId;
  if (query.warehouseProductId) where.warehouseProductId = query.warehouseProductId;

  const mappings = await prisma.shopProductMapping.findMany({
    where,
    take: limit,
    orderBy: [{ shopId: 'asc' }, { externalSku: 'asc' }],
    include: {
      shop: true,
      warehouseProduct: true,
    },
  });

  const clientByShop = new Map<string, ReturnType<typeof createShopStockClient>>();
  const entries: PrestaShopReconciliationEntry[] = [];

  for (const mapping of mappings) {
    if (!mapping.warehouseProduct) continue;

    const baseEntry = {
      shop: {
        id: mapping.shop.id,
        name: mapping.shop.name,
        platform: mapping.shop.platform,
      },
      mapping: {
        id: mapping.id,
        externalProductId: mapping.externalProductId,
        externalSku: mapping.externalSku,
        externalName: mapping.externalName,
      },
      warehouseProduct: {
        id: mapping.warehouseProduct.id,
        sku: mapping.warehouseProduct.sku,
        name: mapping.warehouseProduct.name,
        retailPrice: mapping.warehouseProduct.retailPrice === null ? null : Number(mapping.warehouseProduct.retailPrice),
        currentStock: Number(mapping.warehouseProduct.currentStock),
      },
    };

    try {
      let client = clientByShop.get(mapping.shopId);
      if (!client) {
        client = createShopStockClient(mapping.shop);
        clientByShop.set(mapping.shopId, client);
      }

      if (!client.getProductInventorySnapshot) {
        entries.push({
          ...baseEntry,
          status: 'UNSUPPORTED',
          differences: [],
          action: 'CHECK_MAPPING_OR_ACCESS',
          errorMessage: `Reconciliation is not implemented for platform ${mapping.shop.platform}`,
          remote: {},
          comparison: { priceDifference: null, stockDifference: null },
        });
        continue;
      }

      const remote = await client.getProductInventorySnapshot(mapping.externalProductId);
      const priceDifference = comparePrice(baseEntry.warehouseProduct.retailPrice, remote.price);
      const stockDifference = remote.stock === undefined
        ? null
        : baseEntry.warehouseProduct.currentStock - remote.stock;
      const differences: Array<'PRICE' | 'STOCK'> = [];

      if (priceDifference !== null && Math.abs(priceDifference) > priceTolerance) differences.push('PRICE');
      if (stockDifference !== null && stockDifference !== 0) differences.push('STOCK');

      entries.push({
        ...baseEntry,
        status: differences.length > 0 ? 'MISMATCH' : 'IN_SYNC',
        differences,
        action: differences.length > 0 ? 'REMOTE_SHOULD_BE_UPDATED' : 'NONE',
        remote: {
          price: remote.price,
          stock: remote.stock,
          stockAvailableId: remote.stockAvailableId,
        },
        comparison: {
          priceDifference,
          stockDifference,
        },
      });
    } catch (error) {
      entries.push({
        ...baseEntry,
        status: 'ERROR',
        differences: [],
        action: 'CHECK_MAPPING_OR_ACCESS',
        errorMessage: error instanceof Error ? error.message : 'Nieznany błąd reconciliation',
        remote: {},
        comparison: { priceDifference: null, stockDifference: null },
      });
    }
  }

  const data = query.includeInSync === true
    ? entries
    : entries.filter((entry) => entry.status !== 'IN_SYNC');

  return {
    summary: {
      scanned: entries.length,
      returned: data.length,
      inSync: entries.filter((entry) => entry.status === 'IN_SYNC').length,
      mismatches: entries.filter((entry) => entry.status === 'MISMATCH').length,
      errors: entries.filter((entry) => entry.status === 'ERROR').length,
      unsupported: entries.filter((entry) => entry.status === 'UNSUPPORTED').length,
    },
    sourceOfTruth: 'WAREHOUSE',
    priceTolerance,
    data,
  };
}

function comparePrice(localPrice: number | null, remotePrice?: number) {
  if (localPrice === null || remotePrice === undefined) return null;
  return Number((localPrice - remotePrice).toFixed(2));
}

function normalizeLimit(value?: number) {
  if (value === undefined) return 200;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new Error('limit reconciliation musi być liczbą całkowitą od 1 do 1000');
  }
  return parsed;
}

function normalizePriceTolerance(value?: number) {
  if (value === undefined) return 0.01;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('priceTolerance musi być nieujemną liczbą');
  }
  return parsed;
}
