import { Prisma } from '@prisma/client';
import config from '../../config';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { addPriceSyncJob, type PriceSyncTriggeredBy } from '../queue/price-sync.queue';
import { createShopStockClient } from '../shops/shop-client.factory';

type PriceSyncStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';

export interface PriceSyncLogsQuery {
  page?: number;
  limit?: number;
  shopId?: string;
  warehouseProductId?: string;
  status?: PriceSyncStatus;
  dateFrom?: string;
  dateTo?: string;
}

export interface SyncProductPriceOptions {
  shopId?: string;
  price?: number;
  triggeredBy?: PriceSyncTriggeredBy;
}

export interface BulkPriceSyncItem {
  warehouseProductId: string;
  shopId: string;
  price: number;
  triggeredBy?: PriceSyncTriggeredBy;
}

export interface PriceChangeHistoryQuery {
  shopId?: string;
  limit?: number | string;
}

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

export async function getPriceSyncLogs(query: PriceSyncLogsQuery = {}) {
  const tenantId = requireTenantId();
  const { page = 1, limit = 50, shopId, warehouseProductId, status, dateFrom, dateTo } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.PriceSyncLogWhereInput = { tenantId };
  if (shopId) where.shopId = shopId;
  if (warehouseProductId) where.warehouseProductId = warehouseProductId;
  if (status) where.status = status;
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) where.createdAt.lte = new Date(dateTo);
  }

  const [data, total] = await Promise.all([
    prisma.priceSyncLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        warehouseProduct: { select: { id: true, sku: true, name: true, retailPrice: true } },
        shop: { select: { id: true, name: true, platform: true, status: true } },
        shopProductMapping: {
          select: {
            id: true,
            externalProductId: true,
            externalSku: true,
            externalName: true,
            externalPrice: true,
          },
        },
      },
    }),
    prisma.priceSyncLog.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getPriceChangeHistory(warehouseProductId: string, query: PriceChangeHistoryQuery = {}) {
  const tenantId = requireTenantId();
  const limit = Math.min(Math.max(Number(query.limit ?? 5) || 5, 1), 20);
  const where: Prisma.PriceChangeHistoryWhereInput = { tenantId, warehouseProductId };
  if (query.shopId) where.shopId = query.shopId;

  return prisma.priceChangeHistory.findMany({
    where,
    take: limit,
    orderBy: { changedAt: 'desc' },
    include: {
      shop: { select: { id: true, name: true, platform: true } },
      shopProductMapping: {
        select: {
          id: true,
          externalProductId: true,
          externalSku: true,
          externalName: true,
        },
      },
      priceSyncLog: {
        select: {
          id: true,
          status: true,
          triggeredBy: true,
          syncedAt: true,
          createdAt: true,
        },
      },
    },
  });
}

export async function syncProductPrice(
  warehouseProductId: string,
  options: SyncProductPriceOptions = {},
) {
  const tenantId = requireTenantId();
  const triggeredBy = options.triggeredBy ?? 'MANUAL';

  const product = await prisma.warehouseProduct.findFirst({
    where: { id: warehouseProductId, tenantId },
  });
  if (!product) throw new Error('Produkt magazynowy nie znaleziony');
  if (options.price === undefined || options.price === null) {
    throw new Error('Brak ceny docelowej z cennika do synchronizacji');
  }
  const targetPrice = Number(options.price);
  if (!Number.isFinite(targetPrice) || targetPrice < 0) throw new Error('Cena sprzedaży jest nieprawidłowa');

  const where: Prisma.ShopProductMappingWhereInput = {
    tenantId,
    warehouseProductId,
    isActive: true,
    shop: { status: 'ACTIVE' },
  };
  if (options.shopId) where.shopId = options.shopId;

  const mappings = await prisma.shopProductMapping.findMany({
    where,
    include: { shop: true },
  });

  if (options.shopId && mappings.length === 0) {
    throw new Error('Brak aktywnego mapowania produktu do wskazanego sklepu');
  }

  let enqueued = 0;
  const logs = [];

  for (const mapping of mappings) {
    const safety = validateAutomaticPriceChange({
      triggeredBy,
      currentPrice: mapping.externalPrice,
      targetPrice,
      maxChangePercent: config.priceSyncSafety.maxAutoChangePercent,
    });
    if (!safety.ok) throw new Error(safety.message);
    if (safety.unchanged) continue;

    const log = await prisma.priceSyncLog.create({
      data: {
        tenantId,
        warehouseProductId,
        shopId: mapping.shopId,
        shopProductMappingId: mapping.id,
        triggeredBy,
        priceBefore: mapping.externalPrice,
        priceAfter: targetPrice,
        status: 'PENDING',
      },
    });

    await addPriceSyncJob({
      logId: log.id,
      tenantId,
      warehouseProductId,
      shopId: mapping.shopId,
      shopProductMappingId: mapping.id,
      externalProductId: mapping.externalProductId,
      triggeredBy,
    });

    logs.push(log);
    enqueued += 1;
  }

  return { enqueued, logs };
}

