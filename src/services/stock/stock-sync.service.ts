import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { addStockSyncBatchJobs, type StockSyncBatchItem, type StockSyncTriggeredBy } from '../queue/stock-sync.queue';

export type InventoryAvailabilityPolicy = 'IN_STOCK' | 'BACKORDER_FROM_WHOLESALE' | 'OUT_OF_STOCK';
export type PrestaShopOutOfStockBehavior = 0 | 1;

export interface InventoryPublicationDecision {
  stockAfter: Prisma.Decimal;
  publishedQuantity: Prisma.Decimal;
  leadTimeDays?: number | null;
  warehouseAvailableAt?: Date | null;
  availabilityPolicy: InventoryAvailabilityPolicy;
  outOfStockBehavior: PrestaShopOutOfStockBehavior;
  warningMessage?: string;
  wholesaleMappingId?: string;
  wholesaleProviderName?: string;
}

export interface PublishInventoryOptions {
  tenantId?: string;
  shopId?: string;
  warehouseProductIds?: string[];
  triggeredBy: StockSyncTriggeredBy;
  documentId?: string;
  warningMessage?: string;
}

type ProductForPublication = {
  id: string;
  tenantId: string;
  currentStock: Prisma.Decimal;
  leadTimeDaysOverride?: number | null;
  leadTimeGroup?: { leadTimeDays: number; isActive: boolean } | null;
};

const ZERO = new Prisma.Decimal(0);

export async function getInventoryPublicationDecision(
  warehouseProductId: string,
  options: { warningMessage?: string } = {},
): Promise<InventoryPublicationDecision> {
  const product = await prisma.warehouseProduct.findUnique({
    where: { id: warehouseProductId },
    select: {
      id: true,
      tenantId: true,
      currentStock: true,
      leadTimeDaysOverride: true,
      leadTimeGroup: { select: { leadTimeDays: true, isActive: true } },
    },
  });
  if (!product) throw new Error(`Produkt magazynowy nie znaleziony: ${warehouseProductId}`);

  const decisions = await getInventoryPublicationDecisions([product], options);
  return decisions.get(product.id) as InventoryPublicationDecision;
}

export async function getInventoryPublicationDecisions(
  products: ProductForPublication[],
  options: { warningMessage?: string } = {},
): Promise<Map<string, InventoryPublicationDecision>> {
  const productIdsWithoutOwnStock = products
    .filter((product) => product.currentStock.lte(0))
    .map((product) => product.id);

  const wholesaleMappings = productIdsWithoutOwnStock.length === 0
    ? []
    : await prisma.wholesaleProductMapping.findMany({
        where: {
          warehouseProductId: { in: productIdsWithoutOwnStock },
          isActive: true,
          lastKnownStock: { gt: ZERO },
          provider: { isActive: true },
        },
        orderBy: [
          { lastKnownPrice: 'asc' },
          { lastSyncAt: 'desc' },
        ],
        include: { provider: { select: { name: true, leadTimeDays: true } } },
      });

  const wholesaleByProductId = new Map<string, typeof wholesaleMappings[number]>();
  for (const mapping of wholesaleMappings) {
    if (!mapping.warehouseProductId || wholesaleByProductId.has(mapping.warehouseProductId)) continue;
    wholesaleByProductId.set(mapping.warehouseProductId, mapping);
  }

  const decisions = new Map<string, InventoryPublicationDecision>();
  for (const product of products) {
    const hasOwnStock = product.currentStock.gt(0);
    const wholesale = wholesaleByProductId.get(product.id);
    const productLeadTimeDays = resolveProductLeadTimeDays(product);

    if (hasOwnStock) {
      decisions.set(product.id, {
        stockAfter: product.currentStock,
        publishedQuantity: product.currentStock,
        leadTimeDays: productLeadTimeDays,
        availabilityPolicy: 'IN_STOCK',
        outOfStockBehavior: 0,
        warningMessage: options.warningMessage,
      });
      continue;
    }

    if (wholesale) {
      decisions.set(product.id, {
        stockAfter: product.currentStock,
        publishedQuantity: ZERO,
        leadTimeDays: productLeadTimeDays ?? normalizeOptionalLeadTimeDays(wholesale.provider.leadTimeDays),
        warehouseAvailableAt: wholesale.warehouseAvailableAt,
        availabilityPolicy: 'BACKORDER_FROM_WHOLESALE',
        outOfStockBehavior: 1,
        warningMessage: options.warningMessage,
        wholesaleMappingId: wholesale.id,
        wholesaleProviderName: wholesale.provider.name,
      });
      continue;
    }

    decisions.set(product.id, {
      stockAfter: product.currentStock,
      publishedQuantity: ZERO,
      leadTimeDays: null,
      availabilityPolicy: 'OUT_OF_STOCK',
      outOfStockBehavior: 0,
      warningMessage: options.warningMessage,
    });
  }

  return decisions;
}

