import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { addPriceSyncJob, type PriceSyncTriggeredBy } from '../queue/price-sync.queue';

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
