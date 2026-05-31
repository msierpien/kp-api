import { Prisma, type Shop, type WarehouseProductBarcode, type WholesaleProductMapping, type WholesaleProvider } from '@prisma/client';
import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { getTenantId } from '../../lib/tenant-context';
import {
  PrestaShopClient,
  type CreatePrestaShopProductInput,
  type PrestaShopProductDetails,
} from '../prestashop/prestashop-client';

export type ShopProductPublicationPreviewStatus =
  | 'READY'
  | 'NEEDS_PRICE'
  | 'NEEDS_SOURCE'
  | 'NO_WHOLESALE_OFFER'
  | 'DUPLICATE_LOCAL'
  | 'DUPLICATE_REMOTE'
  | 'NOT_FOUND';

export interface ShopProductPublicationItemInput {
  warehouseProductId: string;
  price?: number | null;
  sourceWholesaleMappingId?: string | null;
}

export interface ShopProductPublicationInput {
  shopId: string;
  categoryId?: string | null;
  price?: number | null;
  sourceWholesaleMappingId?: string | null;
  imageLimit?: number | null;
}

export interface BulkShopProductPublicationPreviewInput {
  shopId: string;
  categoryId?: string | null;
  imageLimit?: number | null;
  productIds?: string[];
  items?: ShopProductPublicationItemInput[];
}

export interface BulkShopProductPublicationInput {
  shopId: string;
  categoryId: string;
  imageLimit?: number | null;
  items: ShopProductPublicationItemInput[];
}

export interface RemoveShopProductsInput {
  shopId?: string;
  productIds?: string[];
  mappingIds?: string[];
  remoteAction?: 'DELETE' | 'DEACTIVATE';
  deactivateLocalProduct?: boolean;
}

export interface ShopProductPublicationSourcePreview {
  mappingId: string;
  providerId: string;
  providerName: string;
  externalSku: string;
  externalEan: string | null;
  externalName: string | null;
  lastKnownStock: number | null;
  lastKnownPrice: number | null;
  imageCount: number;
  descriptionPresent: boolean;
}

export interface ShopProductPublicationPreviewItem {
  warehouseProductId: string;
  sku: string;
  name: string;
  price: number | null;
  ean: string | null;
  status: ShopProductPublicationPreviewStatus;
  messages: string[];
  selectedSourceWholesaleMappingId: string | null;
  availableSources: ShopProductPublicationSourcePreview[];
  imageCount: number;
  descriptionPresent: boolean;
  duplicateRemoteProduct?: PrestaShopProductDetails | null;
}

export interface BulkShopProductPublicationPreviewResult {
  shopId: string;
  categoryId: string | null;
  imageLimit: number;
  requested: number;
  ready: number;
  needsPrice: number;
  needsSource: number;
  blocked: number;
  items: ShopProductPublicationPreviewItem[];
}

export interface ShopProductPublicationResultItem {
  warehouseProductId: string;
  sku?: string;
  status: 'CREATED' | 'SKIPPED' | 'FAILED';
  previewStatus?: ShopProductPublicationPreviewStatus;
  externalProductId?: string;
  mappingId?: string;
  warnings: string[];
  message?: string;
}

export interface BulkShopProductPublicationResult {
  shopId: string;
  categoryId: string;
  requested: number;
  created: number;
  skipped: number;
  failed: number;
  items: ShopProductPublicationResultItem[];
}

export interface RemoveShopProductResultItem {
  warehouseProductId: string | null;
  mappingId: string;
  externalProductId: string;
  status: 'REMOVED' | 'FAILED';
  remoteAction: 'DELETE' | 'DEACTIVATE';
  message?: string;
}

export interface RemoveShopProductsResult {
  requested: number;
  removed: number;
  failed: number;
  items: RemoveShopProductResultItem[];
}

type ProductForPublication = Prisma.WarehouseProductGetPayload<{
  include: {
    barcodes: true;
    shopProductMappings: true;
    wholesaleMappings: {
      include: { provider: true };
    };
  };
}>;

