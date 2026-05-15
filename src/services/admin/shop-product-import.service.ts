import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { getTenantId } from '../../lib/tenant-context';
import type { Shop } from '@prisma/client';
import { PrestaShopClient, type PrestaShopProductDetails } from '../prestashop/prestashop-client';

export interface ImportProductsResult {
  shopId: string;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  skippedNoSku: number;
}

export interface ImportProductsOptions {
  limit?: number;
  activeOnly?: boolean;
}

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

export async function importProductsFromShop(
  shopId: string,
  options: ImportProductsOptions = {},
): Promise<ImportProductsResult> {
  const tenantId = requireTenantId();
  const shop = await prisma.shop.findFirst({ where: { id: shopId, tenantId } });
  if (!shop) throw new Error('Sklep nie znaleziony');
  if (shop.status !== 'ACTIVE') throw new Error('Sklep jest nieaktywny');

  const products = await fetchShopProducts(shop, options);
  const result: ImportProductsResult = {
    shopId,
    fetched: products.length,
    created: 0,
    updated: 0,
    skipped: 0,
    skippedNoSku: 0,
  };

  for (const product of products) {
    if (!product.sku) {
      result.skipped++;
      result.skippedNoSku++;
      continue;
    }

    const existing = await prisma.shopProductMapping.findUnique({
      where: {
        shopId_externalProductId: {
          shopId,
          externalProductId: product.id,
        },
      },
    });

    await prisma.shopProductMapping.upsert({
      where: {
        shopId_externalProductId: {
          shopId,
          externalProductId: product.id,
        },
      },
      create: {
        tenantId,
        shopId,
        externalProductId: product.id,
        externalSku: product.sku,
        externalName: product.name,
        externalPrice: product.price,
        isActive: product.active,
        lastSyncAt: new Date(),
      },
      update: {
        externalSku: product.sku,
        externalName: product.name,
        externalPrice: product.price,
        isActive: product.active,
        lastSyncAt: new Date(),
      },
    });

    if (existing) result.updated++;
    else result.created++;
  }

  await prisma.shop.update({
    where: { id: shopId },
    data: { lastSyncAt: new Date() },
  });

  return result;
}

export async function createWarehouseProductFromMapping(mappingId: string) {
  const tenantId = requireTenantId();
  return prisma.$transaction(async (tx) => {
    const mapping = await tx.shopProductMapping.findFirst({
      where: { id: mappingId, tenantId },
      include: { shop: true, warehouseProduct: true },
    });

    if (!mapping) throw new Error('Mapowanie nie znalezione');
    if (mapping.warehouseProductId) return mapping;

    const warehouseProduct = await tx.warehouseProduct.upsert({
      where: {
        tenantId_sku: {
          tenantId,
          sku: mapping.externalSku,
        },
      },
      create: {
        tenantId,
        sku: mapping.externalSku,
        name: mapping.externalName || mapping.externalSku,
        unit: 'szt',
        retailPrice: mapping.externalPrice,
      },
      update: {},
    });

    return tx.shopProductMapping.update({
      where: { id: mapping.id },
      data: { warehouseProductId: warehouseProduct.id },
      include: { shop: true, warehouseProduct: true },
    });
  });
}

async function fetchShopProducts(shop: Shop, options: ImportProductsOptions) {
  if (shop.platform !== 'PRESTASHOP') {
    throw new Error(`Import produktów nie obsługuje jeszcze platformy ${shop.platform}`);
  }

  const config = (shop.configJson as any) || {};
  const client = new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey: decrypt(shop.apiKey),
    authType: config.authType || 'WEB_SERVICE',
    adminApiConfig: config.authType === 'ADMIN_API' ? config.adminApi : undefined,
  });

  const limit = options.limit ?? config.productImport?.limit ?? 500;
  const pageSize = Math.min(100, limit);
  const products: PrestaShopProductDetails[] = [];

  for (let offset = 0; products.length < limit; offset += pageSize) {
    const batch = await client.fetchProducts({
      limit: Math.min(pageSize, limit - products.length),
      offset,
      activeOnly: options.activeOnly ?? true,
    });

    products.push(...batch);
    if (batch.length < pageSize) break;
  }

  return products;
}