export async function syncProductPricesBulkForTenant(tenantId: string, items: BulkPriceSyncItem[]) {
  const normalizedItems = items.filter((item) => item.warehouseProductId && item.shopId);
  const productIds = [...new Set(normalizedItems.map((item) => item.warehouseProductId))];
  const shopIds = [...new Set(normalizedItems.map((item) => item.shopId))];

  let synced = 0;
  let enqueued = 0;
  let failed = 0;
  let skippedUnchanged = 0;
  const errors: Array<{ warehouseProductId: string; shopId: string; message: string }> = [];

  if (normalizedItems.length === 0) return { synced, enqueued, failed, skippedUnchanged, errors };

  const automaticItems = normalizedItems.filter((item) => (item.triggeredBy ?? 'MANUAL') !== 'MANUAL');
  if (automaticItems.length > config.priceSyncSafety.maxAutoBatch) {
    const message = `Automatyczny batch cen (${automaticItems.length}) przekracza limit ${config.priceSyncSafety.maxAutoBatch}. Wymagane ręczne zatwierdzenie.`;
    return {
      synced,
      enqueued,
      failed: normalizedItems.length,
      skippedUnchanged,
      errors: normalizedItems.map((item) => ({ warehouseProductId: item.warehouseProductId, shopId: item.shopId, message })),
    };
  }

  const [products, mappings] = await Promise.all([
    prisma.warehouseProduct.findMany({
      where: { id: { in: productIds }, tenantId },
      select: { id: true, averagePurchaseCost: true, purchasePrice: true },
    }),
    prisma.shopProductMapping.findMany({
      where: {
        tenantId,
        warehouseProductId: { in: productIds },
        shopId: { in: shopIds },
        isActive: true,
        shop: { status: 'ACTIVE' },
      },
      include: { shop: true },
    }),
  ]);

  const productById = new Map(products.map((product) => [product.id, product]));
  const mappingByKey = new Map(mappings.map((mapping) => [`${mapping.warehouseProductId}:${mapping.shopId}`, mapping]));
  const groups = new Map<string, Array<{
    item: BulkPriceSyncItem;
    mapping: typeof mappings[number];
    product: typeof products[number];
    targetPrice: number;
  }>>();

  for (const item of normalizedItems) {
    const targetPrice = Number(item.price);
    if (!Number.isFinite(targetPrice) || targetPrice < 0) {
      failed += 1;
      errors.push({ warehouseProductId: item.warehouseProductId, shopId: item.shopId, message: 'Cena sprzedaży jest nieprawidłowa' });
      continue;
    }

    const product = productById.get(item.warehouseProductId);
    if (!product) {
      failed += 1;
      errors.push({ warehouseProductId: item.warehouseProductId, shopId: item.shopId, message: 'Produkt magazynowy nie znaleziony' });
      continue;
    }

    const mapping = mappingByKey.get(`${item.warehouseProductId}:${item.shopId}`);
    if (!mapping) {
      failed += 1;
      errors.push({ warehouseProductId: item.warehouseProductId, shopId: item.shopId, message: 'Brak aktywnego mapowania produktu do wskazanego sklepu' });
      continue;
    }

    const safety = validateAutomaticPriceChange({
      triggeredBy: item.triggeredBy ?? 'MANUAL',
      currentPrice: mapping.externalPrice,
      targetPrice,
      maxChangePercent: config.priceSyncSafety.maxAutoChangePercent,
    });
    if (!safety.ok) {
      failed += 1;
      errors.push({ warehouseProductId: item.warehouseProductId, shopId: item.shopId, message: safety.message });
      continue;
    }
    if (safety.unchanged) {
      skippedUnchanged += 1;
      continue;
    }

    const group = groups.get(mapping.shopId) ?? [];
    group.push({ item, mapping, product, targetPrice });
    groups.set(mapping.shopId, group);
  }

  for (const entries of groups.values()) {
    const shop = entries[0]?.mapping.shop;
    if (!shop) continue;

    const client = createShopStockClient(shop);
    if (!client.bulkUpdateProductPrices) {
      for (const entry of entries) {
        const log = await createPriceSyncLog({
          tenantId,
          warehouseProductId: entry.item.warehouseProductId,
          shopId: entry.item.shopId,
          shopProductMappingId: entry.mapping.id,
          triggeredBy: entry.item.triggeredBy ?? 'MANUAL',
          priceBefore: entry.mapping.externalPrice,
          priceAfter: entry.targetPrice,
          status: 'PENDING',
        });
        await addPriceSyncJob({
          logId: log.id,
          tenantId,
          warehouseProductId: entry.item.warehouseProductId,
          shopId: entry.item.shopId,
          shopProductMappingId: entry.mapping.id,
          externalProductId: entry.mapping.externalProductId,
          triggeredBy: entry.item.triggeredBy ?? 'MANUAL',
        });
        enqueued += 1;
      }
      continue;
    }

    const logs = new Map<string, Awaited<ReturnType<typeof createPriceSyncLog>>>();
    for (const entry of entries) {
      const log = await createPriceSyncLog({
        tenantId,
        warehouseProductId: entry.item.warehouseProductId,
        shopId: entry.item.shopId,
        shopProductMappingId: entry.mapping.id,
        triggeredBy: entry.item.triggeredBy ?? 'MANUAL',
        priceBefore: entry.mapping.externalPrice,
        priceAfter: entry.targetPrice,
        status: 'PROCESSING',
        attemptCount: 1,
      });
      logs.set(entry.mapping.externalProductId, log);
    }

    try {
      const result = await client.bulkUpdateProductPrices(entries.map((entry) => {
        const costBasis = entry.product.averagePurchaseCost ?? entry.product.purchasePrice;
        const wholesalePrice = costBasis === null ? null : Number(costBasis);
        return {
          externalProductId: entry.mapping.externalProductId,
          price: entry.targetPrice,
          ...(wholesalePrice !== null && Number.isFinite(wholesalePrice) && wholesalePrice >= 0 ? { wholesalePrice } : {}),
        };
      }));
      const resultByExternalId = new Map(result.results.map((item) => [String(item.productId), item]));

      for (const entry of entries) {
        const log = logs.get(entry.mapping.externalProductId);
        if (!log) continue;
        const itemResult = resultByExternalId.get(entry.mapping.externalProductId);
        if (itemResult?.status === 'ok') {
          await markPriceSyncSuccess({
            tenantId,
            logId: log.id,
            warehouseProductId: entry.item.warehouseProductId,
            shopId: entry.item.shopId,
            shopProductMappingId: entry.mapping.id,
            triggeredBy: entry.item.triggeredBy ?? 'MANUAL',
            priceBefore: entry.mapping.externalPrice,
            priceAfter: entry.targetPrice,
          });
          synced += 1;
        } else {
          const message = itemResult?.message ?? 'Brak potwierdzenia aktualizacji ceny z modułu kp_adminconnector';
          await markPriceSyncFailed(log.id, message);
          failed += 1;
          errors.push({ warehouseProductId: entry.item.warehouseProductId, shopId: entry.item.shopId, message });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd bulk synchronizacji ceny';
      for (const entry of entries) {
        const log = logs.get(entry.mapping.externalProductId);
        if (log) await markPriceSyncFailed(log.id, message);
        failed += 1;
        errors.push({ warehouseProductId: entry.item.warehouseProductId, shopId: entry.item.shopId, message });
      }
    }
  }

  return { synced, enqueued, failed, skippedUnchanged, errors };
}

export function validateAutomaticPriceChange(input: {
  triggeredBy: PriceSyncTriggeredBy;
  currentPrice: Prisma.Decimal | number | string | null;
  targetPrice: number;
  maxChangePercent: number;
}) {
  if (input.currentPrice !== null && new Prisma.Decimal(input.currentPrice).eq(input.targetPrice)) {
    return { ok: true as const, unchanged: true, changePercent: 0, message: '' };
  }
  if (input.triggeredBy === 'MANUAL' || input.currentPrice === null) {
    return { ok: true as const, unchanged: false, changePercent: null, message: '' };
  }

  const currentPrice = Number(input.currentPrice);
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return {
      ok: false as const,
      unchanged: false,
      changePercent: null,
      message: 'Automatyczna zmiana ceny z wartości zerowej lub nieprawidłowej wymaga ręcznego zatwierdzenia.',
    };
  }

  const changePercent = Math.abs(((input.targetPrice - currentPrice) / currentPrice) * 100);
  if (changePercent > input.maxChangePercent) {
    return {
      ok: false as const,
      unchanged: false,
      changePercent,
      message: `Automatyczna zmiana ceny ${changePercent.toFixed(2)}% przekracza limit ${input.maxChangePercent}%.`,
    };
  }

  return { ok: true as const, unchanged: false, changePercent, message: '' };
}

export async function syncProductPricesBulk(items: BulkPriceSyncItem[]) {
  return syncProductPricesBulkForTenant(requireTenantId(), items);
}

interface PriceSyncLogInput {
  tenantId: string;
  warehouseProductId: string;
  shopId: string;
  shopProductMappingId: string;
  triggeredBy: PriceSyncTriggeredBy;
  priceBefore: Prisma.Decimal | null;
  priceAfter: number | Prisma.Decimal;
  status: PriceSyncStatus;
  attemptCount?: number;
}

function createPriceSyncLog(input: PriceSyncLogInput) {
  return prisma.priceSyncLog.create({
    data: {
      tenantId: input.tenantId,
      warehouseProductId: input.warehouseProductId,
      shopId: input.shopId,
      shopProductMappingId: input.shopProductMappingId,
      triggeredBy: input.triggeredBy,
      priceBefore: input.priceBefore,
      priceAfter: input.priceAfter,
      status: input.status,
      attemptCount: input.attemptCount ?? 0,
    },
  });
}

interface MarkPriceSyncSuccessInput {
  tenantId: string;
  logId: string;
  warehouseProductId: string;
  shopId: string;
  shopProductMappingId: string;
  triggeredBy: PriceSyncTriggeredBy;
  priceBefore: Prisma.Decimal | null;
  priceAfter: number | Prisma.Decimal;
}

async function markPriceSyncSuccess(input: MarkPriceSyncSuccessInput) {
  const syncedAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.priceSyncLog.update({
      where: { id: input.logId },
      data: {
        status: 'SUCCESS',
        priceBefore: input.priceBefore,
        priceAfter: input.priceAfter,
        errorMessage: null,
        syncedAt,
      },
    });
    await tx.shopProductMapping.update({
      where: { id: input.shopProductMappingId },
      data: {
        externalPrice: input.priceAfter,
        lastSyncAt: syncedAt,
      },
    });
    await tx.priceChangeHistory.create({
      data: {
        tenantId: input.tenantId,
        warehouseProductId: input.warehouseProductId,
        shopId: input.shopId,
        shopProductMappingId: input.shopProductMappingId,
        priceSyncLogId: input.logId,
        triggeredBy: input.triggeredBy,
        priceBefore: input.priceBefore,
        priceAfter: input.priceAfter,
        changedAt: syncedAt,
      },
    });

    const older = await tx.priceChangeHistory.findMany({
      where: {
        tenantId: input.tenantId,
        warehouseProductId: input.warehouseProductId,
        shopId: input.shopId,
        shopProductMappingId: input.shopProductMappingId,
      },
      orderBy: { changedAt: 'desc' },
      skip: 5,
      select: { id: true },
    });
    if (older.length > 0) {
      await tx.priceChangeHistory.deleteMany({
        where: { id: { in: older.map((item) => item.id) } },
      });
    }
  });
}