type WholesaleMappingWithProvider = WholesaleProductMapping & { provider: WholesaleProvider };

type ShopPublicationConfig = {
  authType?: 'WEB_SERVICE' | 'ADMIN_API' | string;
  adminApi?: {
    clientId: string;
    clientSecret: string;
    scopes: string[];
  };
  languageId?: string | number;
  idShopDefault?: string | number;
  taxRulesGroupId?: string | number;
  prestashopProductDefaults?: ProductCreateDefaults;
  productCreate?: ProductCreateDefaults;
};

type ProductCreateDefaults = {
  languageId?: string | number;
  idShopDefault?: string | number;
  taxRulesGroupId?: string | number;
};

const DEFAULT_IMAGE_LIMIT = 10;
const MAX_IMAGE_LIMIT = 20;
const MAX_BULK_ITEMS = 50;

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

export async function previewShopProductPublication(
  warehouseProductId: string,
  input: ShopProductPublicationInput,
): Promise<ShopProductPublicationPreviewItem> {
  const result = await previewBulkShopProductPublication({
    shopId: input.shopId,
    categoryId: input.categoryId,
    imageLimit: input.imageLimit,
    items: [{
      warehouseProductId,
      price: input.price,
      sourceWholesaleMappingId: input.sourceWholesaleMappingId,
    }],
  });

  return result.items[0];
}

export async function createShopProductFromWarehouseProduct(
  warehouseProductId: string,
  input: ShopProductPublicationInput & { categoryId: string },
) {
  const result = await createBulkShopProductsFromWarehouseProducts({
    shopId: input.shopId,
    categoryId: input.categoryId,
    imageLimit: input.imageLimit,
    items: [{
      warehouseProductId,
      price: input.price,
      sourceWholesaleMappingId: input.sourceWholesaleMappingId,
    }],
  });

  return result.items[0];
}

export async function previewBulkShopProductPublication(
  input: BulkShopProductPublicationPreviewInput,
): Promise<BulkShopProductPublicationPreviewResult> {
  const tenantId = requireTenantId();
  const imageLimit = normalizeImageLimit(input.imageLimit);
  const items = normalizePreviewItems(input);
  const shop = await getPublicationShop(tenantId, input.shopId);
  const client = buildPrestaShopClient(shop);
  const products = await getProductsForPublication(tenantId, shop.id, items.map((item) => item.warehouseProductId));
  const productsById = new Map(products.map((product) => [product.id, product]));
  const rows: ShopProductPublicationPreviewItem[] = [];

  for (const item of items) {
    const product = productsById.get(item.warehouseProductId);
    if (!product) {
      rows.push({
        warehouseProductId: item.warehouseProductId,
        sku: '',
        name: '',
        price: normalizePrice(item.price),
        ean: null,
        status: 'NOT_FOUND',
        messages: ['Produkt magazynowy nie został znaleziony'],
        selectedSourceWholesaleMappingId: item.sourceWholesaleMappingId ?? null,
        availableSources: [],
        imageCount: 0,
        descriptionPresent: false,
        duplicateRemoteProduct: null,
      });
      continue;
    }

    rows.push(await buildPreviewRow(product, item, shop.id, client, imageLimit));
  }

  return summarizePreview({
    shopId: shop.id,
    categoryId: input.categoryId?.trim() || null,
    imageLimit,
    requested: items.length,
    items: rows,
  });
}

