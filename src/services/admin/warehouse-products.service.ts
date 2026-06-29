import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { syncProductPrice } from '../price/price-sync.service';
import {
  getInventoryPublicationDecision,
  resolveInventoryPublishedLeadTime,
  resolvePublishedWarehouseAvailableAt,
  syncStockForProducts,
  type InventoryLeadTimeSource,
} from '../stock/stock-sync.service';
import { resolveCatalogForProduct } from './warehouse-catalogs.service';

export interface CreateProductInput {
  catalogId?: string | null;
  leadTimeGroupId?: string | null;
  sku: string;
  name: string;
  unit?: string;
  description?: string;
  purchasePrice?: number;
  retailPrice?: number;
  reorderPoint?: number | null;
  reorderQuantity?: number | null;
  leadTimeDaysOverride?: number | null;
  isStockTracked?: boolean;
}

export interface UpdateProductInput {
  catalogId?: string | null;
  leadTimeGroupId?: string | null;
  name?: string;
  unit?: string;
  description?: string;
  purchasePrice?: number | null;
  retailPrice?: number | null;
  reorderPoint?: number | null;
  reorderQuantity?: number | null;
  leadTimeDaysOverride?: number | null;
  isActive?: boolean;
  isStockTracked?: boolean;
}

export interface BulkUpdateProductsInput {
  productIds: string[];
  isActive?: boolean;
  isStockTracked?: boolean;
  catalogId?: string | null;
  leadTimeGroupId?: string | null;
  leadTimeDaysOverride?: number | null;
  reorderPoint?: number | null;
  reorderQuantity?: number | null;
}

export interface BulkUpdateProductsResult {
  requested: number;
  updated: number;
  notFound: number;
  failed: number;
  errors: Array<{ productId: string; message: string }>;
}

export interface BulkDeleteProductsInput {
  productIds: string[];
}

export interface BulkDeleteProductsResult {
  requested: number;
  deleted: number;
  notFound: number;
  blockedByDocuments: number;
  failed: number;
  errors: Array<{ productId: string; message: string }>;
}

export interface ProductShippingPreview {
  availabilityPolicy: string;
  localStock: Prisma.Decimal;
  publishedQuantity: Prisma.Decimal;
  publishedLeadTimeDays: number | null;
  leadTimeSource: InventoryLeadTimeSource;
  warehouseAvailableAt: Date | null;
  latestShopSyncs: Array<{
    shopId: string;
    shopName: string;
    status: string | null;
    publishedLeadTimeDays: number | null;
    remoteLeadTimeDays: number | null;
    publishedQuantity: Prisma.Decimal | null;
    remoteQuantity: Prisma.Decimal | null;
    syncedAt: Date | null;
    createdAt: Date | null;
  }>;
}

export interface ProductsQuery {
  page?: number;
  limit?: number;
  search?: string;
  catalogId?: string;
  shopId?: string;
  isActive?: boolean;
  stockStatus?: 'available' | 'zero' | 'negative' | 'low';
  wholesaleStockStatus?: 'available' | 'unavailable' | 'missingOffer';
  missingPrice?: 'purchase' | 'retail';
  stockBelow?: number;
  hasBarcode?: boolean;
  hasShopMapping?: boolean;
  hasWholesaleOffer?: boolean;
  isStockTracked?: boolean;
}

export interface InventorySnapshotQuery {
  page?: number | string;
  limit?: number | string;
  search?: string;
  catalogId?: string;
  includeInactive?: boolean | string;
  includeUntracked?: boolean | string;
}

const MAX_BULK_PRODUCT_IDS = 500;

function productListInclude(shopId?: string) {
  return {
    catalog: true,
    leadTimeGroup: true,
    _count: {
      select: {
        barcodes: { where: { isActive: true } },
        shopProductMappings: { where: { isActive: true } },
        wholesaleMappings: { where: { isActive: true } },
      },
    },
    shopProductMappings: {
      where: {
        isActive: true,
        ...(shopId ? { shopId } : {}),
      },
      include: {
        shop: {
          select: {
            id: true,
            name: true,
            platform: true,
            status: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: shopId ? 10 : 5,
    },
    shopPrices: {
      where: shopId ? { shopId } : undefined,
      include: { shop: { select: { id: true, name: true } } },
      orderBy: { calculatedAt: 'desc' },
      take: shopId ? 10 : 5,
    },
    wholesaleMappings: {
      where: {
        isActive: true,
        provider: { isActive: true },
      },
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            configJson: true,
          },
        },
      },
      orderBy: [{ lastSyncAt: 'desc' }, { updatedAt: 'desc' }],
      take: 10,
    },
  } satisfies Prisma.WarehouseProductInclude;
}

