import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { createDocument } from './warehouse-documents.service';
import { STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES } from '../../lib/order-statuses';
import { reserveOrder } from './warehouse-reservations.service';

export type ReplenishmentSource = 'order' | 'low' | 'all';
export type ReplenishmentCsvFormat = 'ean' | 'symbol' | 'full';
export type ReplenishmentCsvSeparator = ';' | ',' | '\t';

export interface ReplenishmentQuery {
  source?: ReplenishmentSource;
  providerId?: string;
  lowStockThreshold?: number;
  page?: number;
  limit?: number;
}

export interface ReplenishmentQuantityOverride {
  productId: string;
  quantity: number;
}

export interface ReplenishmentCsvInput extends ReplenishmentQuery {
  format?: ReplenishmentCsvFormat;
  separator?: ReplenishmentCsvSeparator | 'semicolon' | 'comma' | 'tab';
  includeHeader?: boolean;
  items?: ReplenishmentQuantityOverride[];
}

export interface CreateReplenishmentOrderInput extends ReplenishmentQuery {
  items?: ReplenishmentQuantityOverride[];
}

export interface ReplenishmentItem {
  id: string;
  productId: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  supplierSku: string | null;
  ean: string | null;
  supplierName: string | null;
  unitPrice: number | null;
  supplierStock: number;
  shortfall: number;
  value: number;
  reasons: Array<'ORDER' | 'LOW_STOCK'>;
  orderRefs: string[];
  currentStock?: number;
  lowStockThreshold?: number;
  reorderPoint?: number | null;
  orderMultiple?: number | null;
  orderMultipleSource?: 'PRODUCT' | 'BARCODE' | 'NONE';
}

export interface ReplenishmentProviderGroup {
  providerId: string;
  providerName: string;
  providerEmail: string | null;
  providerLeadTimeDays: number | null;
  providerLastSyncAt: Date | null;
  items: ReplenishmentItem[];
  itemsCount: number;
  totalQuantity: number;
  totalValue: number;
}

export interface ReplenishmentOrderedItem {
  id: string;
  documentId: string;
  documentNumber: string;
  documentStatus: 'DRAFT' | 'CONFIRMED';
  date: Date;
  createdAt: Date;
  providerId: string;
  providerName: string;
  productId: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  unitPrice: number | null;
  value: number;
  orderRefs: string[];
  linkedPzDocumentId: string | null;
}

export interface ReplenishmentOrderedProviderGroup {
  providerId: string;
  providerName: string;
  items: ReplenishmentOrderedItem[];
  itemsCount: number;
  totalQuantity: number;
  totalValue: number;
}

export interface ReplenishmentUncoveredItem {
  id: string;
  sku: string;
  name: string;
  quantity: number;
  orderRef: string | null;
  orderItemId: string | null;
  warehouseProductId: string | null;
  cause: 'MISSING_STOCK' | 'MISSING_MAPPING';
  message: string | null;
}

export interface ReplenishmentResponse {
  providers: ReplenishmentProviderGroup[];
  ordered: ReplenishmentOrderedProviderGroup[];
  uncovered: ReplenishmentUncoveredItem[];
  pagination: {
    source: 'low';
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  } | null;
  summary: {
    items: number;
    orderItems: number;
    lowStockItems: number;
    providers: number;
    quantity: number;
    value: number;
    orderedItems: number;
    orderedQuantity: number;
    uncovered: number;
    latestWholesaleSyncAt: Date | null;
    lowStockThreshold: number;
  };
}

export interface ReplenishmentRecalculateResult {
  totalReservations: number;
  totalOrders: number;
  processedOrders: number;
  changedOrders: number;
  failedOrders: number;
  reserved: number;
  unchanged: number;
  updated: number;
  partial: number;
  missingMapping: number;
  missingStock: number;
  orderResults: Array<{
    orderId: string;
    orderRef: string | null;
    reserved: number;
    unchanged: number;
    updated: number;
    partial: number;
    missingMapping: number;
    missingStock: number;
  }>;
  failures: Array<{
    orderId: string;
    orderRef: string | null;
    message: string;
  }>;
}

export interface ReplenishmentCsvResult {
  providerId: string;
  providerName: string;
  filename: string;
  content: string;
  mimeType: string;
  rows: number;
  format: ReplenishmentCsvFormat;
  separator: ReplenishmentCsvSeparator;
}

interface BestOffer {
  id: string;
  externalSku: string;
  externalEan: string | null;
  externalName: string | null;
  lastKnownPrice: Prisma.Decimal | null;
  lastKnownStock: Prisma.Decimal | null;
  lastSyncAt: Date | null;
  provider: {
    id: string;
    name: string;
    configJson: Prisma.JsonValue | null;
    leadTimeDays: number | null;
    lastSyncAt: Date | null;
  };
}