export async function createBulkShopProductsFromWarehouseProducts(
  input: BulkShopProductPublicationInput,
): Promise<BulkShopProductPublicationResult> {
  const tenantId = requireTenantId();
  const categoryId = input.categoryId?.trim();
  if (!categoryId) throw new Error('categoryId jest wymagane');

  const imageLimit = normalizeImageLimit(input.imageLimit);
  const items = normalizeCreateItems(input.items);
  const shop = await getPublicationShop(tenantId, input.shopId);
  const client = buildPrestaShopClient(shop);
  const products = await getProductsForPublication(tenantId, shop.id, items.map((item) => item.warehouseProductId));
  const productsById = new Map(products.map((product) => [product.id, product]));
  const resultItems: ShopProductPublicationResultItem[] = [];

  for (const item of items) {
    const product = productsById.get(item.warehouseProductId);
    if (!product) {
      resultItems.push({
        warehouseProductId: item.warehouseProductId,
        status: 'SKIPPED',
        previewStatus: 'NOT_FOUND',
        warnings: [],
        message: 'Produkt magazynowy nie został znaleziony',
      });
      continue;
    }

    try {
      const preview = await buildPreviewRow(product, item, shop.id, client, imageLimit);
      if (preview.status !== 'READY') {
        resultItems.push({
          warehouseProductId: product.id,
          sku: product.sku,
          status: 'SKIPPED',
          previewStatus: preview.status,
          warnings: [],
          message: preview.messages.join('; ') || 'Produkt nie jest gotowy do utworzenia',
        });
        continue;
      }

      const source = product.wholesaleMappings.find((mapping) => mapping.id === preview.selectedSourceWholesaleMappingId);
      if (!source) throw new Error('Nie znaleziono wybranej oferty hurtowni');

      const publicationData = extractPublicationData(source, imageLimit);
      const createInput = buildCreateProductInput(shop, product, preview, categoryId, publicationData.description);
      const createdProduct = await client.createSimpleProduct(createInput);

      const mapping = await prisma.shopProductMapping.create({
        data: {
          tenantId,
          shopId: shop.id,
          warehouseProductId: product.id,
          externalProductId: createdProduct.id,
          externalSku: product.sku,
          externalEan: preview.ean,
          externalName: product.name,
          externalPrice: preview.price,
          isActive: false,
          lastSyncAt: new Date(),
        },
      });

      const warnings = await uploadProductImages(client, createdProduct.id, publicationData.imageUrls);
      resultItems.push({
        warehouseProductId: product.id,
        sku: product.sku,
        status: 'CREATED',
        externalProductId: createdProduct.id,
        mappingId: mapping.id,
        warnings,
      });
    } catch (error) {
      resultItems.push({
        warehouseProductId: product.id,
        sku: product.sku,
        status: 'FAILED',
        warnings: [],
        message: error instanceof Error ? error.message : 'Nieznany błąd tworzenia produktu',
      });
    }
  }

  return {
    shopId: shop.id,
    categoryId,
    requested: items.length,
    created: resultItems.filter((item) => item.status === 'CREATED').length,
    skipped: resultItems.filter((item) => item.status === 'SKIPPED').length,
    failed: resultItems.filter((item) => item.status === 'FAILED').length,
    items: resultItems,
  };
}

export async function removeShopProducts(input: RemoveShopProductsInput): Promise<RemoveShopProductsResult> {
  const tenantId = requireTenantId();
  const remoteAction = input.remoteAction ?? 'DELETE';
  const where: Prisma.ShopProductMappingWhereInput = {
    tenantId,
    isActive: true,
  };

  if (input.shopId) where.shopId = input.shopId;
  if (input.mappingIds?.length) where.id = { in: input.mappingIds };
  if (input.productIds?.length) where.warehouseProductId = { in: input.productIds };
  if (!input.mappingIds?.length && !input.productIds?.length) {
    throw new Error('Wybierz produkty lub mapowania do usunięcia ze sklepu');
  }

  const mappings = await prisma.shopProductMapping.findMany({
    where,
    include: { shop: true },
    take: 500,
  });

  const resultItems: RemoveShopProductResultItem[] = [];

  for (const mapping of mappings) {
    try {
      const client = buildPrestaShopClient(mapping.shop);
      if (remoteAction === 'DEACTIVATE') {
        await client.setProductActive(mapping.externalProductId, false);
      } else {
        await client.deleteProduct(mapping.externalProductId);
      }

      await prisma.$transaction([
        prisma.shopProductMapping.update({
          where: { id: mapping.id },
          data: { isActive: false, lastSyncAt: new Date() },
        }),
        ...(input.deactivateLocalProduct && mapping.warehouseProductId
          ? [prisma.warehouseProduct.update({
              where: { id: mapping.warehouseProductId },
              data: { isActive: false },
            })]
          : []),
      ]);

      resultItems.push({
        warehouseProductId: mapping.warehouseProductId,
        mappingId: mapping.id,
        externalProductId: mapping.externalProductId,
        status: 'REMOVED',
        remoteAction,
      });
    } catch (error) {
      resultItems.push({
        warehouseProductId: mapping.warehouseProductId,
        mappingId: mapping.id,
        externalProductId: mapping.externalProductId,
        status: 'FAILED',
        remoteAction,
        message: error instanceof Error ? error.message : 'Nieznany błąd usuwania produktu sklepowego',
      });
    }
  }

  return {
    requested: mappings.length,
    removed: resultItems.filter((item) => item.status === 'REMOVED').length,
    failed: resultItems.filter((item) => item.status === 'FAILED').length,
    items: resultItems,
  };
}