function markPriceSyncFailed(logId: string, message: string) {
  return prisma.priceSyncLog.update({
    where: { id: logId },
    data: {
      status: 'FAILED',
      errorMessage: message,
    },
  });
}

export interface BulkSyncProductPricesResult {
  requested: number;
  enqueued: number;
  skippedNoPrice: number;
  skippedNoMapping: number;
  failed: number;
  errors: Array<{ productId: string; message: string }>;
}

export async function syncPricesForProducts(
  productIds: string[],
  options: Pick<SyncProductPriceOptions, 'shopId' | 'triggeredBy'> = {},
): Promise<BulkSyncProductPricesResult> {
  requireTenantId();
  const uniqueIds = [...new Set(productIds)];

  const result: BulkSyncProductPricesResult = {
    requested: uniqueIds.length,
    enqueued: 0,
    skippedNoPrice: 0,
    skippedNoMapping: 0,
    failed: 0,
    errors: [],
  };

  for (const productId of uniqueIds) {
    try {
      const single = await syncProductPrice(productId, options);
      if (single.enqueued === 0) result.skippedNoMapping += 1;
      else result.enqueued += single.enqueued;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd synchronizacji ceny';
      if (message.includes('ceny sprzedaży')) {
        result.skippedNoPrice += 1;
      } else if (message.includes('mapowania')) {
        result.skippedNoMapping += 1;
      } else {
        result.failed += 1;
        result.errors.push({ productId, message });
      }
    }
  }

  return result;
}

