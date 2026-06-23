import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { addStockSyncBatchJobs, type StockSyncBatchItem, type StockSyncTriggeredBy } from '../queue/stock-sync.queue';
import { resolveWholesaleAvailabilityRule } from '../admin/wholesale/shared';

export type InventoryAvailabilityPolicy = 'IN_STOCK' | 'IN_STOCK_WITH_BACKORDER' | 'BACKORDER_FROM_WHOLESALE' | 'OUT_OF_STOCK';
export type PrestaShopOutOfStockBehavior = 0 | 1;
export type ProductActivationMode = 'UNCHANGED' | 'SYNC_WITH_AVAILABILITY';
export type InventoryLeadTimeSource =
  | 'LOCAL_STOCK'
  | 'PRODUCT_OVERRIDE'
  | 'PRODUCT_GROUP'
  | 'WHOLESALE_PROVIDER'
  | 'SHOP_DEFAULT'
  | 'NONE';

export interface InventoryPublicationDecision {
  stockAfter: Prisma.Decimal;
  publishedQuantity: Prisma.Decimal;
  /**
   * Quantity that ships immediately from local stock. Set only for the mixed
   * IN_STOCK_WITH_BACKORDER policy, where publishedQuantity is the combined cap
   * (local + wholesale) and inStockQuantity is the local part. Quantities above
   * this threshold use leadTimeDays (wholesale lead).
   */
  inStockQuantity?: Prisma.Decimal;
  leadTimeDays?: number | null;
  leadTimeSource?: InventoryLeadTimeSource;
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
  isStockTracked?: boolean;
  leadTimeDaysOverride?: number | null;
  leadTimeGroup?: { leadTimeDays: number; isActive: boolean } | null;
};

type ProductLeadTimeResolution = {
  days: number | null;
  source: InventoryLeadTimeSource;
};

const ZERO = new Prisma.Decimal(0);
const TODAY_DATE_ONLY = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};

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
      isStockTracked: true,
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
  // Mappings are needed both for products without own stock (pure backorder)
  // and for products with own stock (mixed IN_STOCK_WITH_BACKORDER), so fetch
  // for every product that has a mapping.
  const allProductIds = products.map((product) => product.id);

  const wholesaleMappings = allProductIds.length === 0
    ? []
    : await prisma.wholesaleProductMapping.findMany({
        where: {
          warehouseProductId: { in: allProductIds },
          isActive: true,
          provider: { isActive: true },
        },
        orderBy: [
          { lastKnownPrice: 'asc' },
          { lastSyncAt: 'desc' },
        ],
        include: { provider: { select: { name: true, leadTimeDays: true, configJson: true } } },
      });

  const wholesaleByProductId = new Map<string, typeof wholesaleMappings[number]>();
  const futureWholesaleByProductId = new Map<string, typeof wholesaleMappings[number]>();
  for (const mapping of wholesaleMappings) {
    if (!mapping.warehouseProductId) continue;
    if (isPositiveDecimal(mapping.lastKnownStock)) {
      if (!wholesaleByProductId.has(mapping.warehouseProductId)) {
        wholesaleByProductId.set(mapping.warehouseProductId, mapping);
      }
      continue;
    }

    if (
      !futureWholesaleByProductId.has(mapping.warehouseProductId) &&
      resolveWholesaleAvailabilityRule(mapping.provider.configJson) === 'STOCK_OR_FUTURE_DELIVERY' &&
      isFutureAvailabilityDate(mapping.warehouseAvailableAt)
    ) {
      futureWholesaleByProductId.set(mapping.warehouseProductId, mapping);
    }
  }

  const decisions = new Map<string, InventoryPublicationDecision>();
  for (const product of products) {
    decisions.set(product.id, resolvePublicationDecision(product, {
      wholesaleWithStock: wholesaleByProductId.get(product.id),
      futureWholesale: futureWholesaleByProductId.get(product.id),
      warningMessage: options.warningMessage,
    }));
  }

  return decisions;
}

export type WholesaleMappingForDecision = {
  id: string;
  lastKnownStock: Prisma.Decimal | null;
  warehouseAvailableAt: Date | null;
  provider: { name: string; leadTimeDays: number | null };
};