async function getPublicationShop(tenantId: string, shopId: string) {
  const shop = await prisma.shop.findFirst({ where: { id: shopId, tenantId } });
  if (!shop) throw new Error('Sklep nie znaleziony');
  if (shop.status !== 'ACTIVE') throw new Error('Sklep jest nieaktywny');
  if (shop.platform !== 'PRESTASHOP') throw new Error(`Tworzenie produktów nie obsługuje platformy ${shop.platform}`);
  if (!decrypt(shop.apiKey).trim()) throw new Error('Sklep nie ma skonfigurowanego klucza API');
  return shop;
}

function buildPrestaShopClient(shop: Shop) {
  const config = parseShopPublicationConfig(shop);
  return new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey: decrypt(shop.apiKey),
    authType: config.authType === 'ADMIN_API' ? 'ADMIN_API' : 'WEB_SERVICE',
    adminApiConfig: config.authType === 'ADMIN_API' ? config.adminApi : undefined,
  });
}

async function getProductsForPublication(tenantId: string, shopId: string, productIds: string[]) {
  const uniqueIds = Array.from(new Set(productIds.filter(Boolean)));
  if (uniqueIds.length === 0) return [];

  return prisma.warehouseProduct.findMany({
    where: { tenantId, id: { in: uniqueIds } },
    include: {
      barcodes: {
        where: { isActive: true },
        orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      },
      shopProductMappings: {
        where: { shopId },
      },
      wholesaleMappings: {
        where: {
          isActive: true,
          provider: { isActive: true },
        },
        include: { provider: true },
        orderBy: [{ lastKnownPrice: 'asc' }, { lastSyncAt: 'desc' }],
      },
    },
  });
}

async function buildPreviewRow(
  product: ProductForPublication,
  item: ShopProductPublicationItemInput,
  shopId: string,
  client: PrestaShopClient,
  imageLimit: number,
): Promise<ShopProductPublicationPreviewItem> {
  const messages: string[] = [];
  const price = normalizePrice(item.price) ?? decimalToNumber(product.retailPrice);
  const activeSources = product.wholesaleMappings as WholesaleMappingWithProvider[];
  const selectedSource = resolveSelectedSource(activeSources, item.sourceWholesaleMappingId);
  const duplicateRemoteProduct = await client.findProductByReference(product.sku);
  const duplicateLocal = product.shopProductMappings.some((mapping) => mapping.shopId === shopId);
  const status = resolvePreviewStatus({
    duplicateLocal,
    duplicateRemote: Boolean(duplicateRemoteProduct),
    sourceCount: activeSources.length,
    selectedSourceFound: Boolean(selectedSource),
    explicitSourceMissing: Boolean(item.sourceWholesaleMappingId) && !selectedSource,
    price,
  });

  if (duplicateLocal) messages.push('Produkt ma już lokalne mapowanie do tego sklepu');
  if (duplicateRemoteProduct) messages.push(`PrestaShop ma już produkt z tym SKU (ID ${duplicateRemoteProduct.id})`);
  if (activeSources.length === 0) messages.push('Produkt nie ma aktywnej oferty hurtowni');
  if (price === null) messages.push('Brakuje ceny sprzedaży');
  if (activeSources.length > 1 && !selectedSource) messages.push('Wybierz źródło danych hurtowni');
  if (item.sourceWholesaleMappingId && !selectedSource) messages.push('Wybrana oferta hurtowni nie jest aktywna dla tego produktu');

  const publicationData = selectedSource ? extractPublicationData(selectedSource, imageLimit) : { description: null, imageUrls: [] };

  return {
    warehouseProductId: product.id,
    sku: product.sku,
    name: product.name,
    price,
    ean: chooseProductEan(product.barcodes, selectedSource),
    status,
    messages,
    selectedSourceWholesaleMappingId: selectedSource?.id ?? null,
    availableSources: activeSources.map((source) => {
      const data = extractPublicationData(source, imageLimit);
      return {
        mappingId: source.id,
        providerId: source.providerId,
        providerName: source.provider.name,
        externalSku: source.externalSku,
        externalEan: source.externalEan,
        externalName: source.externalName,
        lastKnownStock: decimalToNumber(source.lastKnownStock),
        lastKnownPrice: decimalToNumber(source.lastKnownPrice),
        imageCount: data.imageUrls.length,
        descriptionPresent: Boolean(data.description),
      };
    }),
    imageCount: publicationData.imageUrls.length,
    descriptionPresent: Boolean(publicationData.description),
    duplicateRemoteProduct,
  };
}