export async function publishInventoryToShops(options: PublishInventoryOptions) {
  const productIds = normalizeProductIds(options.warehouseProductIds);

  const where: Prisma.ShopProductMappingWhereInput = {
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    ...(options.shopId ? { shopId: options.shopId } : {}),
    isActive: true,
    warehouseProductId: productIds.length > 0 ? { in: productIds } : { not: null },
    shop: { status: 'ACTIVE', platform: 'PRESTASHOP' },
  };

  const mappings = await prisma.shopProductMapping.findMany({
    where,
    orderBy: [{ shopId: 'asc' }, { externalSku: 'asc' }],
    include: {
      shop: true,
      warehouseProduct: {
        select: {
          id: true,
          tenantId: true,
          currentStock: true,
          leadTimeDaysOverride: true,
          leadTimeGroup: { select: { leadTimeDays: true, isActive: true } },
          isActive: true,
        },
      },
    },
  });

  const productsById = new Map<string, ProductForPublication>();
  let skippedInactiveProducts = 0;
  let skippedMissingProducts = 0;

  for (const mapping of mappings) {
    if (!mapping.warehouseProduct) {
      skippedMissingProducts++;
      continue;
    }
    if (!mapping.warehouseProduct.isActive) {
      skippedInactiveProducts++;
      continue;
    }
    productsById.set(mapping.warehouseProduct.id, mapping.warehouseProduct);
  }

  const decisions = await getInventoryPublicationDecisions(
    Array.from(productsById.values()),
    { warningMessage: options.warningMessage },
  );

  let enqueued = 0;
  let batchJobs = 0;
  const logs = [];
  const batchItemsByShop = new Map<string, {
    tenantId: string;
    shopId: string;
    triggeredBy: StockSyncTriggeredBy;
    documentId?: string;
    items: StockSyncBatchItem[];
  }>();

  for (const mapping of mappings) {
    const product = mapping.warehouseProduct;
    if (!product?.isActive) continue;

    const decision = decisions.get(product.id);
    if (!decision) continue;
    const publishedLeadTimeDays = resolvePublishedLeadTimeDays(decision, mapping.shop.configJson);

    const log = await prisma.stockSyncLog.create({
      data: {
        tenantId: product.tenantId,
        warehouseProductId: product.id,
        shopId: mapping.shopId,
        triggeredBy: options.triggeredBy,
        documentId: options.documentId,
        stockBefore: null,
        stockAfter: decision.stockAfter,
        publishedQuantity: decision.publishedQuantity,
        publishedLeadTimeDays,
        publishedWarehouseAvailableAt: decision.warehouseAvailableAt ?? null,
        availabilityPolicy: decision.availabilityPolicy,
        outOfStockBehavior: decision.outOfStockBehavior,
        warningMessage: decision.warningMessage,
        status: 'PENDING',
      },
    });

    const batch = batchItemsByShop.get(mapping.shopId) ?? {
      tenantId: product.tenantId,
      shopId: mapping.shopId,
      triggeredBy: options.triggeredBy,
      documentId: options.documentId,
      items: [],
    };
    batch.items.push({
      logId: log.id,
      warehouseProductId: product.id,
      externalProductId: mapping.externalProductId,
      quantity: Math.max(0, Math.floor(Number(decision.publishedQuantity))),
      leadTimeDays: publishedLeadTimeDays,
      warehouseAvailableAt: formatWarehouseAvailableAt(decision.warehouseAvailableAt),
      outOfStockBehavior: decision.outOfStockBehavior,
      availabilityPolicy: decision.availabilityPolicy,
    });
    batchItemsByShop.set(mapping.shopId, batch);

    logs.push(log);
    enqueued += 1;
  }

  for (const batch of batchItemsByShop.values()) {
    const jobs = await addStockSyncBatchJobs(batch);
    batchJobs += jobs.length;
  }

  return {
    enqueued,
    batchJobs,
    logs,
    scannedMappings: mappings.length,
    affectedProducts: productsById.size,
    skippedInactiveProducts,
    skippedMissingProducts,
  };
}

