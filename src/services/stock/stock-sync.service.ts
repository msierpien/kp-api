import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { addStockSyncJob, type StockSyncTriggeredBy } from '../queue/stock-sync.queue';

export type InventoryAvailabilityPolicy = 'IN_STOCK' | 'BACKORDER_FROM_WHOLESALE' | 'OUT_OF_STOCK';
export type PrestaShopOutOfStockBehavior = 0 | 1;

export interface InventoryPublicationDecision {
  stockAfter: Prisma.Decimal;
  publishedQuantity: Prisma.Decimal;
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
};

const ZERO = new Prisma.Decimal(0);

export async function getInventoryPublicationDecision(
  warehouseProductId: string,
  options: { warningMessage?: string } = {},
): Promise<InventoryPublicationDecision> {
  const product = await prisma.warehouseProduct.findUnique({
    where: { id: warehouseProductId },
    select: { id: true, tenantId: true, currentStock: true },
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
        include: { provider: { select: { name: true } } },
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

    if (hasOwnStock) {
      decisions.set(product.id, {
        stockAfter: product.currentStock,
        publishedQuantity: product.currentStock,
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
  const logs = [];

  for (const mapping of mappings) {
    const product = mapping.warehouseProduct;
    if (!product?.isActive) continue;

    const decision = decisions.get(product.id);
    if (!decision) continue;

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
        availabilityPolicy: decision.availabilityPolicy,
        outOfStockBehavior: decision.outOfStockBehavior,
        warningMessage: decision.warningMessage,
        status: 'PENDING',
      },
    });

    await addStockSyncJob({
      logId: log.id,
      tenantId: product.tenantId,
      warehouseProductId: product.id,
      shopId: mapping.shopId,
      externalProductId: mapping.externalProductId,
      triggeredBy: options.triggeredBy,
      documentId: options.documentId,
    });

    logs.push(log);
    enqueued += 1;
  }

  return {
    enqueued,
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
  if (productIds.length === 0) return { enqueued: 0, logs: [] };

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
