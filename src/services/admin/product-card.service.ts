import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import {
  ProductContentConflictError,
  buildPrestaShopProductContentAdapter,
} from '../shops/prestashop-product-content-adapter';

export interface ProductCardQuery {
  shopId?: string;
  sections?: string;
  refresh?: boolean | string;
  langId?: number | string;
}

export interface ProductCardPatchInput extends Record<string, unknown> {
  shopId?: string;
  expectedHash?: string;
}

export interface ProductCardMediaInput extends Record<string, unknown> {
  shopId?: string;
  imageId?: string | number;
  imageIds?: Array<string | number>;
}

export interface ProductCardSyncConfigInput {
  shopId: string;
  fields: Record<string, unknown>;
}

export interface ProductCardSyncInput {
  shopId?: string;
  fields?: string[];
  action?: 'refresh' | 'push';
}

const DEFAULT_SYNC_FIELDS = {
  stock: 'up',
  price: 'up',
  content: 'down',
  media: 'down',
  attributes: 'down',
  seo: 'down',
  ean: 'off',
};

type ProductWithMappings = Prisma.WarehouseProductGetPayload<{
  include: {
    catalog: true;
    leadTimeGroup: true;
    barcodes: true;
    shopProductMappings: { include: { shop: true } };
    shopPrices: { include: { shop: { select: { id: true; name: true } } } };
    _count: { select: { barcodes: true; shopProductMappings: true; wholesaleMappings: true } };
  };
}>;