export async function retryPriceSyncLog(id: string) {
  const tenantId = requireTenantId();
  const log = await prisma.priceSyncLog.findFirst({
    where: { id, tenantId },
    include: { warehouseProduct: true, shopProductMapping: true },
  });

  if (!log) throw new Error('Log synchronizacji ceny nie znaleziony');
  if (log.priceAfter === null) throw new Error('Log synchronizacji nie ma ceny docelowej');

  const mapping = await prisma.shopProductMapping.findFirst({
    where: {
      id: log.shopProductMappingId,
      tenantId,
      warehouseProductId: log.warehouseProductId,
      shopId: log.shopId,
      isActive: true,
      shop: { status: 'ACTIVE' },
    },
  });

  if (!mapping) {
    throw new Error('Brak aktywnego mapowania produktu do sklepu dla ponowienia synchronizacji ceny');
  }

  const retryLog = await prisma.priceSyncLog.create({
    data: {
      tenantId,
      warehouseProductId: log.warehouseProductId,
      shopId: log.shopId,
      shopProductMappingId: mapping.id,
      triggeredBy: 'MANUAL',
      priceBefore: mapping.externalPrice,
      priceAfter: log.priceAfter,
      status: 'PENDING',
    },
  });

  await addPriceSyncJob({
    logId: retryLog.id,
    tenantId,
    warehouseProductId: log.warehouseProductId,
    shopId: log.shopId,
    shopProductMappingId: mapping.id,
    externalProductId: mapping.externalProductId,
    triggeredBy: 'MANUAL',
  });

  return retryLog;
}
