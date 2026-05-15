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
  if (product.retailPrice === null) throw new Error('Produkt nie ma ustawionej ceny sprzedaży');

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
        priceAfter: product.retailPrice,
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

export async function retryPriceSyncLog(id: string) {
  const tenantId = requireTenantId();
  const log = await prisma.priceSyncLog.findFirst({
    where: { id, tenantId },
    include: { warehouseProduct: true, shopProductMapping: true },
  });

  if (!log) throw new Error('Log synchronizacji ceny nie znaleziony');
  if (log.warehouseProduct.retailPrice === null) throw new Error('Produkt nie ma ustawionej ceny sprzedaży');

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
      priceAfter: log.warehouseProduct.retailPrice,
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