function resolvePreviewStatus(input: {
  duplicateLocal: boolean;
  duplicateRemote: boolean;
  sourceCount: number;
  selectedSourceFound: boolean;
  explicitSourceMissing: boolean;
  price: number | null;
}): ShopProductPublicationPreviewStatus {
  if (input.duplicateLocal) return 'DUPLICATE_LOCAL';
  if (input.duplicateRemote) return 'DUPLICATE_REMOTE';
  if (input.sourceCount === 0) return 'NO_WHOLESALE_OFFER';
  if (input.price === null) return 'NEEDS_PRICE';
  if (input.explicitSourceMissing || !input.selectedSourceFound) return 'NEEDS_SOURCE';
  return 'READY';
}

function resolveSelectedSource(sources: WholesaleMappingWithProvider[], sourceId?: string | null) {
  if (sourceId) return sources.find((source) => source.id === sourceId) ?? null;
  if (sources.length === 1) return sources[0];
  return null;
}

function chooseProductEan(barcodes: WarehouseProductBarcode[], source?: WholesaleMappingWithProvider | null) {
  const primary = barcodes.find((barcode) => barcode.isPrimary && barcode.isActive) ?? barcodes.find((barcode) => barcode.isActive);
  return primary?.ean ?? source?.externalEan ?? null;
}

export function extractPublicationData(mapping: WholesaleMappingWithProvider, imageLimit = DEFAULT_IMAGE_LIMIT) {
  const config = parseProviderConfig(mapping.provider.configJson);
  const payload = (mapping.payloadJson || {}) as Record<string, unknown>;
  const description = payloadValue(payload, [
    config.fieldMapping?.description,
    'description',
    'Opis',
  ]);
  const imageValue = payloadValue(payload, [
    config.fieldMapping?.image,
    'photos',
    'photo',
    'image',
    'images',
    'Zdjęcie',
    'Zdjecie',
  ]);

  return {
    description,
    imageUrls: parseImageUrls(imageValue, {
      providerPreset: config.preset,
      imageField: config.fieldMapping?.image,
      limit: imageLimit,
    }),
  };
}

