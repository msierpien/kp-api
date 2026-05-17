import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { getTenantId } from '../../lib/tenant-context';
import type { Prisma, Shop } from '@prisma/client';
import { PrestaShopClient, type PrestaShopProductDetails } from '../prestashop/prestashop-client';
import { resolveCatalogForProduct } from './warehouse-catalogs.service';

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

export interface ImportLogsQuery {
  page?: number;
  limit?: number;
  shopId?: string;
  status?: string;
}

export interface ImportProductsPreviewResult {
  shopId: string;
  fetched: number;
  willCreate: number;
  willUpdate: number;
  skipped: number;
  skippedNoSku: number;
  withEan: number;
  possibleAutoMapBySku: number;
  possibleAutoMapByEan: number;
  sample: Array<{
    externalProductId: string;
    externalSku: string;
    externalEan?: string;
    externalName: string;
    externalPrice?: number;
    active: boolean;
    action: 'CREATE' | 'UPDATE' | 'SKIP_NO_SKU';
    autoMapCandidate?: 'SKU' | 'EAN';
  }>;
}

export interface CreateWarehouseProductFromMappingOptions {
  catalogId?: string | null;
}

export interface BulkCreateWarehouseProductsInput extends CreateWarehouseProductFromMappingOptions {
  mappingIds: string[];
}

export interface BulkCreateWarehouseProductsFromFiltersInput extends CreateWarehouseProductFromMappingOptions {
  shopId?: string;
  search?: string;
  isMapped?: boolean;
  isActive?: boolean;
  diagnosis?: 'mapped' | 'ready' | 'missingSku' | 'missingEan' | 'nameOnly' | 'missingData';
}

export interface BulkCreateWarehouseProductsResult {
  requested: number;
  created: number;
  linkedExisting: number;
  skippedAlreadyMapped: number;
  failed: number;
  errors: Array<{ mappingId: string; message: string }>;
}

export interface AutoMapShopProductsInput {
  shopId?: string;
  activeOnly?: boolean;
}

export interface AutoMapShopProductsResult {
  scanned: number;
  mapped: number;
  mappedBySku: number;
  mappedByEan: number;
  skippedNoProduct: number;
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
  const startedAt = new Date();

  try {
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

    const productIdsWithSku = products
      .filter((product) => product.sku)
      .map((product) => product.id);
    const existingMappings = productIdsWithSku.length
      ? await prisma.shopProductMapping.findMany({
          where: {
            tenantId,
            shopId,
            externalProductId: { in: productIdsWithSku },
          },
          select: { externalProductId: true },
        })
      : [];
    const existingProductIds = new Set(existingMappings.map((mapping) => mapping.externalProductId));

    for (const product of products) {
      if (!product.sku) {
        result.skipped++;
        result.skippedNoSku++;
        continue;
      }

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
          externalEan: product.ean,
          externalName: product.name,
          externalPrice: product.price,
          isActive: product.active,
          lastSyncAt: new Date(),
        },
        update: {
          externalSku: product.sku,
          externalEan: product.ean,
          externalName: product.name,
          externalPrice: product.price,
          isActive: product.active,
          lastSyncAt: new Date(),
        },
      });

      if (existingProductIds.has(product.id)) result.updated++;
      else result.created++;
    }

    await prisma.shop.update({
      where: { id: shopId },
      data: { lastSyncAt: new Date() },
    });

    await createImportLog(tenantId, shopId, startedAt, {
      status: 'SUCCESS',
      itemsFetched: result.fetched,
      mappingsCreated: result.created,
      mappingsUpdated: result.updated,
      skipped: result.skipped,
      skippedNoSku: result.skippedNoSku,
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Błąd importu produktów sklepu';
    await createImportLog(tenantId, shopId, startedAt, {
      status: 'FAILED',
      errorMessage: message,
    });
    throw error;
  }
}