/**
 * Pure per-product publication decision. Inputs are the already-resolved
 * wholesale mappings (one with numeric stock, one with a future delivery date),
 * so this can be unit tested without touching the database.
 */
export function resolvePublicationDecision(
  product: ProductForPublication,
  input: {
    wholesaleWithStock?: WholesaleMappingForDecision | null;
    futureWholesale?: WholesaleMappingForDecision | null;
    warningMessage?: string;
  } = {},
): InventoryPublicationDecision {
  const hasOwnStock = product.currentStock.gt(0);
  const wholesaleWithStock = input.wholesaleWithStock ?? undefined;
  const wholesale = wholesaleWithStock ?? input.futureWholesale ?? undefined;
  const productLeadTime = resolveProductLeadTime(product);

  const backorderLeadTime = (mapping: WholesaleMappingForDecision) => {
    const wholesaleLeadTime = normalizeOptionalLeadTimeDays(mapping.provider.leadTimeDays);
    return {
      leadTimeDays: productLeadTime.days ?? wholesaleLeadTime,
      leadTimeSource: productLeadTime.days !== null
        ? productLeadTime.source
        : wholesaleLeadTime !== null
          ? 'WHOLESALE_PROVIDER' as const
          : 'NONE' as const,
    };
  };

  if (hasOwnStock) {
    // Mixed: local stock + wholesale with numeric stock. Publish the combined
    // cap (so the customer can order beyond local stock up to the wholesale
    // limit) and keep inStockQuantity = local stock so the ETA stays fast for
    // the in-stock portion and switches to the wholesale lead above it.
    if (wholesaleWithStock) {
      const wholesaleStock = wholesaleWithStock.lastKnownStock ?? ZERO;
      const lead = backorderLeadTime(wholesaleWithStock);
      return {
        stockAfter: product.currentStock,
        publishedQuantity: product.currentStock.plus(wholesaleStock),
        inStockQuantity: product.currentStock,
        leadTimeDays: lead.leadTimeDays,
        leadTimeSource: lead.leadTimeSource,
        warehouseAvailableAt: wholesaleWithStock.warehouseAvailableAt,
        availabilityPolicy: 'IN_STOCK_WITH_BACKORDER',
        outOfStockBehavior: 0,
        warningMessage: input.warningMessage,
        wholesaleMappingId: wholesaleWithStock.id,
        wholesaleProviderName: wholesaleWithStock.provider.name,
      };
    }

    return {
      stockAfter: product.currentStock,
      publishedQuantity: product.currentStock,
      leadTimeDays: 0,
      leadTimeSource: 'LOCAL_STOCK',
      availabilityPolicy: 'IN_STOCK',
      outOfStockBehavior: 0,
      warningMessage: input.warningMessage,
    };
  }

  if (wholesale) {
    const lead = backorderLeadTime(wholesale);
    return {
      stockAfter: product.currentStock,
      publishedQuantity: ZERO,
      leadTimeDays: lead.leadTimeDays,
      leadTimeSource: lead.leadTimeSource,
      warehouseAvailableAt: wholesale.warehouseAvailableAt,
      availabilityPolicy: 'BACKORDER_FROM_WHOLESALE',
      outOfStockBehavior: 1,
      warningMessage: input.warningMessage,
      wholesaleMappingId: wholesale.id,
      wholesaleProviderName: wholesale.provider.name,
    };
  }

  return {
    stockAfter: product.currentStock,
    publishedQuantity: ZERO,
    leadTimeDays: null,
    leadTimeSource: 'NONE',
    availabilityPolicy: 'OUT_OF_STOCK',
    outOfStockBehavior: 0,
    warningMessage: input.warningMessage,
  };
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
          isStockTracked: true,
        },
      },
    },
  });

  const productsById = new Map<string, ProductForPublication>();
  let skippedInactiveProducts = 0;
  let skippedUntrackedProducts = 0;
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
    if (!mapping.warehouseProduct.isStockTracked) {
      skippedUntrackedProducts++;
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
    if (!product?.isActive || !product.isStockTracked) continue;

    const decision = decisions.get(product.id);
    if (!decision) continue;
    const publishedLeadTime = resolveInventoryPublishedLeadTime(decision, mapping.shop.configJson);
    const publishedLeadTimeDays = publishedLeadTime.leadTimeDays;
    const publishActive = resolvePublishedProductActive(decision, mapping.shop.configJson);

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
        inStockQuantity: decision.inStockQuantity ?? null,
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
      quantity: publishedQuantityForQueue(decision.publishedQuantity),
      inStockQuantity: inStockQuantityForQueue(decision.inStockQuantity),
      leadTimeDays: publishedLeadTimeDays,
      warehouseAvailableAt: formatWarehouseAvailableAt(decision.warehouseAvailableAt),
      outOfStockBehavior: decision.outOfStockBehavior,
      availabilityPolicy: decision.availabilityPolicy,
      active: publishActive,
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
    skippedUntrackedProducts,
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

export function publishedQuantityForQueue(quantity: Prisma.Decimal) {
  const normalized = Prisma.Decimal.max(quantity, ZERO);
  return Number(normalized.toDecimalPlaces(3).toString());
}

export function inStockQuantityForQueue(quantity?: Prisma.Decimal | null): number | undefined {
  if (quantity === undefined || quantity === null) return undefined;
  return Math.max(0, Math.floor(Number(quantity)));
}

function resolveProductLeadTime(product: ProductForPublication): ProductLeadTimeResolution {
  const override = normalizeOptionalLeadTimeDays(product.leadTimeDaysOverride);
  if (override !== null) return { days: override, source: 'PRODUCT_OVERRIDE' };

  if (product.leadTimeGroup?.isActive) {
    const groupLeadTime = normalizeOptionalLeadTimeDays(product.leadTimeGroup.leadTimeDays);
    if (groupLeadTime !== null) return { days: groupLeadTime, source: 'PRODUCT_GROUP' };
  }

  return { days: null, source: 'NONE' };
}

export function resolveInventoryPublishedLeadTime(
  decision: { leadTimeDays?: unknown; leadTimeSource?: InventoryLeadTimeSource | null; availabilityPolicy?: string | null },
  shopConfigJson: unknown,
): { leadTimeDays: number | null; source: InventoryLeadTimeSource } {
  if (decision.availabilityPolicy === 'OUT_OF_STOCK') {
    return { leadTimeDays: null, source: 'NONE' };
  }

  const decisionLeadTime = normalizeOptionalLeadTimeDays(decision.leadTimeDays);
  if (decisionLeadTime !== null) {
    return { leadTimeDays: decisionLeadTime, source: decision.leadTimeSource ?? 'NONE' };
  }

  const shopDefaultLeadTime = getShopDefaultLeadTimeDays(shopConfigJson);
  if (shopDefaultLeadTime !== null) {
    return { leadTimeDays: shopDefaultLeadTime, source: 'SHOP_DEFAULT' };
  }

  return { leadTimeDays: 0, source: 'NONE' };
}

export function resolvePublishedProductActive(
  decision: { availabilityPolicy?: string | null },
  shopConfigJson: unknown,
): boolean | undefined {
  if (getProductActivationMode(shopConfigJson) !== 'SYNC_WITH_AVAILABILITY') return undefined;
  return decision.availabilityPolicy !== 'OUT_OF_STOCK';
}

export function getProductActivationMode(configJson: unknown): ProductActivationMode {
  if (!configJson || typeof configJson !== 'object' || Array.isArray(configJson)) return 'UNCHANGED';
  const value = (configJson as Record<string, unknown>).productActivationMode;
  return value === 'SYNC_WITH_AVAILABILITY' ? 'SYNC_WITH_AVAILABILITY' : 'UNCHANGED';
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

function isPositiveDecimal(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === undefined || value === null) return false;
  return new Prisma.Decimal(value).gt(ZERO);
}

function isFutureAvailabilityDate(value?: Date | null) {
  if (!value) return false;
  return value >= TODAY_DATE_ONLY();
}