export async function syncStockToAllShops(
  warehouseProductId: string,
  triggeredBy: StockSyncTriggeredBy,
  documentId?: string,
) {
  const tenantId = getTenantId();
  const product = await prisma.warehouseProduct.findFirst({
    where: { id: warehouseProductId, ...(tenantId ? { tenantId } : {}) },
    select: { id: true, tenantId: true },
  });
  if (!product) throw new Error(`Produkt magazynowy nie znaleziony: ${warehouseProductId}`);

  return publishInventoryToShops({
    tenantId: product.tenantId,
    warehouseProductIds: [product.id],
    triggeredBy,
    documentId,
  });
}

export async function syncStockForProducts(
  warehouseProductIds: string[],
  triggeredBy: StockSyncTriggeredBy,
  documentId?: string,
) {
  const productIds = normalizeProductIds(warehouseProductIds);
  if (productIds.length === 0) return { enqueued: 0, batchJobs: 0, logs: [] };

  return publishInventoryToShops({
    tenantId: getTenantId() ?? undefined,
    warehouseProductIds: productIds,
    triggeredBy,
    documentId,
  });
}

export async function syncStockForShop(
  shopId: string,
  triggeredBy: StockSyncTriggeredBy = 'MANUAL',
  options: { warningMessage?: string } = {},
) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, tenantId: true, status: true, platform: true },
  });
  if (!shop) throw new Error('Sklep nie znaleziony');
  if (shop.status !== 'ACTIVE') throw new Error('Sklep jest nieaktywny');
  if (shop.platform !== 'PRESTASHOP') throw new Error(`Stock sync nie obsługuje jeszcze platformy ${shop.platform}`);

  return publishInventoryToShops({
    tenantId: shop.tenantId,
    shopId: shop.id,
    triggeredBy,
    warningMessage: options.warningMessage,
  });
}

function normalizeProductIds(productIds?: string[]) {
  return Array.from(new Set((productIds ?? []).map((id) => id.trim()).filter(Boolean)));
}

function resolveProductLeadTimeDays(product: ProductForPublication) {
  const override = normalizeOptionalLeadTimeDays(product.leadTimeDaysOverride);
  if (override !== null) return override;

  if (product.leadTimeGroup?.isActive) {
    return normalizeOptionalLeadTimeDays(product.leadTimeGroup.leadTimeDays);
  }

  return null;
}

function resolvePublishedLeadTimeDays(decision: InventoryPublicationDecision, shopConfigJson: unknown) {
  if (decision.availabilityPolicy === 'OUT_OF_STOCK') return null;
  return normalizeOptionalLeadTimeDays(decision.leadTimeDays) ??
    getShopDefaultLeadTimeDays(shopConfigJson) ??
    0;
}

function formatWarehouseAvailableAt(value?: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function getShopDefaultLeadTimeDays(configJson: unknown) {
  if (!configJson || typeof configJson !== 'object' || Array.isArray(configJson)) return null;
  return normalizeOptionalLeadTimeDays((configJson as Record<string, unknown>).defaultLeadTimeDays);
}

function normalizeOptionalLeadTimeDays(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) return null;
  return days;
}