type ProductWithWholesaleMappings = Prisma.WarehouseProductGetPayload<{
  include: ReturnType<typeof productListInclude>;
}>;

type WholesaleMappingForProduct = ProductWithWholesaleMappings['wholesaleMappings'][number];

function requireTenantId() {
  const tenantId = getTenantId();
  const context = getTenantContext();
  if (!tenantId && context?.role !== 'SUPER_ADMIN') throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

type ProductsWhereQuery = Omit<ProductsQuery, 'page' | 'limit'>;

function buildProductsWhere(query: ProductsWhereQuery, tenantId: string | null | undefined) {
  const {
    search,
    catalogId,
    shopId,
    isActive,
    stockStatus,
    wholesaleStockStatus,
    missingPrice,
    stockBelow,
    hasBarcode,
    hasShopMapping,
    hasWholesaleOffer,
    isStockTracked,
  } = query;

  const where: any = {};
  if (tenantId) where.tenantId = tenantId;
  if (catalogId) where.catalogId = catalogId;
  if (isActive !== undefined) where.isActive = isActive;
  if (isStockTracked !== undefined) where.isStockTracked = isStockTracked;
  if (stockStatus === 'available') where.currentStock = { gt: 0 };
  else if (stockStatus === 'zero') where.currentStock = { equals: 0 };
  else if (stockStatus === 'negative') where.currentStock = { lt: 0 };
  else if (stockStatus === 'low') where.currentStock = { lt: stockBelow ?? 1 };
  else if (stockBelow !== undefined) where.currentStock = { lt: stockBelow };
  if (missingPrice === 'purchase') where.purchasePrice = null;
  if (missingPrice === 'retail') where.retailPrice = null;
  if (hasBarcode !== undefined) {
    where.barcodes = hasBarcode
      ? { some: { isActive: true } }
      : { none: { isActive: true } };
  }
  if (hasShopMapping !== undefined) {
    const shopMappingFilter = {
      isActive: true,
      ...(shopId ? { shopId } : {}),
    };
    where.shopProductMappings = hasShopMapping
      ? { some: shopMappingFilter }
      : { none: shopMappingFilter };
  }
  const activeWholesaleMappingFilter = {
    isActive: true,
    provider: { isActive: true },
  };
  const availableWholesaleMappingFilter = {
    ...activeWholesaleMappingFilter,
    lastKnownStock: { gt: 0 },
  };
  if (wholesaleStockStatus === 'available') {
    where.wholesaleMappings = { some: availableWholesaleMappingFilter };
  } else if (wholesaleStockStatus === 'unavailable') {
    where.AND = [
      ...(where.AND ?? []),
      { wholesaleMappings: { some: activeWholesaleMappingFilter } },
      { wholesaleMappings: { none: availableWholesaleMappingFilter } },
    ];
  } else if (wholesaleStockStatus === 'missingOffer') {
    where.wholesaleMappings = { none: activeWholesaleMappingFilter };
  } else if (hasWholesaleOffer !== undefined) {
    where.wholesaleMappings = hasWholesaleOffer
      ? { some: activeWholesaleMappingFilter }
      : { none: activeWholesaleMappingFilter };
  }
  if (search) {
    where.OR = [
      { sku: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { barcodes: { some: { isActive: true, ean: { contains: search, mode: 'insensitive' } } } },
    ];
  }

  return where;
}

function providerConfig(configJson: Prisma.JsonValue | null | undefined) {
  if (!configJson || typeof configJson !== 'object' || Array.isArray(configJson)) return {};
  return configJson as { fieldMapping?: { image?: string } };
}

function payloadValue(payloadJson: Prisma.JsonValue | null | undefined, keys: Array<string | undefined>) {
  if (!payloadJson || typeof payloadJson !== 'object' || Array.isArray(payloadJson)) return null;
  const payload = payloadJson as Record<string, unknown>;
  for (const key of keys.filter(Boolean)) {
    const value = payload[key as string];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function firstImageUrl(value: string | null) {
  if (!value) return null;
  const candidates = value
    .split(/[,\n;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((url) => (url.startsWith('//') ? `https:${url}` : url));
  return candidates.find((candidate) => /^https?:\/\//i.test(candidate)) ?? null;
}

function mappingImageUrl(mapping: WholesaleMappingForProduct) {
  const config = providerConfig(mapping.provider.configJson);
  return firstImageUrl(payloadValue(mapping.payloadJson, [
    config.fieldMapping?.image,
    'photos',
    'photo',
    'image',
    'images',
    'Zdjęcie',
    'Zdjecie',
  ]));
}

function chooseBestWholesaleOffer(mappings: WholesaleMappingForProduct[]) {
  const sorted = [...mappings].sort((a, b) => {
    const priceA = a.lastKnownPrice === null ? Number.POSITIVE_INFINITY : Number(a.lastKnownPrice);
    const priceB = b.lastKnownPrice === null ? Number.POSITIVE_INFINITY : Number(b.lastKnownPrice);
    if (priceA !== priceB) return priceA - priceB;
    return (b.lastSyncAt?.getTime() ?? 0) - (a.lastSyncAt?.getTime() ?? 0);
  });
  const mapping = sorted.find((item) => item.lastKnownPrice !== null || mappingImageUrl(item)) ?? sorted[0] ?? null;
  if (!mapping) return null;

  return {
    mappingId: mapping.id,
    providerId: mapping.providerId,
    providerName: mapping.provider.name,
    externalSku: mapping.externalSku,
    externalEan: mapping.externalEan,
    externalName: mapping.externalName,
    lastKnownPrice: mapping.lastKnownPrice === null ? null : Number(mapping.lastKnownPrice),
    lastKnownStock: mapping.lastKnownStock === null ? null : Number(mapping.lastKnownStock),
    imageUrl: mappingImageUrl(mapping),
  };
}

function withBestWholesaleOffer<T extends ProductWithWholesaleMappings>(product: T) {
  const { wholesaleMappings, ...rest } = product;
  return {
    ...rest,
    wholesaleMappings,
    bestWholesaleOffer: chooseBestWholesaleOffer(wholesaleMappings),
  };
}

export async function getProducts(query: ProductsQuery = {}) {
  const tenantId = requireTenantId();
  const { page = 1, limit = 50, shopId } = query;
  const skip = (page - 1) * limit;

  const where = buildProductsWhere(query, tenantId);

  const [data, total] = await Promise.all([
    prisma.warehouseProduct.findMany({
      where,
      skip,
      take: limit,
      orderBy: { name: 'asc' },
      include: productListInclude(shopId),
    }),
    prisma.warehouseProduct.count({ where }),
  ]);

  return { data: data.map(withBestWholesaleOffer), total, page, limit, totalPages: Math.ceil(total / limit) };
}

export interface ProductViewCountsQuery {
  search?: string;
  catalogId?: string;
  shopId?: string;
}

const PRODUCT_VIEW_QUERIES = {
  all: { isStockTracked: true },
  active: { isActive: true, isStockTracked: true },
  lowStock: { isActive: true, isStockTracked: true, stockStatus: 'low', stockBelow: 1 },
  withoutEan: { isActive: true, isStockTracked: true, hasBarcode: false },
  withoutMapping: { isActive: true, isStockTracked: true, hasShopMapping: false },
  withoutWholesaleOffer: { isActive: true, isStockTracked: true, hasWholesaleOffer: false },
  wholesaleUnavailable: { isActive: true, isStockTracked: true, wholesaleStockStatus: 'unavailable' },
  withoutPrice: { isActive: true, isStockTracked: true, missingPrice: 'retail' },
  stockUntracked: { isStockTracked: false },
} satisfies Record<string, ProductsWhereQuery>;

export type ProductViewCounts = Record<keyof typeof PRODUCT_VIEW_QUERIES, number>;

export async function getProductViewCounts(query: ProductViewCountsQuery = {}): Promise<ProductViewCounts> {
  const tenantId = requireTenantId();
  const viewIds = Object.keys(PRODUCT_VIEW_QUERIES) as Array<keyof typeof PRODUCT_VIEW_QUERIES>;

  const counts = await prisma.$transaction(
    viewIds.map((viewId) => prisma.warehouseProduct.count({
      where: buildProductsWhere({ ...PRODUCT_VIEW_QUERIES[viewId], ...query }, tenantId),
    })),
  );

  return Object.fromEntries(viewIds.map((viewId, index) => [viewId, counts[index]])) as ProductViewCounts;
}

export async function getProductById(id: string) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const product = await prisma.warehouseProduct.findFirst({
    where,
    include: productListInclude(),
  });
  if (!product) return null;

  const shippingPreview = await getProductShippingPreview(product.id, tenantId);
  return {
    ...withBestWholesaleOffer(product),
    shippingPreview,
  };
}

async function getProductShippingPreview(productId: string, tenantId: string | null): Promise<ProductShippingPreview> {
  const [decision, activeShopMappings, latestLogs] = await Promise.all([
    getInventoryPublicationDecision(productId),
    prisma.shopProductMapping.findMany({
      where: {
        warehouseProductId: productId,
        isActive: true,
        ...(tenantId ? { tenantId } : {}),
        shop: { status: 'ACTIVE', platform: 'PRESTASHOP' },
      },
      include: {
        shop: { select: { id: true, name: true, configJson: true } },
      },
      orderBy: { updatedAt: 'desc' },
    }),
    prisma.stockSyncLog.findMany({
      where: {
        warehouseProductId: productId,
        ...(tenantId ? { tenantId } : {}),
      },
      include: {
        shop: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  const primaryShopConfig = activeShopMappings[0]?.shop.configJson;
  const publishedLeadTime = resolveInventoryPublishedLeadTime(decision, primaryShopConfig);
  const publishedWarehouseAvailableAt = resolvePublishedWarehouseAvailableAt(decision, publishedLeadTime.leadTimeDays);
  const latestLogByShopId = new Map<string, typeof latestLogs[number]>();
  for (const log of latestLogs) {
    if (!latestLogByShopId.has(log.shopId)) latestLogByShopId.set(log.shopId, log);
  }

  const latestShopSyncs = activeShopMappings.length > 0
    ? activeShopMappings.map((mapping) => {
        const log = latestLogByShopId.get(mapping.shopId);
        return {
          shopId: mapping.shopId,
          shopName: mapping.shop.name,
          status: log?.status ?? null,
          publishedLeadTimeDays: log?.publishedLeadTimeDays ?? null,
          remoteLeadTimeDays: log?.remoteLeadTimeDays ?? null,
          publishedQuantity: log?.publishedQuantity ?? null,
          remoteQuantity: log?.remoteQuantity ?? null,
          syncedAt: log?.syncedAt ?? null,
          createdAt: log?.createdAt ?? null,
        };
      })
    : Array.from(latestLogByShopId.values()).map((log) => ({
        shopId: log.shopId,
        shopName: log.shop.name,
        status: log.status,
        publishedLeadTimeDays: log.publishedLeadTimeDays ?? null,
        remoteLeadTimeDays: log.remoteLeadTimeDays ?? null,
        publishedQuantity: log.publishedQuantity ?? null,
        remoteQuantity: log.remoteQuantity ?? null,
        syncedAt: log.syncedAt ?? null,
        createdAt: log.createdAt ?? null,
      }));

  return {
    availabilityPolicy: decision.availabilityPolicy,
    localStock: decision.stockAfter,
    publishedQuantity: decision.publishedQuantity,
    publishedLeadTimeDays: publishedLeadTime.leadTimeDays,
    leadTimeSource: publishedLeadTime.source,
    warehouseAvailableAt: publishedWarehouseAvailableAt,
    latestShopSyncs,
  };
}

export async function getInventorySnapshot(productId: string) {
  const tenantId = getTenantId();
  const where: any = { id: productId };
  if (tenantId) where.tenantId = tenantId;

  const product = await prisma.warehouseProduct.findFirst({
    where,
    select: { id: true, sku: true, name: true, unit: true, currentStock: true, tenantId: true, isStockTracked: true },
  });
  if (!product) return null;

  const activeReservations = await prisma.warehouseReservation.findMany({
    where: {
      tenantId: product.tenantId,
      warehouseProductId: product.id,
      status: 'ACTIVE',
      source: 'LOCAL_STOCK',
    },
    orderBy: { createdAt: 'asc' },
    include: {
      order: { select: { id: true, orderReference: true, externalOrderId: true } },
      orderItem: { select: { id: true, productNameSnapshot: true } },
    },
  });

  const totalReserved = activeReservations.reduce(
    (sum, reservation) => sum.plus(reservation.quantity),
    new Prisma.Decimal(0),
  );

  const currentStock = new Prisma.Decimal(product.currentStock);
  const availableStock = currentStock;
  const physicalStock = currentStock.plus(totalReserved);

  return {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.unit,
    isStockTracked: product.isStockTracked,
    currentStock: Number(currentStock),
    physicalStock: Number(physicalStock),
    totalReserved: Number(totalReserved),
    availableStock: Number(availableStock),
    activeReservations: activeReservations.map((reservation) => ({
      id: reservation.id,
      orderId: reservation.orderId,
      orderReference: reservation.order.orderReference,
      externalOrderId: reservation.order.externalOrderId,
      orderItemId: reservation.orderItemId,
      orderItemName: reservation.orderItem?.productNameSnapshot ?? null,
      quantity: Number(reservation.quantity),
      createdAt: reservation.createdAt,
    })),
  };
}

function normalizeBoolean(value: boolean | string | undefined) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function normalizePositiveInteger(value: number | string | undefined, fallback: number, max?: number) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return max ? Math.min(number, max) : number;
}

export async function getInventorySnapshotList(query: InventorySnapshotQuery = {}) {
  const tenantId = requireTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');

  const includeInactive = normalizeBoolean(query.includeInactive) === true;
  const includeUntracked = normalizeBoolean(query.includeUntracked) === true;
  const page = normalizePositiveInteger(query.page, 1);
  const limit = normalizePositiveInteger(query.limit, 100, 200);
  const skip = (page - 1) * limit;
  const search = query.search?.trim();
  const where: Prisma.WarehouseProductWhereInput = {
    tenantId,
    ...(includeInactive ? {} : { isActive: true }),
    ...(includeUntracked ? {} : { isStockTracked: true }),
    ...(query.catalogId ? { catalogId: query.catalogId } : {}),
    ...(search
      ? {
          OR: [
            { sku: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { barcodes: { some: { isActive: true, ean: { contains: search, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };

  const [products, total, stockAggregate, matchingProductIds] = await Promise.all([
    prisma.warehouseProduct.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ sku: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        sku: true,
        name: true,
        unit: true,
        catalogId: true,
        currentStock: true,
        isActive: true,
        isStockTracked: true,
        catalog: { select: { id: true, name: true, code: true } },
      },
    }),
    prisma.warehouseProduct.count({ where }),
    prisma.warehouseProduct.aggregate({
      where,
      _sum: { currentStock: true },
    }),
    prisma.warehouseProduct.findMany({
      where,
      select: { id: true },
    }),
  ]);

  const productIds = products.map((product) => product.id);
  const allProductIds = matchingProductIds.map((product) => product.id);
  const [reservations, allReservations] = await Promise.all([
    productIds.length === 0
      ? []
      : prisma.warehouseReservation.groupBy({
          by: ['warehouseProductId'],
          where: {
            tenantId,
            warehouseProductId: { in: productIds },
            status: 'ACTIVE',
            source: 'LOCAL_STOCK',
          },
          _sum: { quantity: true },
          _count: { _all: true },
        }),
    allProductIds.length === 0
      ? []
      : prisma.warehouseReservation.groupBy({
          by: ['warehouseProductId'],
          where: {
            tenantId,
            warehouseProductId: { in: allProductIds },
            status: 'ACTIVE',
            source: 'LOCAL_STOCK',
          },
          _sum: { quantity: true },
          _count: { _all: true },
        }),
  ]);

  const reservedByProductId = new Map(reservations.map((row) => [
    row.warehouseProductId,
    {
      quantity: new Prisma.Decimal(row._sum.quantity ?? 0),
      count: row._count._all,
    },
  ]));

  const data = products.map((product) => {
    const availableStock = new Prisma.Decimal(product.currentStock);
    const reservation = reservedByProductId.get(product.id);
    const reservedQuantity = reservation?.quantity ?? new Prisma.Decimal(0);
    const physicalStock = availableStock.plus(reservedQuantity);

    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      unit: product.unit,
      catalogId: product.catalogId,
      catalog: product.catalog,
      isActive: product.isActive,
      isStockTracked: product.isStockTracked,
      currentStock: Number(availableStock),
      availableStock: Number(availableStock),
      physicalStock: Number(physicalStock),
      totalReserved: Number(reservedQuantity),
      activeReservationsCount: reservation?.count ?? 0,
    };
  });

  const totalAvailableStock = new Prisma.Decimal(stockAggregate._sum.currentStock ?? 0);
  const totalReserved = allReservations.reduce(
    (sum, row) => sum.plus(row._sum.quantity ?? 0),
    new Prisma.Decimal(0),
  );
  const totalPhysicalStock = totalAvailableStock.plus(totalReserved);

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    summary: {
      totalPhysicalStock: Number(totalPhysicalStock),
      totalAvailableStock: Number(totalAvailableStock),
      totalReserved: Number(totalReserved),
      productsWithReservations: allReservations.length,
    },
  };
}

export async function createProduct(input: CreateProductInput) {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');

  const existing = await prisma.warehouseProduct.findUnique({
    where: { tenantId_sku: { tenantId, sku: input.sku } },
  });
  if (existing) throw new Error(`Produkt z SKU "${input.sku}" już istnieje`);

  const catalog = await resolveCatalogForProduct(tenantId, input.catalogId);
  const leadTimeGroup = input.leadTimeGroupId === undefined
    ? null
    : await resolveLeadTimeGroupForProduct(tenantId, input.leadTimeGroupId);

  return prisma.warehouseProduct.create({
    data: {
      tenantId,
      catalogId: catalog.id,
      leadTimeGroupId: leadTimeGroup?.id ?? null,
      sku: input.sku,
      name: input.name,
      unit: input.unit ?? 'szt',
      description: input.description,
      purchasePrice: input.purchasePrice,
      retailPrice: input.retailPrice,
      reorderPoint: normalizeOptionalQuantity(input.reorderPoint, 'Minimalny stan'),
      reorderQuantity: normalizeOptionalPositiveQuantity(input.reorderQuantity, 'Partia zamawiania'),
      leadTimeDaysOverride: normalizeOptionalLeadTimeDays(input.leadTimeDaysOverride),
      isStockTracked: input.isStockTracked ?? true,
    },
  });
}

export async function updateProduct(id: string, input: UpdateProductInput) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const product = await prisma.warehouseProduct.findFirst({ where });
  if (!product) throw new Error('Produkt nie znaleziony');
  const shouldSyncPrice = input.retailPrice !== undefined
    && input.retailPrice !== null
    && !pricesEqual(product.retailPrice, input.retailPrice);
  const shouldSyncLeadTime = (input.leadTimeDaysOverride !== undefined && input.leadTimeDaysOverride !== product.leadTimeDaysOverride) ||
    (input.leadTimeGroupId !== undefined && input.leadTimeGroupId !== product.leadTimeGroupId);

  const data: Prisma.WarehouseProductUpdateInput = { ...input };
  delete (data as any).catalogId;
  delete (data as any).leadTimeGroupId;
  delete (data as any).leadTimeDaysOverride;

  if (input.catalogId !== undefined) {
    const catalog = await resolveCatalogForProduct(product.tenantId, input.catalogId);
    data.catalog = { connect: { id: catalog.id } };
  }
  if (input.leadTimeGroupId !== undefined) {
    const leadTimeGroup = await resolveLeadTimeGroupForProduct(product.tenantId, input.leadTimeGroupId);
    data.leadTimeGroup = leadTimeGroup ? { connect: { id: leadTimeGroup.id } } : { disconnect: true };
  }
  if (input.leadTimeDaysOverride !== undefined) {
    data.leadTimeDaysOverride = normalizeOptionalLeadTimeDays(input.leadTimeDaysOverride);
  }
  if (input.reorderPoint !== undefined) {
    data.reorderPoint = normalizeOptionalQuantity(input.reorderPoint, 'Minimalny stan');
  }
  if (input.reorderQuantity !== undefined) {
    data.reorderQuantity = normalizeOptionalPositiveQuantity(input.reorderQuantity, 'Partia zamawiania');
  }

  const updatedProduct = await prisma.warehouseProduct.update({
    where: { id },
    data,
    include: { catalog: true, leadTimeGroup: true },
  });

  if (shouldSyncPrice && tenantId) {
    syncProductPrice(id, { triggeredBy: 'PRODUCT_PRICE_UPDATE' }).catch((error) => {
      console.error('[Warehouse] Failed to enqueue automatic price sync:', error);
    });
  }
  if (shouldSyncLeadTime && tenantId) {
    syncStockForProducts([id], 'LEAD_TIME_UPDATE').catch((error) => {
      console.error('[Warehouse] Failed to enqueue automatic lead time sync:', error);
    });
  }

  return updatedProduct;
}

export async function deleteProduct(id: string) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const product = await prisma.warehouseProduct.findFirst({ where });
  if (!product) throw new Error('Produkt nie znaleziony');

  const itemCount = await prisma.warehouseDocumentItem.count({ where: { productId: id } });
  if (itemCount > 0) throw new Error('Nie można usunąć produktu — posiada powiązane pozycje dokumentów');

  return prisma.warehouseProduct.delete({ where: { id } });
}

export async function bulkUpdateProducts(input: BulkUpdateProductsInput): Promise<BulkUpdateProductsResult> {
  const tenantId = requireTenantId();
  const productIds = normalizeBulkProductIds(input.productIds);

  if (
    input.isActive === undefined &&
    input.isStockTracked === undefined &&
    input.catalogId === undefined &&
    input.leadTimeGroupId === undefined &&
    input.leadTimeDaysOverride === undefined &&
    input.reorderPoint === undefined &&
    input.reorderQuantity === undefined
  ) {
    throw new Error('Podaj przynajmniej jedną zmianę masową');
  }

  const where: Prisma.WarehouseProductWhereInput = { id: { in: productIds } };
  if (tenantId) where.tenantId = tenantId;

  const products = await prisma.warehouseProduct.findMany({
    where,
    select: { id: true, tenantId: true },
  });
  const foundIds = products.map((product) => product.id);
  const foundIdSet = new Set(foundIds);
  const errors = productIds
    .filter((productId) => !foundIdSet.has(productId))
    .map((productId) => ({ productId, message: 'Produkt nie znaleziony' }));

  if (foundIds.length === 0) {
    return {
      requested: productIds.length,
      updated: 0,
      notFound: errors.length,
      failed: 0,
      errors,
    };
  }

  const data: Prisma.WarehouseProductUncheckedUpdateManyInput = {};
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.isStockTracked !== undefined) data.isStockTracked = input.isStockTracked;
  if (input.catalogId !== undefined) {
    const productTenantIds = Array.from(new Set(products.map((product) => product.tenantId)));
    if (!tenantId && productTenantIds.length !== 1) {
      throw new Error('Masowa zmiana katalogu wymaga produktów z jednego tenanta');
    }

    const catalog = await resolveCatalogForProduct(tenantId ?? productTenantIds[0], input.catalogId);
    data.catalogId = catalog.id;
  }
  if (input.leadTimeGroupId !== undefined) {
    const productTenantIds = Array.from(new Set(products.map((product) => product.tenantId)));
    if (!tenantId && productTenantIds.length !== 1) {
      throw new Error('Masowa zmiana grupy czasu wysyłki wymaga produktów z jednego tenanta');
    }
    const leadTimeGroup = await resolveLeadTimeGroupForProduct(tenantId ?? productTenantIds[0], input.leadTimeGroupId);
    data.leadTimeGroupId = leadTimeGroup?.id ?? null;
  }
  if (input.leadTimeDaysOverride !== undefined) {
    data.leadTimeDaysOverride = normalizeOptionalLeadTimeDays(input.leadTimeDaysOverride);
  }
  if (input.reorderPoint !== undefined) {
    data.reorderPoint = normalizeOptionalQuantity(input.reorderPoint, 'Minimalny stan');
  }
  if (input.reorderQuantity !== undefined) {
    data.reorderQuantity = normalizeOptionalPositiveQuantity(input.reorderQuantity, 'Partia zamawiania');
  }

  const result = await prisma.warehouseProduct.updateMany({
    where: {
      id: { in: foundIds },
      ...(tenantId ? { tenantId } : {}),
    },
    data,
  });

  const failed = Math.max(0, foundIds.length - result.count);
  if (failed > 0) {
    errors.push({
      productId: '*',
      message: `Nie udało się zaktualizować ${failed} produktów`,
    });
  }

  const shouldSyncLeadTime = input.leadTimeGroupId !== undefined || input.leadTimeDaysOverride !== undefined;
  if (shouldSyncLeadTime && foundIds.length > 0) {
    syncStockForProducts(foundIds, 'LEAD_TIME_UPDATE').catch((error) => {
      console.error('[Warehouse] Failed to enqueue bulk lead time sync:', error);
    });
  }

  return {
    requested: productIds.length,
    updated: result.count,
    notFound: productIds.length - products.length,
    failed,
    errors,
  };
}

async function resolveLeadTimeGroupForProduct(tenantId: string, leadTimeGroupId?: string | null) {
  if (!leadTimeGroupId) return null;
  const group = await prisma.warehouseLeadTimeGroup.findFirst({
    where: { id: leadTimeGroupId, tenantId, isActive: true },
    select: { id: true },
  });
  if (!group) throw new Error('Aktywna grupa czasu wysyłki nie znaleziona');
  return group;
}

function normalizeOptionalLeadTimeDays(value: number | null | undefined) {
  if (value === undefined || value === null) return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new Error('Czas wysyłki musi być liczbą całkowitą od 0 do 365 dni');
  }
  return days;
}

function normalizeOptionalQuantity(value: number | null | undefined, label: string) {
  if (value === undefined || value === null) return null;
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error(`${label} musi być liczbą nieujemną`);
  }
  return new Prisma.Decimal(Math.round(quantity * 1000) / 1000);
}

function normalizeOptionalPositiveQuantity(value: number | null | undefined, label: string) {
  if (value === undefined || value === null) return null;
  const quantity = Number(value);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`${label} musi być liczbą większą od 0`);
  }
  return new Prisma.Decimal(Math.round(quantity * 1000) / 1000);
}

export async function bulkDeleteProducts(input: BulkDeleteProductsInput): Promise<BulkDeleteProductsResult> {
  const tenantId = requireTenantId();
  const productIds = normalizeBulkProductIds(input.productIds);

  const where: Prisma.WarehouseProductWhereInput = { id: { in: productIds } };
  if (tenantId) where.tenantId = tenantId;

  const products = await prisma.warehouseProduct.findMany({
    where,
    select: { id: true },
  });
  const foundIds = products.map((product) => product.id);
  const foundIdSet = new Set(foundIds);
  const errors = productIds
    .filter((productId) => !foundIdSet.has(productId))
    .map((productId) => ({ productId, message: 'Produkt nie znaleziony' }));

  if (foundIds.length === 0) {
    return {
      requested: productIds.length,
      deleted: 0,
      notFound: errors.length,
      blockedByDocuments: 0,
      failed: 0,
      errors,
    };
  }

  const blockedItems = await prisma.warehouseDocumentItem.findMany({
    where: { productId: { in: foundIds } },
    distinct: ['productId'],
    select: { productId: true },
  });
  const blockedIds = new Set(blockedItems.map((item) => item.productId));
  for (const productId of blockedIds) {
    errors.push({
      productId,
      message: 'Nie można usunąć produktu — posiada powiązane pozycje dokumentów',
    });
  }

  const deletableIds = foundIds.filter((productId) => !blockedIds.has(productId));
  let deleted = 0;
  let failed = 0;

  if (deletableIds.length > 0) {
    try {
      const result = await prisma.warehouseProduct.deleteMany({
        where: {
          id: { in: deletableIds },
          ...(tenantId ? { tenantId } : {}),
        },
      });
      deleted = result.count;

      if (deleted !== deletableIds.length) {
        const remainingProducts = await prisma.warehouseProduct.findMany({
          where: { id: { in: deletableIds }, ...(tenantId ? { tenantId } : {}) },
          select: { id: true },
        });
        failed = remainingProducts.length;
        for (const product of remainingProducts) {
          errors.push({ productId: product.id, message: 'Nie udało się usunąć produktu' });
        }
      }
    } catch (error) {
      failed = deletableIds.length;
      const message = error instanceof Error ? error.message : 'Nie udało się usunąć produktu';
      for (const productId of deletableIds) {
        errors.push({ productId, message });
      }
    }
  }

  return {
    requested: productIds.length,
    deleted,
    notFound: productIds.length - products.length,
    blockedByDocuments: blockedIds.size,
    failed,
    errors,
  };
}

function normalizeBulkProductIds(productIds: string[]) {
  const ids = Array.from(new Set((productIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (ids.length === 0) throw new Error('Lista produktów jest wymagana');
  if (ids.length > MAX_BULK_PRODUCT_IDS) {
    throw new Error(`Operacja masowa może obejmować maksymalnie ${MAX_BULK_PRODUCT_IDS} produktów`);
  }
  return ids;
}

function pricesEqual(currentPrice: Prisma.Decimal | null, nextPrice: number) {
  if (currentPrice === null) return false;
  return Math.abs(Number(currentPrice) - nextPrice) < 0.005;
}