export async function getProductCard(productId: string, query: ProductCardQuery = {}) {
  const tenantId = requireTenantId();
  const product = await getProductForCard(tenantId, productId);
  const mapping = selectMapping(product, query.shopId);
  const syncConfig = mapping ? await getSyncConfig(product.id, mapping.shopId) : null;
  const logs = await prisma.productCardOperationLog.findMany({
    where: { tenantId, warehouseProductId: product.id, ...(mapping ? { shopId: mapping.shopId } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });

  let remote: unknown = null;
  let moduleStatus: Record<string, unknown> = { configured: false, status: 'NO_MAPPING' };

  if (mapping) {
    const shouldRefresh = query.refresh === true || query.refresh === 'true' || query.refresh === '1';
    const cached = await prisma.productChannelSnapshot.findUnique({
      where: { warehouseProductId_shopId: { warehouseProductId: product.id, shopId: mapping.shopId } },
    });

    if (!shouldRefresh && cached) {
      remote = cached.payloadJson;
      moduleStatus = { configured: true, status: 'CACHED', fetchedAt: cached.fetchedAt, hash: cached.hash };
    } else {
      try {
        remote = await fetchAndCacheSnapshot(tenantId, product, mapping, query.langId);
        moduleStatus = { configured: true, status: 'OK', fetchedAt: new Date(), hash: remoteHash(remote) };
      } catch (error) {
        remote = cached?.payloadJson ?? null;
        moduleStatus = {
          configured: false,
          status: cached ? 'USING_CACHE_AFTER_ERROR' : 'ERROR',
          message: error instanceof Error ? error.message : 'Nie udało się pobrać snapshotu PrestaShop',
          fetchedAt: cached?.fetchedAt ?? null,
          hash: cached?.hash ?? null,
        };
      }
    }
  }

  return {
    product,
    selectedShopId: mapping?.shopId ?? null,
    selectedMappingId: mapping?.id ?? null,
    channels: await buildChannels(product),
    remote,
    completeness: buildCompleteness(product, remote),
    syncConfig: syncConfig ?? { fields: DEFAULT_SYNC_FIELDS },
    moduleStatus,
    operationLogs: logs,
  };
}

export async function refreshProductCard(productId: string, input: ProductCardPatchInput = {}) {
  const tenantId = requireTenantId();
  const { product, mapping } = await requireProductMapping(tenantId, productId, input.shopId);
  const snapshot = await runLoggedOperation({
    tenantId,
    product,
    mapping,
    section: 'snapshot',
    operation: 'refresh',
    direction: 'SHOP_TO_PANEL',
    payload: { shopId: mapping.shopId },
    run: () => fetchAndCacheSnapshot(tenantId, product, mapping, input.langId as number | string | undefined),
  });
  return snapshot;
}

export async function patchProductCardContent(productId: string, input: ProductCardPatchInput) {
  return patchProductCard(productId, input, 'content');
}

export async function patchProductCardParameters(productId: string, input: ProductCardPatchInput) {
  return patchProductCard(productId, input, 'parameters');
}

export async function patchProductCard(productId: string, input: ProductCardPatchInput, section = 'content') {
  const tenantId = requireTenantId();
  const { product, mapping } = await requireProductMapping(tenantId, productId, input.shopId);
  const payload = stripShopFields(input);
  validateCategoryPatchPayload(payload);
  const snapshot = await runLoggedOperation({
    tenantId,
    product,
    mapping,
    section,
    operation: 'patch',
    direction: 'PANEL_TO_SHOP',
    payload,
    run: async () => {
      const adapter = buildPrestaShopProductContentAdapter(mapping.shop);
      const result = await adapter.patch(mapping.externalProductId, payload);
      await cacheSnapshot(tenantId, product.id, mapping.shopId, result);
      return result;
    },
  });
  return snapshot;
}

export async function importProductCardMedia(productId: string, input: ProductCardMediaInput) {
  return runMediaOperation(productId, input, 'media', 'media-import', 'mediaImport');
}

export async function updateProductCardMedia(productId: string, input: ProductCardMediaInput) {
  return runMediaOperation(productId, input, 'media', 'media-update', 'mediaUpdate');
}

export async function orderProductCardMedia(productId: string, input: ProductCardMediaInput) {
  return runMediaOperation(productId, input, 'media', 'media-order', 'mediaOrder');
}

export async function deleteProductCardMedia(productId: string, input: ProductCardMediaInput) {
  return runMediaOperation(productId, input, 'media', 'media-delete', 'mediaDelete');
}

export async function upsertProductCardSyncConfig(productId: string, input: ProductCardSyncConfigInput) {
  const tenantId = requireTenantId();
  const product = await getProductForCard(tenantId, productId);
  const mapping = selectMapping(product, input.shopId);
  if (!mapping) throw new Error('Produkt nie ma mapowania do wybranego sklepu');

  const config = await prisma.productChannelSyncConfig.upsert({
    where: { warehouseProductId_shopId: { warehouseProductId: product.id, shopId: mapping.shopId } },
    create: {
      tenantId,
      warehouseProductId: product.id,
      shopId: mapping.shopId,
      fieldsJson: normalizeSyncFields(input.fields),
    },
    update: {
      fieldsJson: normalizeSyncFields(input.fields),
    },
  });

  return { fields: config.fieldsJson };
}

export async function syncProductCard(productId: string, input: ProductCardSyncInput = {}) {
  if (input.action && input.action !== 'refresh' && input.action !== 'push') {
    throw new Error('Nieobsługiwana akcja synchronizacji karty produktu');
  }

  // Content source of truth is PrestaShop, so the safe default sync action is refresh/pull.
  return refreshProductCard(productId, { shopId: input.shopId });
}

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

async function getProductForCard(tenantId: string, productId: string): Promise<ProductWithMappings> {
  const product = await prisma.warehouseProduct.findFirst({
    where: { id: productId, tenantId },
    include: {
      catalog: true,
      leadTimeGroup: true,
      barcodes: { where: { isActive: true }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
      shopProductMappings: {
        where: { isActive: true },
        include: { shop: true },
        orderBy: { updatedAt: 'desc' },
      },
      shopPrices: {
        include: { shop: { select: { id: true, name: true } } },
        orderBy: { calculatedAt: 'desc' },
      },
      _count: {
        select: {
          barcodes: { where: { isActive: true } },
          shopProductMappings: { where: { isActive: true } },
          wholesaleMappings: { where: { isActive: true } },
        },
      },
    },
  });
  if (!product) throw new Error('Produkt nie znaleziony');
  return product;
}

async function requireProductMapping(tenantId: string, productId: string, shopId?: string | null) {
  const product = await getProductForCard(tenantId, productId);
  const mapping = selectMapping(product, shopId);
  if (!mapping) throw new Error('Produkt nie ma aktywnego mapowania PrestaShop');
  return { product, mapping };
}

function selectMapping(product: ProductWithMappings, shopId?: string | null) {
  return product.shopProductMappings.find((mapping) =>
    mapping.shop.platform === 'PRESTASHOP'
    && mapping.shop.status === 'ACTIVE'
    && (!shopId || mapping.shopId === shopId),
  ) ?? null;
}

async function buildChannels(product: ProductWithMappings) {
  const configs = await prisma.productChannelSyncConfig.findMany({
    where: { warehouseProductId: product.id },
  });
  const configByShop = new Map(configs.map((config) => [config.shopId, config.fieldsJson]));
  return product.shopProductMappings.map((mapping) => ({
    id: mapping.id,
    shopId: mapping.shopId,
    shopName: mapping.shop.name,
    platform: mapping.shop.platform,
    externalProductId: mapping.externalProductId,
    externalSku: mapping.externalSku,
    externalName: mapping.externalName,
    externalPrice: mapping.externalPrice,
    lastSyncAt: mapping.lastSyncAt,
    isActive: mapping.isActive,
    contentConfigured: Boolean(contentModuleKey(mapping.shop.configJson)),
    syncConfig: configByShop.get(mapping.shopId) ?? DEFAULT_SYNC_FIELDS,
  }));
}

async function getSyncConfig(productId: string, shopId: string) {
  const config = await prisma.productChannelSyncConfig.findUnique({
    where: { warehouseProductId_shopId: { warehouseProductId: productId, shopId } },
  });
  return config ? { fields: config.fieldsJson } : null;
}

async function fetchAndCacheSnapshot(
  tenantId: string,
  product: ProductWithMappings,
  mapping: ProductWithMappings['shopProductMappings'][number],
  langId?: number | string,
) {
  const adapter = buildPrestaShopProductContentAdapter(mapping.shop);
  const snapshot = await adapter.snapshot(mapping.externalProductId, { langId });
  await cacheSnapshot(tenantId, product.id, mapping.shopId, snapshot);
  return snapshot;
}

async function cacheSnapshot(tenantId: string, productId: string, shopId: string, snapshot: unknown) {
  const hash = remoteHash(snapshot);
  await prisma.productChannelSnapshot.upsert({
    where: { warehouseProductId_shopId: { warehouseProductId: productId, shopId } },
    create: {
      tenantId,
      warehouseProductId: productId,
      shopId,
      hash,
      payloadJson: toJson(snapshot),
      fetchedAt: new Date(),
    },
    update: {
      hash,
      payloadJson: toJson(snapshot),
      fetchedAt: new Date(),
    },
  });
}

async function runLoggedOperation<T>(input: {
  tenantId: string;
  product: ProductWithMappings;
  mapping: ProductWithMappings['shopProductMappings'][number];
  section: string;
  operation: string;
  direction: string;
  payload: unknown;
  run: () => Promise<T>;
}): Promise<T> {
  const requestHash = remoteHash(input.payload);
  try {
    const result = await input.run();
    await prisma.productCardOperationLog.create({
      data: {
        tenantId: input.tenantId,
        warehouseProductId: input.product.id,
        shopId: input.mapping.shopId,
        section: input.section,
        operation: input.operation,
        direction: input.direction,
        status: 'SUCCESS',
        requestHash,
        responseHash: remoteHash(result),
        payloadJson: toJson(input.payload),
      },
    });
    return result;
  } catch (error) {
    await prisma.productCardOperationLog.create({
      data: {
        tenantId: input.tenantId,
        warehouseProductId: input.product.id,
        shopId: input.mapping.shopId,
        section: input.section,
        operation: input.operation,
        direction: input.direction,
        status: 'FAILED',
        requestHash,
        errorMessage: error instanceof Error ? error.message : 'Nieznany błąd operacji karty produktu',
        payloadJson: toJson(input.payload),
      },
    });
    throw error;
  }
}

async function runMediaOperation(
  productId: string,
  input: ProductCardMediaInput,
  section: string,
  operation: string,
  method: 'mediaImport' | 'mediaUpdate' | 'mediaOrder' | 'mediaDelete',
) {
  const tenantId = requireTenantId();
  const { product, mapping } = await requireProductMapping(tenantId, productId, input.shopId);
  const payload = stripShopFields(input);
  return runLoggedOperation({
    tenantId,
    product,
    mapping,
    section,
    operation,
    direction: 'PANEL_TO_SHOP',
    payload,
    run: async () => {
      const adapter = buildPrestaShopProductContentAdapter(mapping.shop);
      const result = await adapter[method](mapping.externalProductId, payload);
      await cacheSnapshot(tenantId, product.id, mapping.shopId, result);
      return result;
    },
  });
}

function stripShopFields<T extends Record<string, unknown>>(input: T) {
  const payload = { ...input };
  delete payload.shopId;
  return payload;
}

function validateCategoryPatchPayload(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.categories)) return;

  const categoryIds = payload.categories
    .map((category) => {
      if (typeof category === 'number' || typeof category === 'string') return Number(category);
      if (isRecord(category)) return Number(category.id);
      return NaN;
    })
    .filter((categoryId) => Number.isFinite(categoryId) && categoryId > 0);

  if (categoryIds.length !== payload.categories.length) {
    throw new Error('Kategorie produktu muszą zawierać poprawne ID PrestaShop');
  }

  const identity = isRecord(payload.identity) ? payload.identity : {};
  const defaultCategoryId = Number(identity.idCategoryDefault ?? 0);
  if (Number.isFinite(defaultCategoryId) && defaultCategoryId > 0 && !categoryIds.includes(defaultCategoryId)) {
    throw new Error('Kategoria domyślna musi znajdować się na liście przypisanych kategorii');
  }
}

function normalizeSyncFields(fields: Record<string, unknown>) {
  return {
    ...DEFAULT_SYNC_FIELDS,
    ...(fields || {}),
  };
}

function buildCompleteness(product: ProductWithMappings, remote: unknown) {
  const snapshot = isRecord(remote) ? remote : {};
  const content = isRecord(snapshot.content) ? snapshot.content : {};
  const seo = isRecord(snapshot.seo) ? snapshot.seo : {};
  const media = isRecord(snapshot.media) ? snapshot.media : {};
  const images = Array.isArray(media.images) ? media.images : [];
  const features = Array.isArray(snapshot.features) ? snapshot.features : [];
  const price = product.retailPrice ?? product.shopPrices[0]?.grossPrice ?? null;

  const checks = [
    { key: 'description', label: 'Opis', ok: Boolean(content.longDescriptionHtml || content.shortDescriptionHtml) },
    { key: 'media', label: 'Zdjęcia', ok: images.length > 0 },
    { key: 'parameters', label: 'Parametry', ok: features.length > 0 },
    { key: 'seo', label: 'SEO', ok: Boolean(seo.metaTitle && seo.metaDescription && seo.linkRewrite) },
    { key: 'ean', label: 'EAN', ok: product.barcodes.length > 0 },
    { key: 'prices', label: 'Ceny', ok: price !== null },
  ];
  const done = checks.filter((check) => check.ok).length;
  return {
    percent: Math.round((done / checks.length) * 100),
    checks,
  };
}

function contentModuleKey(configJson: unknown) {
  const config = (configJson || {}) as Record<string, unknown>;
  return config.productContentApiKey ?? config.contentModuleApiKey ?? null;
}

function remoteHash(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex');
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function productCardErrorStatus(error: unknown) {
  if (error instanceof ProductContentConflictError) return 409;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('nie znalezion') || message.includes('not found')) return 404;
  if (message.includes('Brak kontekstu')) return 400;
  return 400;
}

export function productCardErrorBody(error: unknown) {
  if (error instanceof ProductContentConflictError) {
    return { error: 'Conflict', message: error.message, data: error.data };
  }
  return {
    error: 'Error',
    message: error instanceof Error ? error.message : 'Błąd operacji karty produktu',
  };
}