interface ReplenishmentItemAccumulator extends Omit<ReplenishmentItem, 'reasons' | 'orderRefs' | 'shortfall' | 'value'> {
  reasons: Set<'ORDER' | 'LOW_STOCK'>;
  orderRefs: Set<string>;
}

interface ReplenishmentProviderAccumulator {
  providerId: string;
  providerName: string;
  providerEmail: string | null;
  providerLeadTimeDays: number | null;
  providerLastSyncAt: Date | null;
  items: Map<string, ReplenishmentItemAccumulator>;
}

type ReservationIssue = {
  orderItemId?: string;
  sku?: string;
  productName?: string;
  requestedQuantity?: number;
  reservedQuantity?: number;
  warehouseProductId?: string;
  status?: string;
  message?: string;
};

type LowStockProductRow = {
  id: string;
  sku: string;
  name: string;
  unit: string;
  currentStock: Prisma.Decimal;
  reorderPoint: Prisma.Decimal | null;
  reorderQuantity: Prisma.Decimal | null;
};

type LowStockCountRow = {
  count: number | bigint;
};

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

function normalizeSource(source?: ReplenishmentSource) {
  if (source === undefined) return 'order';
  if (!['order', 'low', 'all'].includes(source)) throw new Error('Nieprawidłowe źródło listy do zamówienia');
  return source;
}

function normalizeLowStockThreshold(value?: number) {
  if (value === undefined) return 1;
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('lowStockThreshold musi być liczbą nieujemną');
  return threshold;
}

function normalizePage(value?: number) {
  if (value === undefined) return 1;
  const page = Number(value);
  if (!Number.isInteger(page) || page < 1) throw new Error('page musi być liczbą całkowitą większą od 0');
  return page;
}

function normalizeLimit(value?: number) {
  if (value === undefined) return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit musi być liczbą całkowitą od 1 do 200');
  return limit;
}

function normalizeCsvFormat(format?: ReplenishmentCsvFormat) {
  if (format === undefined) return 'full';
  if (!['ean', 'symbol', 'full'].includes(format)) throw new Error('Nieprawidłowy format CSV');
  return format;
}

function normalizeCsvSeparator(separator?: ReplenishmentCsvInput['separator']): ReplenishmentCsvSeparator {
  if (separator === undefined || separator === 'semicolon' || separator === ';') return ';';
  if (separator === 'comma' || separator === ',') return ',';
  if (separator === 'tab' || separator === '\t') return '\t';
  throw new Error('Nieprawidłowy separator CSV');
}