export async function previewProductsImport(
  shopId: string,
  options: ImportProductsOptions = {},
): Promise<ImportProductsPreviewResult> {
  const tenantId = requireTenantId();
  const shop = await prisma.shop.findFirst({ where: { id: shopId, tenantId } });
  if (!shop) throw new Error('Sklep nie znaleziony');
  if (shop.status !== 'ACTIVE') throw new Error('Sklep jest nieaktywny');

  const products = await fetchShopProducts(shop, options);
  const result: ImportProductsPreviewResult = {
    shopId,
    fetched: products.length,
    willCreate: 0,
    willUpdate: 0,
    skipped: 0,
    skippedNoSku: 0,
    withEan: 0,
    possibleAutoMapBySku: 0,
    possibleAutoMapByEan: 0,
    sample: [],
  };

  const productIds = products.map((product) => product.id);
  const skus = uniqueNonEmpty(products.map((product) => product.sku));
  const eans = uniqueNonEmpty(products.map((product) => product.ean));

  const [existingMappings, skuProducts, eanBarcodes] = await Promise.all([
    productIds.length
      ? prisma.shopProductMapping.findMany({
          where: {
            tenantId,
            shopId,
            externalProductId: { in: productIds },
          },
          select: { externalProductId: true },
        })
      : Promise.resolve([]),
    skus.length
      ? prisma.warehouseProduct.findMany({
          where: {
            tenantId,
            sku: { in: skus },
          },
          select: { sku: true },
        })
      : Promise.resolve([]),
    eans.length
      ? prisma.warehouseProductBarcode.findMany({
          where: {
            tenantId,
            ean: { in: eans },
            isActive: true,
          },
          select: { ean: true },
        })
      : Promise.resolve([]),
  ]);

  const existingProductIds = new Set(existingMappings.map((mapping) => mapping.externalProductId));
  const warehouseSkus = new Set(skuProducts.map((product) => product.sku));
  const warehouseEans = new Set(eanBarcodes.map((barcode) => barcode.ean));

  for (const product of products) {
    if (product.ean) result.withEan++;

    if (!product.sku) {
      result.skipped++;
      result.skippedNoSku++;
      if (result.sample.length < 20) {
        result.sample.push({
          externalProductId: product.id,
          externalSku: '',
          externalEan: product.ean,
          externalName: product.name,
          externalPrice: product.price,
          active: product.active,
          action: 'SKIP_NO_SKU',
        });
      }
      continue;
    }

    const hasExistingMapping = existingProductIds.has(product.id);
    if (hasExistingMapping) result.willUpdate++;
    else result.willCreate++;

    const autoMapCandidate = warehouseSkus.has(product.sku)
      ? 'SKU'
      : product.ean && warehouseEans.has(product.ean)
        ? 'EAN'
        : undefined;
    if (autoMapCandidate === 'SKU') result.possibleAutoMapBySku++;
    if (autoMapCandidate === 'EAN') result.possibleAutoMapByEan++;

    if (result.sample.length < 20) {
      result.sample.push({
        externalProductId: product.id,
        externalSku: product.sku,
        externalEan: product.ean,
        externalName: product.name,
        externalPrice: product.price,
        active: product.active,
        action: hasExistingMapping ? 'UPDATE' : 'CREATE',
        autoMapCandidate,
      });
    }
  }

  return result;
}

