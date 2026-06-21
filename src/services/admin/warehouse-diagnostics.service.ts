import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { addStockSyncBatchJobs, addStockSyncJob, getStockSyncQueue, type StockSyncBatchItem } from '../queue/stock-sync.queue';
import { getInventoryPublicationDecision } from '../stock/stock-sync.service';

type StockSyncStatus = 'PENDING' | 'PROCESSING' | 'SUCCESS' | 'FAILED';
type DocumentType = 'PZ' | 'ZH' | 'PW' | 'WZ' | 'ZW' | 'RW' | 'INW';

export interface StockSyncLogsQuery {
  page?: number;
  limit?: number;
  shopId?: string;
  warehouseProductId?: string;
  status?: StockSyncStatus;
  dateFrom?: string;
  dateTo?: string;
}

export interface ProductMovementsQuery {
  page?: number;
  limit?: number;
  status?: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
  type?: DocumentType;
  dateFrom?: string;
  dateTo?: string;
}

export interface StockDiscrepanciesQuery {
  includeZero?: boolean;
}

export interface WarehouseDashboardQuery {
  lowStockThreshold?: number;
  limit?: number;
  failedSinceDays?: number;
}

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

export async function getStockSyncLogs(query: StockSyncLogsQuery = {}) {
  const tenantId = requireTenantId();
  const { page = 1, limit = 50, shopId, warehouseProductId, status, dateFrom, dateTo } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.StockSyncLogWhereInput = { tenantId };
  if (shopId) where.shopId = shopId;
  if (warehouseProductId) where.warehouseProductId = warehouseProductId;
  if (status) where.status = status;
  if (dateFrom || dateTo) {
    where.createdAt = {};
    if (dateFrom) where.createdAt.gte = new Date(dateFrom);
    if (dateTo) where.createdAt.lte = new Date(dateTo);
  }

  // where bez filtra statusu — do liczenia per-status dla całego zakresu (shopId, product, daty)
  const whereForCounts: Prisma.StockSyncLogWhereInput = { tenantId };
  if (shopId) whereForCounts.shopId = shopId;
  if (warehouseProductId) whereForCounts.warehouseProductId = warehouseProductId;
  if (dateFrom || dateTo) whereForCounts.createdAt = where.createdAt;

  const [data, total, statusGroups] = await Promise.all([
    prisma.stockSyncLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        warehouseProduct: { select: { id: true, sku: true, name: true, currentStock: true } },
        shop: { select: { id: true, name: true, platform: true, status: true } },
        document: { select: { id: true, number: true, type: true, status: true, date: true } },
      },
    }),
    prisma.stockSyncLog.count({ where }),
    prisma.stockSyncLog.groupBy({
      by: ['status'],
      where: whereForCounts,
      _count: { status: true },
    }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of statusGroups) {
    statusCounts[row.status] = row._count.status;
  }

  return { data, total, page, limit, totalPages: Math.ceil(total / limit), statusCounts };
}

export async function retryStockSyncLog(id: string) {
  const tenantId = requireTenantId();
  const log = await prisma.stockSyncLog.findFirst({
    where: { id, tenantId },
    include: { warehouseProduct: true, shop: true },
  });

  if (!log) throw new Error('Log synchronizacji stanu nie znaleziony');
  if (!log.warehouseProduct?.isStockTracked) {
    throw new Error('Produkt jest wykluczony z magazynu');
  }

  const mapping = await prisma.shopProductMapping.findFirst({
    where: {
      tenantId,
      shopId: log.shopId,
      warehouseProductId: log.warehouseProductId,
      isActive: true,
      shop: { status: 'ACTIVE' },
    },
  });

  if (!mapping) {
    throw new Error('Brak aktywnego mapowania produktu do sklepu dla ponowienia synchronizacji');
  }

  const decision = await getInventoryPublicationDecision(log.warehouseProductId);
  const publishedLeadTimeDays = resolvePublishedLeadTimeDays(decision, log.shop.configJson);
  const retryLog = await prisma.stockSyncLog.create({
    data: {
      tenantId,
      warehouseProductId: log.warehouseProductId,
      shopId: log.shopId,
      triggeredBy: 'MANUAL',
      documentId: log.documentId,
      stockBefore: log.stockAfter,
      stockAfter: log.warehouseProduct.currentStock,
      publishedQuantity: decision.publishedQuantity,
      publishedLeadTimeDays,
      publishedWarehouseAvailableAt: decision.warehouseAvailableAt ?? null,
      availabilityPolicy: decision.availabilityPolicy,
      outOfStockBehavior: decision.outOfStockBehavior,
      warningMessage: decision.warningMessage,
      status: 'PENDING',
    },
  });

  await addStockSyncJob({
    logId: retryLog.id,
    tenantId,
    warehouseProductId: log.warehouseProductId,
    shopId: log.shopId,
    externalProductId: mapping.externalProductId,
    triggeredBy: 'MANUAL',
    documentId: log.documentId ?? undefined,
  });

  return retryLog;
}