export function parseImageUrls(
  value: string | null | undefined,
  options: { providerPreset?: string; imageField?: string; limit?: number } = {},
) {
  if (!value) return [];
  const shouldSplit = options.providerPreset === 'PARTYDECO' || options.imageField === 'photos';
  const parts = shouldSplit ? value.split(',') : [value];
  const limit = normalizeImageLimit(options.limit);
  const urls = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((url) => url.startsWith('//') ? `https:${url}` : url)
    .filter((url) => /^https?:\/\//i.test(url));

  return Array.from(new Set(urls)).slice(0, limit);
}

function parseProviderConfig(configJson: unknown) {
  const config = (configJson || {}) as {
    preset?: string;
    fieldMapping?: {
      description?: string;
      image?: string;
    };
  };

  return {
    preset: config.preset,
    fieldMapping: config.fieldMapping ?? {},
  };
}

function payloadValue(payload: Record<string, unknown>, keys: Array<string | undefined>) {
  for (const key of keys.filter(Boolean)) {
    const value = payload[key as string];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function buildCreateProductInput(
  shop: Shop,
  product: ProductForPublication,
  preview: ShopProductPublicationPreviewItem,
  categoryId: string,
  description: string | null,
): CreatePrestaShopProductInput {
  const config = parseShopPublicationConfig(shop);
  const defaults = config.prestashopProductDefaults || config.productCreate || {};

  return {
    reference: product.sku,
    name: product.name,
    price: preview.price as number,
    categoryId,
    ean13: preview.ean,
    description,
    active: false,
    languageId: defaults.languageId ?? config.languageId ?? 1,
    idShopDefault: defaults.idShopDefault ?? config.idShopDefault,
    taxRulesGroupId: defaults.taxRulesGroupId ?? config.taxRulesGroupId ?? 1,
  };
}

function parseShopPublicationConfig(shop: Shop): ShopPublicationConfig {
  return (shop.configJson || {}) as ShopPublicationConfig;
}

async function uploadProductImages(client: PrestaShopClient, productId: string, imageUrls: string[]) {
  const warnings: string[] = [];
  for (const imageUrl of imageUrls) {
    try {
      await client.uploadProductImage(productId, imageUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nieznany błąd uploadu zdjęcia';
      warnings.push(`${imageUrl}: ${message}`);
    }
  }
  return warnings;
}

function normalizePreviewItems(input: BulkShopProductPublicationPreviewInput) {
  const items = input.items?.length
    ? input.items
    : (input.productIds ?? []).map((warehouseProductId) => ({ warehouseProductId }));

  return normalizeCreateItems(items);
}

function normalizeCreateItems(items: ShopProductPublicationItemInput[]) {
  const unique = new Map<string, ShopProductPublicationItemInput>();
  for (const item of items ?? []) {
    const warehouseProductId = item.warehouseProductId?.trim();
    if (!warehouseProductId) continue;
    unique.set(warehouseProductId, {
      warehouseProductId,
      price: item.price,
      sourceWholesaleMappingId: item.sourceWholesaleMappingId?.trim() || null,
    });
  }

  const normalized = Array.from(unique.values());
  if (normalized.length === 0) throw new Error('items jest wymagane');
  if (normalized.length > MAX_BULK_ITEMS) throw new Error(`Jedna paczka może zawierać maksymalnie ${MAX_BULK_ITEMS} produktów`);
  return normalized;
}

function summarizePreview(input: {
  shopId: string;
  categoryId: string | null;
  imageLimit: number;
  requested: number;
  items: ShopProductPublicationPreviewItem[];
}): BulkShopProductPublicationPreviewResult {
  return {
    ...input,
    ready: input.items.filter((item) => item.status === 'READY').length,
    needsPrice: input.items.filter((item) => item.status === 'NEEDS_PRICE').length,
    needsSource: input.items.filter((item) => item.status === 'NEEDS_SOURCE').length,
    blocked: input.items.filter((item) => !['READY', 'NEEDS_PRICE', 'NEEDS_SOURCE'].includes(item.status)).length,
  };
}

function normalizeImageLimit(limit?: number | null) {
  if (limit === null || limit === undefined) return DEFAULT_IMAGE_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_IMAGE_LIMIT;
  return Math.max(0, Math.min(MAX_IMAGE_LIMIT, Math.floor(limit)));
}

function normalizePrice(value?: number | string | Prisma.Decimal | null) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Number(number.toFixed(2)) : null;
}

function decimalToNumber(value?: Prisma.Decimal | number | string | null) {
  return normalizePrice(value);
}