export async function getProductImportLogs(query: ImportLogsQuery = {}) {
  const tenantId = requireTenantId();
  const { page = 1, limit = 50, shopId, status } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.ShopProductImportLogWhereInput = { tenantId };
  if (shopId) where.shopId = shopId;
  if (status) where.status = status;

  const [data, total] = await Promise.all([
    prisma.shopProductImportLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { startedAt: 'desc' },
      include: { shop: true },
    }),
    prisma.shopProductImportLog.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function createWarehouseProductFromMapping(
  mappingId: string,
  options: CreateWarehouseProductFromMappingOptions = {},
) {
  const tenantId = requireTenantId();
  const result = await prisma.$transaction((tx) => createWarehouseProductFromMappingInTx(tx, tenantId, mappingId, options));
  return result.mapping;
}

export async function bulkCreateWarehouseProductsFromMappings(
  input: BulkCreateWarehouseProductsInput,
): Promise<BulkCreateWarehouseProductsResult> {
  const tenantId = requireTenantId();
  const uniqueMappingIds = Array.from(new Set(input.mappingIds.filter(Boolean)));
  const result: BulkCreateWarehouseProductsResult = {
    requested: uniqueMappingIds.length,
    created: 0,
    linkedExisting: 0,
    skippedAlreadyMapped: 0,
    failed: 0,
    errors: [],
  };

  for (const mappingId of uniqueMappingIds) {
    try {
      const item = await prisma.$transaction((tx) => createWarehouseProductFromMappingInTx(tx, tenantId, mappingId, input));
      if (item.alreadyMapped) result.skippedAlreadyMapped++;
      else if (item.productCreated) result.created++;
      else result.linkedExisting++;
    } catch (error) {
      result.failed++;
      result.errors.push({
        mappingId,
        message: error instanceof Error ? error.message : 'Nieznany błąd',
      });
    }
  }

  return result;
}

export async function bulkCreateWarehouseProductsFromFilters(
  input: BulkCreateWarehouseProductsFromFiltersInput,
): Promise<BulkCreateWarehouseProductsResult> {
  const tenantId = requireTenantId();
  if (input.shopId) {
    const shop = await prisma.shop.findFirst({ where: { id: input.shopId, tenantId }, select: { id: true } });
    if (!shop) throw new Error('Sklep nie znaleziony');
  }

  const where: Prisma.ShopProductMappingWhereInput = {
    tenantId,
    warehouseProductId: input.isMapped === true ? { not: null } : null,
  };
  if (input.shopId) where.shopId = input.shopId;
  if (input.isActive !== undefined) where.isActive = input.isActive;
  applyShopMappingDiagnosis(where, input.diagnosis);
  if (input.search) {
    where.OR = [
      { externalSku: { contains: input.search, mode: 'insensitive' } },
      { externalName: { contains: input.search, mode: 'insensitive' } },
      { externalProductId: { contains: input.search, mode: 'insensitive' } },
    ];
  }

  const mappings = await prisma.shopProductMapping.findMany({
    where,
    orderBy: [{ isActive: 'desc' }, { externalSku: 'asc' }],
    select: { id: true },
  });

  return bulkCreateWarehouseProductsFromMappings({
    mappingIds: mappings.map((mapping) => mapping.id),
    catalogId: input.catalogId,
  });
}

function applyShopMappingDiagnosis(
  where: Prisma.ShopProductMappingWhereInput,
  diagnosis?: BulkCreateWarehouseProductsFromFiltersInput['diagnosis'],
) {
  if (!diagnosis) return;

  if (diagnosis === 'mapped') {
    where.warehouseProductId = { not: null };
    return;
  }

  where.warehouseProductId = null;

  if (diagnosis === 'ready') {
    where.externalSku = { not: '' };
    where.externalEan = { not: null };
    where.externalName = { not: null };
    return;
  }

  if (diagnosis === 'missingSku') {
    where.externalSku = '';
    return;
  }

  if (diagnosis === 'missingEan') {
    where.externalSku = { not: '' };
    where.externalEan = null;
    return;
  }

  if (diagnosis === 'nameOnly') {
    where.externalSku = '';
    where.externalEan = null;
    where.externalName = { not: null };
    return;
  }

  if (diagnosis === 'missingData') {
    where.externalSku = '';
    where.externalEan = null;
    where.externalName = null;
  }
}

export async function autoMapShopProducts(input: AutoMapShopProductsInput = {}): Promise<AutoMapShopProductsResult> {
  const tenantId = requireTenantId();

  if (input.shopId) {
    const shop = await prisma.shop.findFirst({ where: { id: input.shopId, tenantId } });
    if (!shop) throw new Error('Sklep nie znaleziony');
  }

  const where: Prisma.ShopProductMappingWhereInput = {
    tenantId,
    warehouseProductId: null,
  };
  if (input.shopId) where.shopId = input.shopId;
  if (input.activeOnly ?? true) where.isActive = true;

  const mappings = await prisma.shopProductMapping.findMany({
    where,
    orderBy: { externalSku: 'asc' },
  });

  const result: AutoMapShopProductsResult = {
    scanned: mappings.length,
    mapped: 0,
    mappedBySku: 0,
    mappedByEan: 0,
    skippedNoProduct: 0,
  };

  for (const mapping of mappings) {
    let product = await prisma.warehouseProduct.findUnique({
      where: { tenantId_sku: { tenantId, sku: mapping.externalSku } },
      select: { id: true },
    });
    let matchedBy: 'SKU' | 'EAN' | null = product ? 'SKU' : null;

    if (!product && mapping.externalEan) {
      const barcode = await prisma.warehouseProductBarcode.findFirst({
        where: { tenantId, ean: mapping.externalEan, isActive: true },
        select: { warehouseProductId: true },
      });

      if (barcode) {
        product = { id: barcode.warehouseProductId };
        matchedBy = 'EAN';
      }
    }

    if (!product) {
      result.skippedNoProduct++;
      continue;
    }

    await prisma.shopProductMapping.update({
      where: { id: mapping.id },
      data: { warehouseProductId: product.id },
    });
    result.mapped++;
    if (matchedBy === 'SKU') result.mappedBySku++;
    if (matchedBy === 'EAN') result.mappedByEan++;
  }

  return result;
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

  const limit = normalizeImportLimit(options.limit);
  const pageSize = Math.min(100, limit ?? 100);
  const products: PrestaShopProductDetails[] = [];

  for (let offset = 0; limit === undefined || products.length < limit; offset += pageSize) {
    const remaining = limit === undefined ? pageSize : limit - products.length;
    const batchLimit = Math.min(pageSize, remaining);
    const batch = await client.fetchProducts({
      limit: batchLimit,
      offset,
      activeOnly: options.activeOnly ?? true,
    });

    products.push(...batch);
    if (batch.length < batchLimit) break;
  }

  return products;
}

function normalizeImportLimit(limit?: number) {
  if (limit === undefined || limit === null) return undefined;
  if (!Number.isFinite(limit) || limit <= 0) return undefined;
  return Math.floor(limit);
}

function uniqueNonEmpty(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

async function createWarehouseProductFromMappingInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  mappingId: string,
  options: CreateWarehouseProductFromMappingOptions = {},
) {
  const mapping = await tx.shopProductMapping.findFirst({
    where: { id: mappingId, tenantId },
    include: { shop: true, warehouseProduct: { include: { catalog: true } }, personalizationTemplate: true },
  });

  if (!mapping) throw new Error('Mapowanie nie znalezione');
  if (mapping.warehouseProductId) {
    return { mapping, productCreated: false, alreadyMapped: true };
  }

  const catalog = await resolveCatalogForProduct(tenantId, options.catalogId, tx);
  const existingProduct = await tx.warehouseProduct.findUnique({
    where: {
      tenantId_sku: {
        tenantId,
        sku: mapping.externalSku,
      },
    },
  });

  const warehouseProduct = existingProduct ?? await tx.warehouseProduct.create({
    data: {
      tenantId,
      catalogId: catalog.id,
      sku: mapping.externalSku,
      name: mapping.externalName || mapping.externalSku,
      unit: 'szt',
      retailPrice: mapping.externalPrice,
    },
  });

  const updatedMapping = await tx.shopProductMapping.update({
    where: { id: mapping.id },
    data: { warehouseProductId: warehouseProduct.id },
    include: { shop: true, warehouseProduct: { include: { catalog: true } }, personalizationTemplate: true },
  });

  return {
    mapping: updatedMapping,
    productCreated: !existingProduct,
    alreadyMapped: false,
  };
}

async function createImportLog(
  tenantId: string,
  shopId: string,
  startedAt: Date,
  data: {
    status: string;
    itemsFetched?: number;
    mappingsCreated?: number;
    mappingsUpdated?: number;
    skipped?: number;
    skippedNoSku?: number;
    errorMessage?: string;
  },
) {
  await prisma.shopProductImportLog.create({
    data: {
      tenantId,
      shopId,
      status: data.status,
      itemsFetched: data.itemsFetched ?? 0,
      mappingsCreated: data.mappingsCreated ?? 0,
      mappingsUpdated: data.mappingsUpdated ?? 0,
      skipped: data.skipped ?? 0,
      skippedNoSku: data.skippedNoSku ?? 0,
      errorMessage: data.errorMessage,
      startedAt,
      finishedAt: new Date(),
    },
  });
}