export async function requeuePendingStockSyncLogs(shopId?: string) {
  const tenantId = requireTenantId();

  const pendingLogs = await prisma.stockSyncLog.findMany({
    where: {
      tenantId,
      status: 'PENDING',
      ...(shopId ? { shopId } : {}),
    },
    include: {
      warehouseProduct: { select: { id: true, isActive: true, isStockTracked: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });

  let requeued = 0;
  let skipped = 0;
  const errors: Array<{ logId: string; message: string }> = [];
  const batchItemsByShop = new Map<string, {
    tenantId: string;
    shopId: string;
    triggeredBy: import('../queue/stock-sync.queue').StockSyncTriggeredBy;
    documentId?: string;
    items: StockSyncBatchItem[];
  }>();

  for (const log of pendingLogs) {
    try {
      if (!log.warehouseProduct?.isActive || !log.warehouseProduct.isStockTracked) { skipped++; continue; }

      const mapping = await prisma.shopProductMapping.findFirst({
        where: {
          tenantId,
          shopId: log.shopId,
          warehouseProductId: log.warehouseProductId,
          isActive: true,
        },
        select: { externalProductId: true },
      });

      if (!mapping) { skipped++; continue; }

      // Usuń stary job z Redis jeśli istnieje — ten sam jobId blokuje dodanie nowego
      const queue = getStockSyncQueue();
      const existingJob = await queue.getJob(`stock-${log.id}`);
      if (existingJob) {
        await existingJob.remove().catch(() => undefined);
      }

      const batch = batchItemsByShop.get(log.shopId) ?? {
        tenantId,
        shopId: log.shopId,
        triggeredBy: log.triggeredBy as import('../queue/stock-sync.queue').StockSyncTriggeredBy,
        documentId: log.documentId ?? undefined,
        items: [],
      };
      batch.items.push({
        logId: log.id,
        warehouseProductId: log.warehouseProductId,
        externalProductId: mapping.externalProductId,
        quantity: Math.max(0, Math.floor(Number(log.publishedQuantity ?? log.stockAfter))),
        leadTimeDays: log.publishedLeadTimeDays ?? null,
        warehouseAvailableAt: formatWarehouseAvailableAt(log.publishedWarehouseAvailableAt),
        outOfStockBehavior: log.outOfStockBehavior === 1 ? 1 : 0,
        availabilityPolicy: isStockSyncAvailabilityPolicy(log.availabilityPolicy) ? log.availabilityPolicy : undefined,
      });
      batchItemsByShop.set(log.shopId, batch);

      requeued++;
    } catch (error) {
      errors.push({ logId: log.id, message: error instanceof Error ? error.message : 'Błąd' });
    }
  }

  for (const batch of batchItemsByShop.values()) {
    await addStockSyncBatchJobs(batch);
  }

  return { total: pendingLogs.length, requeued, skipped, errors };
}

function resolvePublishedLeadTimeDays(
  decision: { leadTimeDays?: unknown; availabilityPolicy?: string | null },
  shopConfigJson: unknown,
) {
  if (decision.availabilityPolicy === 'OUT_OF_STOCK') return null;
  return normalizeOptionalLeadTimeDays(decision.leadTimeDays) ??
    getShopDefaultLeadTimeDays(shopConfigJson) ??
    0;
}

function formatWarehouseAvailableAt(value?: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function isStockSyncAvailabilityPolicy(value: unknown): value is import('../queue/stock-sync.queue').StockSyncAvailabilityPolicy {
  return value === 'IN_STOCK' || value === 'BACKORDER_FROM_WHOLESALE' || value === 'OUT_OF_STOCK';
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

export async function getProductMovements(productId: string, query: ProductMovementsQuery = {}) {
  const tenantId = requireTenantId();
  const product = await prisma.warehouseProduct.findFirst({
    where: { id: productId, tenantId },
    include: { catalog: true },
  });
  if (!product) throw new Error('Produkt nie znaleziony');

  const { page = 1, limit = 50, status, type, dateFrom, dateTo } = query;
  const skip = (page - 1) * limit;

  const documentWhere: Prisma.WarehouseDocumentWhereInput = { tenantId };
  if (status) documentWhere.status = status;
  if (type) documentWhere.type = type;
  if (dateFrom || dateTo) {
    documentWhere.date = {};
    if (dateFrom) documentWhere.date.gte = new Date(dateFrom);
    if (dateTo) documentWhere.date.lte = new Date(dateTo);
  }

  const where: Prisma.WarehouseDocumentItemWhereInput = {
    productId,
    document: documentWhere,
  };

  const [items, total] = await Promise.all([
    prisma.warehouseDocumentItem.findMany({
      where,
      skip,
      take: limit,
      orderBy: { document: { date: 'desc' } },
      include: {
        barcode: true,
        document: {
          select: {
            id: true,
            number: true,
            type: true,
            status: true,
            date: true,
            description: true,
            orderId: true,
            isAutoGenerated: true,
          },
        },
      },
    }),
    prisma.warehouseDocumentItem.count({ where }),
  ]);

  const data = items.map((item) => {
    const stockDelta = item.document.status === 'CONFIRMED' ? getDocumentStockDelta(item) : 0;

    return {
      id: item.id,
      document: item.document,
      barcode: item.barcode,
      quantity: Number(item.quantity),
      stockDelta,
      unitPrice: item.unitPrice,
      scannedEan: item.scannedEan,
      baseQuantity: item.baseQuantity,
      quantityMultiplier: item.quantityMultiplier,
      notes: item.notes,
    };
  });

  return {
    product,
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getWarehouseDashboard(query: WarehouseDashboardQuery = {}) {
  const tenantId = requireTenantId();
  const lowStockThreshold = normalizeLowStockThreshold(query.lowStockThreshold);
  const limit = normalizeDashboardLimit(query.limit);
  const failedSinceDays = normalizeFailedSinceDays(query.failedSinceDays);
  const failedSince = new Date(Date.now() - failedSinceDays * 24 * 60 * 60 * 1000);

  const productBaseWhere: Prisma.WarehouseProductWhereInput = { tenantId, isActive: true, isStockTracked: true };
  const lowStockWhere: Prisma.WarehouseProductWhereInput = {
    ...productBaseWhere,
    currentStock: { lt: lowStockThreshold },
  };
  const negativeStockWhere: Prisma.WarehouseProductWhereInput = {
    ...productBaseWhere,
    currentStock: { lt: 0 },
  };
  const withoutBarcodeWhere: Prisma.WarehouseProductWhereInput = {
    ...productBaseWhere,
    barcodes: { none: { isActive: true } },
  };
  const withoutShopMappingWhere: Prisma.WarehouseProductWhereInput = {
    ...productBaseWhere,
    shopProductMappings: { none: { isActive: true } },
  };
  const activeWholesaleMappingFilter = {
    isActive: true,
    provider: { isActive: true },
  };
  const availableWholesaleMappingFilter = {
    ...activeWholesaleMappingFilter,
    lastKnownStock: { gt: 0 },
  };
  const withoutWholesaleOfferWhere: Prisma.WarehouseProductWhereInput = {
    ...productBaseWhere,
    wholesaleMappings: { none: activeWholesaleMappingFilter },
  };
  const productsWithUnavailableWholesaleOfferWhere: Prisma.WarehouseProductWhereInput = {
    ...productBaseWhere,
    AND: [
      { wholesaleMappings: { some: activeWholesaleMappingFilter } },
      { wholesaleMappings: { none: availableWholesaleMappingFilter } },
    ],
  };
  const failedStockSyncWhere: Prisma.StockSyncLogWhereInput = {
    tenantId,
    status: 'FAILED',
    createdAt: { gte: failedSince },
  };
  const failedPriceSyncWhere: Prisma.PriceSyncLogWhereInput = {
    tenantId,
    status: 'FAILED',
    createdAt: { gte: failedSince },
  };
  const failedWholesaleSyncWhere: Prisma.WholesaleSyncLogWhereInput = {
    tenantId,
    status: 'FAILED',
    startedAt: { gte: failedSince },
  };

  const [
    totalProducts,
    activeProducts,
    inactiveProducts,
    lowStockProductsCount,
    negativeStockProductsCount,
    productsWithoutBarcodeCount,
    productsWithoutShopMappingCount,
    productsWithoutWholesaleOfferCount,
    productsWithUnavailableWholesaleOfferCount,
    failedStockSyncLogsCount,
    failedPriceSyncLogsCount,
    failedWholesaleSyncLogsCount,
    draftDocumentsCount,
    lowStockProducts,
    negativeStockProducts,
    productsWithoutBarcode,
    productsWithoutShopMapping,
    productsWithoutWholesaleOffer,
    productsWithUnavailableWholesaleOffer,
    failedStockSyncLogs,
    failedPriceSyncLogs,
    failedWholesaleSyncLogs,
  ] = await Promise.all([
    prisma.warehouseProduct.count({ where: { tenantId } }),
    prisma.warehouseProduct.count({ where: productBaseWhere }),
    prisma.warehouseProduct.count({ where: { tenantId, isActive: false } }),
    prisma.warehouseProduct.count({ where: lowStockWhere }),
    prisma.warehouseProduct.count({ where: negativeStockWhere }),
    prisma.warehouseProduct.count({ where: withoutBarcodeWhere }),
    prisma.warehouseProduct.count({ where: withoutShopMappingWhere }),
    prisma.warehouseProduct.count({ where: withoutWholesaleOfferWhere }),
    prisma.warehouseProduct.count({ where: productsWithUnavailableWholesaleOfferWhere }),
    prisma.stockSyncLog.count({ where: failedStockSyncWhere }),
    prisma.priceSyncLog.count({ where: failedPriceSyncWhere }),
    prisma.wholesaleSyncLog.count({ where: failedWholesaleSyncWhere }),
    prisma.warehouseDocument.count({ where: { tenantId, status: 'DRAFT' } }),
    prisma.warehouseProduct.findMany({
      where: lowStockWhere,
      take: limit,
      orderBy: [{ currentStock: 'asc' }, { name: 'asc' }],
      include: { catalog: true },
    }),
    prisma.warehouseProduct.findMany({
      where: negativeStockWhere,
      take: limit,
      orderBy: [{ currentStock: 'asc' }, { name: 'asc' }],
      include: { catalog: true },
    }),
    prisma.warehouseProduct.findMany({
      where: withoutBarcodeWhere,
      take: limit,
      orderBy: { name: 'asc' },
      include: { catalog: true },
    }),
    prisma.warehouseProduct.findMany({
      where: withoutShopMappingWhere,
      take: limit,
      orderBy: { name: 'asc' },
      include: { catalog: true },
    }),
    prisma.warehouseProduct.findMany({
      where: withoutWholesaleOfferWhere,
      take: limit,
      orderBy: { name: 'asc' },
      include: { catalog: true },
    }),
    prisma.warehouseProduct.findMany({
      where: productsWithUnavailableWholesaleOfferWhere,
      take: limit,
      orderBy: { name: 'asc' },
      include: { catalog: true },
    }),
    prisma.stockSyncLog.findMany({
      where: failedStockSyncWhere,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        warehouseProduct: { select: { id: true, sku: true, name: true, currentStock: true } },
        shop: { select: { id: true, name: true, platform: true } },
      },
    }),
    prisma.priceSyncLog.findMany({
      where: failedPriceSyncWhere,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        warehouseProduct: { select: { id: true, sku: true, name: true, retailPrice: true } },
        shop: { select: { id: true, name: true, platform: true } },
      },
    }),
    prisma.wholesaleSyncLog.findMany({
      where: failedWholesaleSyncWhere,
      take: limit,
      orderBy: { startedAt: 'desc' },
      include: {
        provider: { select: { id: true, name: true, platform: true, syncEnabled: true, isActive: true } },
      },
    }),
  ]);

  return {
    summary: {
      totalProducts,
      activeProducts,
      inactiveProducts,
      lowStockProducts: lowStockProductsCount,
      negativeStockProducts: negativeStockProductsCount,
      productsWithoutBarcode: productsWithoutBarcodeCount,
      productsWithoutShopMapping: productsWithoutShopMappingCount,
      productsWithoutWholesaleOffer: productsWithoutWholesaleOfferCount,
      productsWithUnavailableWholesaleOffer: productsWithUnavailableWholesaleOfferCount,
      failedStockSyncLogs: failedStockSyncLogsCount,
      failedPriceSyncLogs: failedPriceSyncLogsCount,
      failedWholesaleSyncLogs: failedWholesaleSyncLogsCount,
      draftDocuments: draftDocumentsCount,
    },
    thresholds: {
      lowStockThreshold,
      failedSinceDays,
      limit,
    },
    sections: {
      lowStockProducts,
      negativeStockProducts,
      productsWithoutBarcode,
      productsWithoutShopMapping,
      productsWithoutWholesaleOffer,
      productsWithUnavailableWholesaleOffer,
      failedStockSyncLogs,
      failedPriceSyncLogs,
      failedWholesaleSyncLogs,
    },
  };
}

export async function getStockDiscrepancies(query: StockDiscrepanciesQuery = {}) {
  const tenantId = requireTenantId();
  const products = await prisma.warehouseProduct.findMany({
    where: { tenantId, isStockTracked: true },
    include: {
      catalog: true,
      items: {
        where: { document: { status: 'CONFIRMED' } },
        include: { document: { select: { type: true } } },
      },
      warehouseReservations: {
        where: { status: 'ACTIVE', source: 'LOCAL_STOCK' },
        select: { quantity: true, source: true },
      },
    },
    orderBy: { name: 'asc' },
  });

  const data = products
    .map((product) => {
      const calculatedStock = product.items.reduce((stock, item) => {
        return stock + getDocumentStockDelta(item);
      }, 0);
      const activeReservedQuantity = product.warehouseReservations.reduce((sum, reservation) => {
        return sum + Number(reservation.quantity);
      }, 0);
      const currentStock = Number(product.currentStock);
      const calculatedAvailableStock = calculatedStock - activeReservedQuantity;
      const difference = currentStock - calculatedAvailableStock;

      return {
        product: {
          id: product.id,
          sku: product.sku,
          name: product.name,
          unit: product.unit,
          catalog: product.catalog,
        },
        currentStock,
        calculatedStock: calculatedAvailableStock,
        difference,
      };
    })
    .filter((entry) => query.includeZero === true || entry.difference !== 0);

  return { data, total: data.length };
}

function normalizeLowStockThreshold(value?: number) {
  if (value === undefined) return 1;
  if (!Number.isFinite(value)) throw new Error('lowStockThreshold musi być liczbą');
  return value;
}

function normalizeDashboardLimit(value?: number) {
  if (value === undefined) return 10;
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error('limit dashboardu musi być liczbą całkowitą od 1 do 50');
  }
  return value;
}

function normalizeFailedSinceDays(value?: number) {
  if (value === undefined) return 7;
  if (!Number.isInteger(value) || value < 1 || value > 90) {
    throw new Error('failedSinceDays musi być liczbą całkowitą od 1 do 90');
  }
  return value;
}

function getDocumentDirection(type: string) {
  if (['PZ', 'PW', 'ZW'].includes(type)) return 1;
  if (['WZ', 'RW'].includes(type)) return -1;
  return 0;
}

function getDocumentStockDelta(item: { quantity: Prisma.Decimal; systemQuantity?: Prisma.Decimal | null; document: { type: string } }) {
  if (item.document.type === 'INW') {
    return Number(item.quantity) - Number(item.systemQuantity ?? 0);
  }

  return Number(item.quantity) * getDocumentDirection(item.document.type);
}