function toNumber(value: Prisma.Decimal | number | string | null | undefined) {
  return Number(value ?? 0);
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function extractProviderEmail(configJson: Prisma.JsonValue | null | undefined) {
  if (!configJson || typeof configJson !== 'object' || Array.isArray(configJson)) return null;
  const config = configJson as Record<string, unknown>;
  const value = config.email ?? config.orderEmail ?? config.contactEmail;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function providerFromOffer(offer: BestOffer): ReplenishmentProviderAccumulator {
  return {
    providerId: offer.provider.id,
    providerName: offer.provider.name,
    providerEmail: extractProviderEmail(offer.provider.configJson),
    providerLeadTimeDays: offer.provider.leadTimeDays,
    providerLastSyncAt: offer.provider.lastSyncAt ?? null,
    items: new Map(),
  };
}

function ensureProvider(
  providers: Map<string, ReplenishmentProviderAccumulator>,
  offer: BestOffer,
) {
  const existing = providers.get(offer.provider.id);
  if (existing) {
    if (!existing.providerLastSyncAt || (offer.provider.lastSyncAt && offer.provider.lastSyncAt > existing.providerLastSyncAt)) {
      existing.providerLastSyncAt = offer.provider.lastSyncAt ?? existing.providerLastSyncAt;
    }
    return existing;
  }

  const provider = providerFromOffer(offer);
  providers.set(provider.providerId, provider);
  return provider;
}

function addReplenishmentItem(
  providers: Map<string, ReplenishmentProviderAccumulator>,
  offer: BestOffer,
  product: { id: string; sku: string; name: string; unit: string },
  quantity: number,
  reason: 'ORDER' | 'LOW_STOCK',
  options: {
    orderRef?: string | null;
    currentStock?: number;
    lowStockThreshold?: number;
    reorderPoint?: number | null;
    orderMultiple?: number | null;
    orderMultipleSource?: 'PRODUCT' | 'BARCODE' | 'NONE';
  } = {},
) {
  if (quantity <= 0) return;

  const provider = ensureProvider(providers, offer);
  const existing = provider.items.get(product.id);
  if (existing) {
    existing.quantity = roundQuantity(existing.quantity + quantity);
    existing.reasons.add(reason);
    if (options.orderRef) existing.orderRefs.add(options.orderRef);
    if (options.currentStock !== undefined) existing.currentStock = options.currentStock;
    if (options.lowStockThreshold !== undefined) existing.lowStockThreshold = options.lowStockThreshold;
    if (options.reorderPoint !== undefined) existing.reorderPoint = options.reorderPoint;
    if (options.orderMultiple !== undefined) existing.orderMultiple = options.orderMultiple;
    if (options.orderMultipleSource !== undefined) existing.orderMultipleSource = options.orderMultipleSource;
    return;
  }

  provider.items.set(product.id, {
    id: `${offer.provider.id}:${product.id}`,
    productId: product.id,
    sku: product.sku,
    name: product.name,
    unit: product.unit,
    quantity: roundQuantity(quantity),
    supplierSku: offer.externalSku,
    ean: offer.externalEan,
    supplierName: offer.externalName,
    unitPrice: offer.lastKnownPrice === null ? null : toNumber(offer.lastKnownPrice),
    supplierStock: toNumber(offer.lastKnownStock),
    currentStock: options.currentStock,
    lowStockThreshold: options.lowStockThreshold,
    reorderPoint: options.reorderPoint,
    orderMultiple: options.orderMultiple,
    orderMultipleSource: options.orderMultipleSource,
    reasons: new Set([reason]),
    orderRefs: new Set(options.orderRef ? [options.orderRef] : []),
  });
}

function roundQuantity(value: number) {
  return Math.round(value * 1000) / 1000;
}

function roundUpToMultiple(quantity: number, multiple: number | null | undefined) {
  if (!multiple || multiple <= 0) return roundQuantity(quantity);
  return roundQuantity(Math.ceil(quantity / multiple) * multiple);
}

async function loadProductOrderMultiples(tenantId: string, productIds: string[]) {
  const rows = productIds.length > 0
    ? await prisma.warehouseProductBarcode.findMany({
        where: {
          tenantId,
          warehouseProductId: { in: productIds },
          isActive: true,
          quantityMultiplier: { gt: 1 },
        },
        select: {
          warehouseProductId: true,
          quantityMultiplier: true,
        },
      })
    : [];

  const multiples = new Map<string, number>();
  for (const row of rows) {
    const multiplier = toNumber(row.quantityMultiplier);
    if (multiplier <= 1) continue;

    const current = multiples.get(row.warehouseProductId);
    if (current === undefined || multiplier < current) {
      multiples.set(row.warehouseProductId, multiplier);
    }
  }

  return multiples;
}

function productOrderMultiple(product: LowStockProductRow, barcodeMultiples: Map<string, number>) {
  const configured = product.reorderQuantity === null ? null : toNumber(product.reorderQuantity);
  if (configured !== null && configured > 0) {
    return { quantity: configured, source: 'PRODUCT' as const };
  }

  const barcodeMultiple = barcodeMultiples.get(product.id) ?? null;
  if (barcodeMultiple !== null && barcodeMultiple > 1) {
    return { quantity: barcodeMultiple, source: 'BARCODE' as const };
  }

  return { quantity: null, source: 'NONE' as const };
}

async function loadBestOffersForProducts(tenantId: string, productIds: string[], providerId?: string) {
  const uniqueProductIds = Array.from(new Set(productIds.filter(Boolean)));
  if (uniqueProductIds.length === 0) {
    return new Map<string, BestOffer>();
  }

  const offers = await prisma.wholesaleProductMapping.findMany({
    where: {
      tenantId,
      warehouseProductId: { in: uniqueProductIds },
      isActive: true,
      lastKnownStock: { gt: 0 },
      ...(providerId ? { providerId } : {}),
      provider: { isActive: true },
    },
    select: {
      id: true,
      warehouseProductId: true,
      externalSku: true,
      externalEan: true,
      externalName: true,
      lastKnownPrice: true,
      lastKnownStock: true,
      lastSyncAt: true,
      provider: {
        select: {
          id: true,
          name: true,
          configJson: true,
          leadTimeDays: true,
          lastSyncAt: true,
        },
      },
    },
  });

  offers.sort((a, b) => {
    const priceA = a.lastKnownPrice === null ? Number.POSITIVE_INFINITY : toNumber(a.lastKnownPrice);
    const priceB = b.lastKnownPrice === null ? Number.POSITIVE_INFINITY : toNumber(b.lastKnownPrice);
    if (priceA !== priceB) return priceA - priceB;
    return (b.lastSyncAt?.getTime() ?? 0) - (a.lastSyncAt?.getTime() ?? 0);
  });

  const bestByProductId = new Map<string, BestOffer>();
  for (const offer of offers) {
    if (!offer.warehouseProductId || bestByProductId.has(offer.warehouseProductId)) continue;
    const { warehouseProductId, ...bestOffer } = offer;
    bestByProductId.set(warehouseProductId, bestOffer);
  }

  return bestByProductId;
}

async function getOrderReplenishment(
  tenantId: string,
  providers: Map<string, ReplenishmentProviderAccumulator>,
  uncovered: ReplenishmentUncoveredItem[],
  providerId?: string,
) {
  const reservations = await prisma.warehouseReservation.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      source: 'WHOLESALE_BACKORDER',
      order: {
        operationalStatus: { in: STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES },
      },
    },
    include: {
      warehouseProduct: {
        select: { id: true, sku: true, name: true, unit: true },
      },
      order: {
        select: { id: true, orderReference: true, externalOrderId: true },
      },
      orderItem: {
        select: { id: true, sku: true, productNameSnapshot: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const offersByProductId = await loadBestOffersForProducts(
    tenantId,
    reservations.map((reservation) => reservation.warehouseProductId),
    providerId,
  );

  for (const reservation of reservations) {
    const offer = offersByProductId.get(reservation.warehouseProductId);
    const orderRef = reservation.order.orderReference || reservation.order.externalOrderId || null;
    const quantity = toNumber(reservation.quantity);

    if (!offer) {
      if (!providerId) {
        uncovered.push({
          id: `reservation:${reservation.id}`,
          sku: reservation.orderItem?.sku ?? reservation.warehouseProduct.sku,
          name: reservation.orderItem?.productNameSnapshot ?? reservation.warehouseProduct.name,
          quantity,
          orderRef,
          orderItemId: reservation.orderItemId,
          warehouseProductId: reservation.warehouseProductId,
          cause: 'MISSING_STOCK',
          message: 'Brak aktywnej oferty hurtowni ze stanem dla aktywnej rezerwacji',
        });
      }
      continue;
    }

    addReplenishmentItem(
      providers,
      offer,
      reservation.warehouseProduct,
      quantity,
      'ORDER',
      { orderRef },
    );
  }

  const wholesaleOrderItems = await prisma.orderItem.findMany({
    where: {
      warehouseProductId: { not: null },
      shippingSource: 'WHOLESALE_BACKORDER',
      order: {
        shop: { tenantId },
        operationalStatus: { in: STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES },
      },
    },
    select: {
      id: true,
      sku: true,
      productNameSnapshot: true,
      quantity: true,
      warehouseProductId: true,
      warehouseProduct: {
        select: { id: true, sku: true, name: true, unit: true },
      },
      order: {
        select: { id: true, orderReference: true, externalOrderId: true },
      },
      warehouseReservations: {
        where: {
          status: { in: ['ACTIVE', 'CONSUMED'] },
        },
        select: {
          warehouseProductId: true,
          quantity: true,
          status: true,
          source: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const shortfallItems = wholesaleOrderItems
    .map((item) => {
      const coveredQuantity = item.warehouseReservations.reduce((sum, reservation) => {
        if (reservation.warehouseProductId !== item.warehouseProductId) return sum;
        if (reservation.status === 'ACTIVE') return sum + toNumber(reservation.quantity);
        if (reservation.status === 'CONSUMED') return sum + toNumber(reservation.quantity);
        return sum;
      }, 0);
      return {
        item,
        shortfall: roundQuantity(Math.max(0, item.quantity - coveredQuantity)),
      };
    })
    .filter(({ item, shortfall }) => item.warehouseProduct && item.warehouseProductId && shortfall > 0);

  const shortfallOffersByProductId = await loadBestOffersForProducts(
    tenantId,
    shortfallItems.map(({ item }) => item.warehouseProductId ?? ''),
    providerId,
  );

  for (const { item, shortfall } of shortfallItems) {
    if (!item.warehouseProduct || !item.warehouseProductId) continue;

    const offer = shortfallOffersByProductId.get(item.warehouseProductId);
    const orderRef = item.order.orderReference || item.order.externalOrderId || null;

    if (!offer) {
      if (!providerId) {
        const alreadyReported = uncovered.some((uncoveredItem) => (
          uncoveredItem.orderItemId === item.id &&
          uncoveredItem.warehouseProductId === item.warehouseProductId &&
          uncoveredItem.cause === 'MISSING_STOCK'
        ));

        if (!alreadyReported) {
          uncovered.push({
            id: `order-item-shortfall:${item.id}`,
            sku: item.sku,
            name: item.productNameSnapshot,
            quantity: shortfall,
            orderRef,
            orderItemId: item.id,
            warehouseProductId: item.warehouseProductId,
            cause: 'MISSING_STOCK',
            message: 'Brak aktywnej oferty hurtowni dla brakującej części zamówienia',
          });
        }
      }
      continue;
    }

    addReplenishmentItem(
      providers,
      offer,
      item.warehouseProduct,
      shortfall,
      'ORDER',
      { orderRef },
    );
  }
}

async function getLowStockReplenishment(
  tenantId: string,
  providers: Map<string, ReplenishmentProviderAccumulator>,
  lowStockThreshold: number,
  page: number,
  limit: number,
  providerId?: string,
) {
  const effectiveDefaultThreshold = new Prisma.Decimal(lowStockThreshold);
  const offset = (page - 1) * limit;

  const [countRows, products] = await prisma.$transaction([
    prisma.$queryRaw<LowStockCountRow[]>`
      SELECT COUNT(*)::int AS "count"
      FROM "warehouse_products"
      WHERE "tenant_id" = ${tenantId}
        AND "is_active" = true
        AND "current_stock" < COALESCE("reorder_point", ${effectiveDefaultThreshold})
    `,
    prisma.$queryRaw<LowStockProductRow[]>`
      SELECT
        "id",
        "sku",
        "name",
        "unit",
        "current_stock" AS "currentStock",
        "reorder_point" AS "reorderPoint",
        "reorder_quantity" AS "reorderQuantity"
      FROM "warehouse_products"
      WHERE "tenant_id" = ${tenantId}
        AND "is_active" = true
        AND "current_stock" < COALESCE("reorder_point", ${effectiveDefaultThreshold})
      ORDER BY "current_stock" ASC, "name" ASC
      OFFSET ${offset}
      LIMIT ${limit}
    `,
  ]);
  const total = Number(countRows[0]?.count ?? 0);
  const barcodeMultiples = await loadProductOrderMultiples(tenantId, products.map((product) => product.id));

  const offersByProductId = await loadBestOffersForProducts(
    tenantId,
    products.map((product) => product.id),
    providerId,
  );

  for (const product of products) {
    const offer = offersByProductId.get(product.id);
    if (!offer) continue;

    const currentStock = toNumber(product.currentStock);
    const reorderPoint = product.reorderPoint === null ? null : toNumber(product.reorderPoint);
    const effectiveThreshold = reorderPoint ?? lowStockThreshold;
    const orderMultiple = productOrderMultiple(product, barcodeMultiples);
    const shortage = Math.max(0, effectiveThreshold - currentStock);
    addReplenishmentItem(
      providers,
      offer,
      product,
      roundUpToMultiple(shortage, orderMultiple.quantity),
      'LOW_STOCK',
      {
        currentStock,
        lowStockThreshold: effectiveThreshold,
        reorderPoint,
        orderMultiple: orderMultiple.quantity,
        orderMultipleSource: orderMultiple.source,
      },
    );
  }

  return total;
}

async function getUncoveredFromBlockedWz(tenantId: string) {
  const blockedWz = await prisma.warehouseDocument.findMany({
    where: {
      tenantId,
      type: 'WZ',
      status: 'DRAFT',
      isAutoGenerated: true,
      order: {
        is: {
          operationalStatus: { in: STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES },
        },
      },
    },
    select: {
      id: true,
      metadataJson: true,
      order: { select: { orderReference: true, externalOrderId: true } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const uncovered: ReplenishmentUncoveredItem[] = [];
  const seen = new Set<string>();

  for (const document of blockedWz) {
    const metadata = document.metadataJson;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue;
    const issues = (metadata as Record<string, unknown>).reservationIssues;
    if (!Array.isArray(issues)) continue;

    for (const rawIssue of issues) {
      if (!rawIssue || typeof rawIssue !== 'object' || Array.isArray(rawIssue)) continue;
      const issue = rawIssue as ReservationIssue;
      if (issue.status !== 'MISSING_STOCK' && issue.status !== 'MISSING_MAPPING') continue;

      const key = `${document.id}:${issue.orderItemId ?? issue.sku ?? issue.productName}:${issue.status}`;
      if (seen.has(key)) continue;
      seen.add(key);

      uncovered.push({
        id: key,
        sku: issue.sku ?? '',
        name: issue.productName ?? issue.sku ?? 'Pozycja zamówienia',
        quantity: Math.max(0, Number(issue.requestedQuantity ?? 0) - Number(issue.reservedQuantity ?? 0)) || Number(issue.requestedQuantity ?? 0),
        orderRef: document.order?.orderReference || document.order?.externalOrderId || null,
        orderItemId: issue.orderItemId ?? null,
        warehouseProductId: issue.warehouseProductId ?? null,
        cause: issue.status,
        message: issue.message ?? null,
      });
    }
  }

  return uncovered;
}

function metadataString(metadata: Prisma.JsonValue | null | undefined, key: string) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractOrderRefs(notes: string | null | undefined) {
  if (!notes) return [];
  const match = /Zamówienia:\s*(.+)$/i.exec(notes);
  if (!match) return [];
  return match[1].split(',').map((value) => value.trim()).filter(Boolean);
}

function orderedKey(providerId: string, productId: string) {
  return `${providerId}:${productId}`;
}

async function getActiveWholesaleOrders(tenantId: string, providerId?: string): Promise<ReplenishmentOrderedProviderGroup[]> {
  const documents = await prisma.warehouseDocument.findMany({
    where: {
      tenantId,
      type: 'ZH',
      status: { not: 'CANCELLED' },
    },
    include: {
      items: {
        include: {
          product: {
            select: { id: true, sku: true, name: true, unit: true },
          },
        },
      },
    },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });

  const convertedPzIds = Array.from(new Set(
    documents
      .map((document) => metadataString(document.metadataJson, 'convertedToPzDocumentId'))
      .filter((id): id is string => Boolean(id)),
  ));
  const convertedPzDocuments = convertedPzIds.length > 0
    ? await prisma.warehouseDocument.findMany({
        where: { tenantId, id: { in: convertedPzIds } },
        select: { id: true, status: true },
      })
    : [];
  const convertedPzStatusById = new Map(convertedPzDocuments.map((document) => [document.id, document.status]));
  const providers = new Map<string, ReplenishmentOrderedProviderGroup>();

  for (const document of documents) {
    const metadata = document.metadataJson;
    const documentProviderId = metadataString(metadata, 'providerId');
    if (!documentProviderId) continue;
    if (providerId && documentProviderId !== providerId) continue;

    const linkedPzDocumentId = metadataString(metadata, 'convertedToPzDocumentId');
    if (linkedPzDocumentId && convertedPzStatusById.get(linkedPzDocumentId) === 'CONFIRMED') continue;

    const providerName = metadataString(metadata, 'providerName') ?? 'Dostawca';
    let provider = providers.get(documentProviderId);
    if (!provider) {
      provider = {
        providerId: documentProviderId,
        providerName,
        items: [],
        itemsCount: 0,
        totalQuantity: 0,
        totalValue: 0,
      };
      providers.set(documentProviderId, provider);
    }

    for (const item of document.items) {
      const quantity = toNumber(item.quantity);
      const unitPrice = item.unitPrice === null ? null : toNumber(item.unitPrice);
      const value = unitPrice === null ? 0 : roundMoney(quantity * unitPrice);
      provider.items.push({
        id: `${document.id}:${item.id}`,
        documentId: document.id,
        documentNumber: document.number,
        documentStatus: document.status as 'DRAFT' | 'CONFIRMED',
        date: document.date,
        createdAt: document.createdAt,
        providerId: documentProviderId,
        providerName,
        productId: item.productId,
        sku: item.product.sku,
        name: item.product.name,
        unit: item.product.unit,
        quantity,
        unitPrice,
        value,
        orderRefs: extractOrderRefs(item.notes),
        linkedPzDocumentId,
      });
    }
  }

  return Array.from(providers.values())
    .map((provider) => {
      const items = provider.items.sort((a, b) => a.name.localeCompare(b.name, 'pl'));
      return {
        ...provider,
        items,
        itemsCount: items.length,
        totalQuantity: roundQuantity(items.reduce((sum, item) => sum + item.quantity, 0)),
        totalValue: roundMoney(items.reduce((sum, item) => sum + item.value, 0)),
      };
    })
    .sort((a, b) => a.providerName.localeCompare(b.providerName, 'pl'));
}

function orderedQuantityByProviderProduct(ordered: ReplenishmentOrderedProviderGroup[]) {
  const map = new Map<string, number>();
  for (const provider of ordered) {
    for (const item of provider.items) {
      const key = orderedKey(provider.providerId, item.productId);
      map.set(key, roundQuantity((map.get(key) ?? 0) + item.quantity));
    }
  }
  return map;
}

function subtractOrderedQuantities(
  providers: Map<string, ReplenishmentProviderAccumulator>,
  orderedQuantities: Map<string, number>,
) {
  for (const provider of providers.values()) {
    for (const [productId, item] of Array.from(provider.items.entries())) {
      const orderedQuantity = orderedQuantities.get(orderedKey(provider.providerId, productId)) ?? 0;
      if (orderedQuantity <= 0) continue;

      const nextQuantity = roundQuantity(item.quantity - orderedQuantity);
      if (nextQuantity <= 0) {
        provider.items.delete(productId);
        continue;
      }

      item.quantity = nextQuantity;
    }
  }
}

function finalizeProviders(providers: Map<string, ReplenishmentProviderAccumulator>) {
  return Array.from(providers.values())
    .map((provider) => {
      const items = Array.from(provider.items.values())
        .map((item) => {
          const shortfall = Math.max(0, roundQuantity(item.quantity - item.supplierStock));
          const value = item.unitPrice === null ? 0 : roundMoney(item.quantity * item.unitPrice);

          return {
            ...item,
            shortfall,
            value,
            reasons: Array.from(item.reasons),
            orderRefs: Array.from(item.orderRefs).sort(),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name, 'pl'));

      return {
        providerId: provider.providerId,
        providerName: provider.providerName,
        providerEmail: provider.providerEmail,
        providerLeadTimeDays: provider.providerLeadTimeDays,
        providerLastSyncAt: provider.providerLastSyncAt,
        items,
        itemsCount: items.length,
        totalQuantity: roundQuantity(items.reduce((sum, item) => sum + item.quantity, 0)),
        totalValue: roundMoney(items.reduce((sum, item) => sum + item.value, 0)),
      };
    })
    .sort((a, b) => a.providerName.localeCompare(b.providerName, 'pl'));
}

export async function getReplenishment(query: ReplenishmentQuery = {}): Promise<ReplenishmentResponse> {
  const tenantId = requireTenantId();
  const source = normalizeSource(query.source);
  const lowStockThreshold = normalizeLowStockThreshold(query.lowStockThreshold);
  const lowStockPage = normalizePage(query.page);
  const lowStockLimit = normalizeLimit(query.limit);
  const providers = new Map<string, ReplenishmentProviderAccumulator>();
  const uncovered = source === 'low' || query.providerId ? [] : await getUncoveredFromBlockedWz(tenantId);
  const ordered = await getActiveWholesaleOrders(tenantId, query.providerId);
  let lowStockTotal = 0;

  if (source === 'order' || source === 'all') {
    await getOrderReplenishment(tenantId, providers, uncovered, query.providerId);
  }

  if (source === 'low' || source === 'all') {
    lowStockTotal = await getLowStockReplenishment(tenantId, providers, lowStockThreshold, lowStockPage, lowStockLimit, query.providerId);
  }

  subtractOrderedQuantities(providers, orderedQuantityByProviderProduct(ordered));

  const providerGroups = finalizeProviders(providers);
  const allItems = providerGroups.flatMap((provider) => provider.items);
  const orderedItems = ordered.flatMap((provider) => provider.items);
  const latestWholesaleSyncAt = providerGroups.reduce<Date | null>((latest, provider) => {
    if (!provider.providerLastSyncAt) return latest;
    if (!latest || provider.providerLastSyncAt > latest) return provider.providerLastSyncAt;
    return latest;
  }, null);

  return {
    providers: providerGroups,
    ordered,
    uncovered,
    pagination: source === 'low' || source === 'all'
      ? {
          source: 'low',
          page: lowStockPage,
          limit: lowStockLimit,
          total: lowStockTotal,
          totalPages: Math.max(1, Math.ceil(lowStockTotal / lowStockLimit)),
        }
      : null,
    summary: {
      items: allItems.length,
      orderItems: allItems.filter((item) => item.reasons.includes('ORDER')).length,
      lowStockItems: source === 'low' || source === 'all'
        ? lowStockTotal
        : allItems.filter((item) => item.reasons.includes('LOW_STOCK')).length,
      providers: providerGroups.length,
      quantity: roundQuantity(allItems.reduce((sum, item) => sum + item.quantity, 0)),
      value: roundMoney(providerGroups.reduce((sum, provider) => sum + provider.totalValue, 0)),
      orderedItems: orderedItems.length,
      orderedQuantity: roundQuantity(orderedItems.reduce((sum, item) => sum + item.quantity, 0)),
      uncovered: uncovered.length,
      latestWholesaleSyncAt,
      lowStockThreshold,
    },
  };
}

export async function recalculateWholesaleBackorderReservations(): Promise<ReplenishmentRecalculateResult> {
  const tenantId = requireTenantId();
  const reservations = await prisma.warehouseReservation.findMany({
    where: {
      tenantId,
      status: 'ACTIVE',
      source: 'WHOLESALE_BACKORDER',
      order: {
        operationalStatus: { in: STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES },
      },
    },
    select: {
      orderId: true,
      order: {
        select: {
          orderReference: true,
          externalOrderId: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const orders = new Map<string, { orderId: string; orderRef: string | null }>();
  for (const reservation of reservations) {
    if (orders.has(reservation.orderId)) continue;
    orders.set(reservation.orderId, {
      orderId: reservation.orderId,
      orderRef: reservation.order.orderReference || reservation.order.externalOrderId || null,
    });
  }

  const summary: ReplenishmentRecalculateResult = {
    totalReservations: reservations.length,
    totalOrders: orders.size,
    processedOrders: 0,
    changedOrders: 0,
    failedOrders: 0,
    reserved: 0,
    unchanged: 0,
    updated: 0,
    partial: 0,
    missingMapping: 0,
    missingStock: 0,
    orderResults: [],
    failures: [],
  };

  for (const order of orders.values()) {
    try {
      const result = await reserveOrder(order.orderId);
      summary.processedOrders++;
      summary.reserved += result.reserved;
      summary.unchanged += result.unchanged;
      summary.updated += result.updated;
      summary.partial += result.partial;
      summary.missingMapping += result.missingMapping;
      summary.missingStock += result.missingStock;
      if (result.reserved > 0 || result.updated > 0 || result.partial > 0) {
        summary.changedOrders++;
      }
      summary.orderResults.push({
        orderId: order.orderId,
        orderRef: order.orderRef,
        reserved: result.reserved,
        unchanged: result.unchanged,
        updated: result.updated,
        partial: result.partial,
        missingMapping: result.missingMapping,
        missingStock: result.missingStock,
      });
    } catch (error) {
      summary.failedOrders++;
      summary.failures.push({
        orderId: order.orderId,
        orderRef: order.orderRef,
        message: error instanceof Error ? error.message : 'Nieznany błąd przeliczania rezerwacji',
      });
    }
  }

  return summary;
}

function applyQuantityOverrides(items: ReplenishmentItem[], overrides?: ReplenishmentQuantityOverride[]) {
  if (!overrides || overrides.length === 0) return items;
  const quantityByProductId = new Map(
    overrides
      .filter((item) => item.productId && Number.isFinite(Number(item.quantity)))
      .map((item) => [item.productId, Number(item.quantity)]),
  );

  return items
    .filter((item) => !quantityByProductId.has(item.productId) || Number(quantityByProductId.get(item.productId)) > 0)
    .map((item) => {
      const quantity = quantityByProductId.get(item.productId);
      if (quantity === undefined) return item;
      return {
        ...item,
        quantity: roundQuantity(quantity),
        shortfall: Math.max(0, roundQuantity(quantity - item.supplierStock)),
        value: item.unitPrice === null ? 0 : roundMoney(quantity * item.unitPrice),
      };
    });
}

function getProviderOrThrow(response: ReplenishmentResponse, providerId: string) {
  const provider = response.providers.find((entry) => entry.providerId === providerId);
  if (!provider) throw new Error('Brak pozycji do zamówienia dla wybranego dostawcy');
  return provider;
}

function formatQuantity(value: number) {
  if (Number.isInteger(value)) return String(value);
  return String(value).replace('.', ',');
}

function formatPrice(value: number | null) {
  if (value === null) return '';
  return value.toFixed(2).replace('.', ',');
}

function csvEscape(value: string | number | null | undefined, separator: ReplenishmentCsvSeparator) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!text.includes(separator) && !text.includes('"') && !text.includes('\n') && !text.includes('\r')) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsvRows(items: ReplenishmentItem[], format: ReplenishmentCsvFormat) {
  if (format === 'ean') {
    return {
      header: ['EAN', 'Ilosc'],
      rows: items.map((item) => [item.ean ?? '', formatQuantity(item.quantity)]),
    };
  }

  if (format === 'symbol') {
    return {
      header: ['Symbol', 'Ilosc'],
      rows: items.map((item) => [item.supplierSku ?? '', formatQuantity(item.quantity)]),
    };
  }

  return {
    header: ['EAN', 'Symbol', 'Nazwa', 'Ilosc', 'Cena_netto'],
    rows: items.map((item) => [
      item.ean ?? '',
      item.supplierSku ?? '',
      item.name,
      formatQuantity(item.quantity),
      formatPrice(item.unitPrice),
    ]),
  };
}

function slugify(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'dostawca';
}

function todayFileDate() {
  const date = new Date();
  return date.toISOString().slice(0, 10);
}

export async function buildReplenishmentCsv(providerId: string, input: ReplenishmentCsvInput = {}): Promise<ReplenishmentCsvResult> {
  const format = normalizeCsvFormat(input.format);
  const separator = normalizeCsvSeparator(input.separator);
  const includeHeader = input.includeHeader !== false;
  const response = await getReplenishment({ ...input, providerId });
  const provider = getProviderOrThrow(response, providerId);
  const items = applyQuantityOverrides(provider.items, input.items);
  const csvRows = buildCsvRows(items, format);
  const rows = [
    ...(includeHeader ? [csvRows.header] : []),
    ...csvRows.rows,
  ];
  const content = `\uFEFF${rows.map((row) => row.map((cell) => csvEscape(cell, separator)).join(separator)).join('\n')}\n`;

  return {
    providerId,
    providerName: provider.providerName,
    filename: `zamowienie-${slugify(provider.providerName)}-${todayFileDate()}.csv`,
    content,
    mimeType: 'text/csv;charset=utf-8',
    rows: items.length,
    format,
    separator,
  };
}

export async function createWholesaleOrderFromReplenishment(providerId: string, input: CreateReplenishmentOrderInput = {}) {
  const response = await getReplenishment({ ...input, providerId });
  const provider = getProviderOrThrow(response, providerId);
  const items = applyQuantityOverrides(provider.items, input.items);

  if (items.length === 0) throw new Error('Brak pozycji do utworzenia zamówienia hurtowego');

  return createDocument({
    type: 'ZH',
    description: `Zamówienie hurtowe - ${provider.providerName}`,
    metadataJson: {
      source: 'WAREHOUSE_REPLENISHMENT',
      providerId,
      providerName: provider.providerName,
      replenishmentSource: normalizeSource(input.source),
    },
    items: items.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: item.unitPrice ?? undefined,
      notes: [
        `Zamówienie hurtowe - ${provider.providerName}`,
        item.orderRefs.length > 0 ? `Zamówienia: ${item.orderRefs.join(', ')}` : null,
      ].filter(Boolean).join('. '),
    })),
  });
}

export async function createDraftPzFromReplenishment(providerId: string, input: CreateReplenishmentOrderInput = {}) {
  return createWholesaleOrderFromReplenishment(providerId, input);
}
