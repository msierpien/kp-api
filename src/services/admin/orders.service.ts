import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import type { CreateManualOrderInput, OrdersCountsQueryInput, OrdersListQueryInput } from '../../schemas/admin.schema';
import type { ManualOrderResponse, PaginatedResponse } from '../../types';
import { generateAccessToken } from '../../lib/token';
import { config } from '../../config';
import { emailService } from '../email/email.service';
import { queuePersonalizationEmail } from '../queue/email.queue';
import { FEATURE_PERSONALIZATION_EDITOR, tenantHasFeature } from '../../lib/features';
import { releaseOrderReservations, reserveOrder } from './warehouse-reservations.service';
import { getTenantId } from '../../lib/tenant-context';
import {
  ACTIVE_ORDER_OPERATIONAL_STATUSES,
  INACTIVE_ORDER_OPERATIONAL_STATUSES,
  ORDER_OPERATIONAL_STATUSES,
  RETURN_ORDER_OPERATIONAL_STATUSES,
  normalizeOrderOperationalStatus,
} from '../../lib/order-statuses';

export type OrderPaymentFilter = 'all' | 'paid' | 'unpaid' | '';
export type OrderInvoiceFilter = 'all' | 'issued' | 'missing' | '';
export type OrderPersonalizationFilter = 'all' | 'required' | 'waiting' | 'ready' | '';

export interface OrderListItem {
  id: string;
  shopId: string;
  externalOrderId: string;
  orderReference: string;
  customerEmail: string;
  customerName: string | null;
  customerPhone: string | null;
  currency: string;
  totalPaid: number;
  paymentStatus: 'paid' | 'unpaid' | 'unknown';
  paymentMethod: string | null;
  operationalStatus: string;
  externalStatusId: string | null;
  externalStatusName: string | null;
  statusSyncedAt: Date | null;
  statusSyncError: string | null;
  createdAtShop: Date;
  syncedAt: Date;
  maxShippingDate: Date | null;
  shippingPromiseLabel: string | null;
  shop: {
    id: string;
    name: string;
    platform: string;
  };
  itemsCount: number;
  itemsReadiness: {
    ready: number;
    total: number;
  };
  personalizationSummary: {
    total: number;
    waiting: number;
    submitted: number;
    ready: number;
  };
  invoice: {
    status: string | null;
    number: string | null;
    issuedAt: Date | null;
    sentAt: Date | null;
  };
}

export interface OrderCountsResponse {
  active: number;
  inactive: number;
  total: number;
  statuses: Record<string, number>;
  groups: {
    allActive: number;
    cancelled: number;
    returned: number;
  };
}

function normalizeSku(value: string): string {
  return value.trim();
}

function tenantOrderWhere(): Prisma.OrderWhereInput {
  const tenantId = getTenantId();
  return tenantId ? { shop: { tenantId } } : {};
}

function blankToUndefined(value?: string | null) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : undefined;
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseDateOnly(value?: string | null, endOfDay = false) {
  const text = blankToUndefined(value);
  if (!text) return null;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

function dateRangeFromPreset(preset?: string | null) {
  const now = new Date();
  if (preset === '7d') return { gte: startOfDay(addDays(now, -7)) };
  if (preset === '30d') return { gte: startOfDay(addDays(now, -30)) };
  if (preset === '90d') return { gte: startOfDay(addDays(now, -90)) };
  return {};
}

function normalizeStatusForStorage(value: string) {
  return normalizeOrderOperationalStatus(value) ?? 'NEW';
}

function statusWhere(query: Pick<OrdersListQueryInput, 'operationalStatus' | 'statusGroup'>): Prisma.OrderWhereInput {
  if (query.operationalStatus) return { operationalStatus: query.operationalStatus };
  if (query.statusGroup === 'active') return { operationalStatus: { in: ACTIVE_ORDER_OPERATIONAL_STATUSES } };
  if (query.statusGroup === 'cancelled') return { operationalStatus: 'CANCELLED' };
  if (query.statusGroup === 'returned') return { operationalStatus: { in: RETURN_ORDER_OPERATIONAL_STATUSES } };
  return {};
}

function buildOrderWhere(
  query: Partial<OrdersListQueryInput | OrdersCountsQueryInput>,
  options: { includeStatus?: boolean } = {},
): Prisma.OrderWhereInput {
  const includeStatus = options.includeStatus ?? true;
  const where: Prisma.OrderWhereInput = {
    ...tenantOrderWhere(),
    ...(includeStatus ? statusWhere(query as OrdersListQueryInput) : {}),
  };

  const q = blankToUndefined((query as OrdersListQueryInput).q);
  if (q) {
    where.OR = [
      { orderReference: { contains: q, mode: 'insensitive' } },
      { externalOrderId: { contains: q, mode: 'insensitive' } },
      { customerEmail: { contains: q, mode: 'insensitive' } },
      { customerName: { contains: q, mode: 'insensitive' } },
      { items: { some: { sku: { contains: q, mode: 'insensitive' } } } },
      { items: { some: { productNameSnapshot: { contains: q, mode: 'insensitive' } } } },
    ];
  }

  const shopId = blankToUndefined((query as OrdersListQueryInput).shopId);
  if (shopId) where.shopId = shopId;

  const payment = (query as OrdersListQueryInput).payment;
  if (payment === 'paid') {
    where.operationalStatus = { in: ACTIVE_ORDER_OPERATIONAL_STATUSES.filter((status) => status !== 'NEW') };
  } else if (payment === 'unpaid') {
    where.operationalStatus = 'NEW';
  }

  const invoice = (query as OrdersListQueryInput).invoice;
  if (invoice === 'issued') {
    where.salesDocuments = {
      some: {
        documentType: 'INVOICE',
        status: { in: ['ISSUED', 'SENT'] },
      },
    };
  } else if (invoice === 'missing') {
    where.salesDocuments = {
      none: {
        documentType: 'INVOICE',
        status: { in: ['ISSUED', 'SENT'] },
      },
    };
  }

  const personalization = (query as OrdersListQueryInput).personalization;
  if (personalization === 'required') {
    where.items = { some: { personalizationCase: { isNot: null } } };
  } else if (personalization === 'waiting') {
    where.items = { some: { personalizationCase: { is: { status: 'WAITING_FOR_CUSTOMER' } } } };
  } else if (personalization === 'ready') {
    where.items = { some: { personalizationCase: { is: { status: { in: ['SUBMITTED', 'READY_FOR_PRINT'] } } } } };
  }

  const presetRange = dateRangeFromPreset((query as OrdersListQueryInput).datePreset);
  const dateFrom = parseDateOnly((query as OrdersListQueryInput).dateFrom);
  const dateTo = parseDateOnly((query as OrdersListQueryInput).dateTo, true);
  const createdAtShop: Prisma.DateTimeFilter = { ...presetRange };
  if (dateFrom) createdAtShop.gte = dateFrom;
  if (dateTo) createdAtShop.lte = dateTo;
  if (Object.keys(createdAtShop).length > 0) where.createdAtShop = createdAtShop;

  const shipBy = (query as OrdersListQueryInput).shipBy;
  if (shipBy) {
    const today = startOfDay(new Date());
    const tomorrow = addDays(today, 1);
    const afterTomorrow = addDays(today, 2);
    if (shipBy === 'overdue') {
      where.maxShippingDate = { lt: today };
      where.operationalStatus = { notIn: ['SHIPPED', 'DELIVERED', ...INACTIVE_ORDER_OPERATIONAL_STATUSES] };
    } else if (shipBy === 'today') {
      where.maxShippingDate = { gte: today, lt: tomorrow };
    } else if (shipBy === 'tomorrow') {
      where.maxShippingDate = { gte: tomorrow, lt: afterTomorrow };
    } else if (shipBy === 'future') {
      where.maxShippingDate = { gte: afterTomorrow };
    } else if (shipBy === 'shipped') {
      where.operationalStatus = { in: ['SHIPPED', 'DELIVERED'] };
    }
  }

  return where;
}

function orderByForList(query: OrdersListQueryInput): Prisma.OrderOrderByWithRelationInput {
  const direction = query.sortOrder;
  if (query.sortBy === 'totalPaid') return { totalPaid: direction };
  if (query.sortBy === 'maxShippingDate') return { maxShippingDate: direction };
  if (query.sortBy === 'orderReference') return { orderReference: direction };
  return { createdAtShop: direction };
}

function paymentStatusForOrder(statusValue: string): OrderListItem['paymentStatus'] {
  const status = normalizeOrderOperationalStatus(statusValue);
  if (!status) return 'unknown';
  if (status === 'NEW') return 'unpaid';
  if (status === 'CANCELLED') return 'unknown';
  return 'paid';
}

export async function getOrdersList(query: OrdersListQueryInput): Promise<PaginatedResponse<OrderListItem>> {
  const skip = (query.page - 1) * query.limit;
  const where = buildOrderWhere(query);

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take: query.limit,
      orderBy: orderByForList(query),
      select: {
        id: true,
        shopId: true,
        externalOrderId: true,
        orderReference: true,
        customerEmail: true,
        customerName: true,
        billingAddressJson: true,
        deliveryAddressJson: true,
        currency: true,
        totalPaid: true,
        paymentMethod: true,
        operationalStatus: true,
        externalStatusId: true,
        externalStatusName: true,
        statusSyncedAt: true,
        statusSyncError: true,
        createdAtShop: true,
        syncedAt: true,
        maxShippingDate: true,
        shippingPromiseLabel: true,
        shop: {
          select: {
            id: true,
            name: true,
            platform: true,
          },
        },
        _count: {
          select: { items: true },
        },
        items: {
          select: {
            quantity: true,
            warehouseProductId: true,
            shippingSource: true,
            warehouseReservations: {
              where: { status: { in: ['ACTIVE', 'CONSUMED'] } },
              select: { quantity: true, source: true },
            },
            personalizationCase: {
              select: { status: true },
            },
          },
        },
        salesDocuments: {
          where: { documentType: 'INVOICE' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            status: true,
            externalNumber: true,
            externalId: true,
            issuedAt: true,
            sentAt: true,
          },
        },
      },
    }),
    prisma.order.count({ where }),
  ]);

  const data = orders.map((order): OrderListItem => {
    const cases = order.items
      .map((item) => item.personalizationCase)
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    const invoice = order.salesDocuments[0] ?? null;
    const addressValue = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const readPhone = (value: unknown) => {
      const address = addressValue(value);
      for (const key of ['phone_mobile', 'phoneMobile', 'phone']) {
        const phone = address?.[key];
        if (typeof phone === 'string' && phone.trim()) return phone.trim();
      }
      return null;
    };
    const readyItems = order.items.filter((item) => {
      if (!item.warehouseProductId) return false;
      const reserved = item.warehouseReservations
        .filter((reservation) => reservation.source === 'LOCAL_STOCK')
        .reduce((sum, reservation) => sum + Number(reservation.quantity), 0);
      return reserved >= item.quantity;
    }).length;

    return {
      id: order.id,
      shopId: order.shopId,
      externalOrderId: order.externalOrderId,
      orderReference: order.orderReference,
      customerEmail: order.customerEmail,
      customerName: order.customerName,
      customerPhone: readPhone(order.deliveryAddressJson) ?? readPhone(order.billingAddressJson),
      currency: order.currency,
      totalPaid: Number(order.totalPaid),
      paymentStatus: paymentStatusForOrder(order.operationalStatus),
      paymentMethod: order.paymentMethod,
      operationalStatus: normalizeStatusForStorage(order.operationalStatus),
      externalStatusId: order.externalStatusId,
      externalStatusName: order.externalStatusName,
      statusSyncedAt: order.statusSyncedAt,
      statusSyncError: order.statusSyncError,
      createdAtShop: order.createdAtShop,
      syncedAt: order.syncedAt,
      maxShippingDate: order.maxShippingDate,
      shippingPromiseLabel: order.shippingPromiseLabel,
      shop: order.shop,
      itemsCount: order._count.items,
      itemsReadiness: { ready: readyItems, total: order._count.items },
      personalizationSummary: {
        total: cases.length,
        waiting: cases.filter((item) => item.status === 'WAITING_FOR_CUSTOMER').length,
        submitted: cases.filter((item) => item.status === 'SUBMITTED').length,
        ready: cases.filter((item) => item.status === 'READY_FOR_PRINT').length,
      },
      invoice: {
        status: invoice?.status ?? null,
        number: invoice?.externalNumber ?? invoice?.externalId ?? null,
        issuedAt: invoice?.issuedAt ?? null,
        sentAt: invoice?.sentAt ?? null,
      },
    };
  });

  return {
    data,
    total,
    page: query.page,
    limit: query.limit,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}

export async function getOrderCounts(query: OrdersCountsQueryInput): Promise<OrderCountsResponse> {
  const where = buildOrderWhere(query, { includeStatus: false });
  const grouped = await prisma.order.groupBy({
    by: ['operationalStatus'],
    where,
    _count: { _all: true },
  });

  const statuses = Object.fromEntries(ORDER_OPERATIONAL_STATUSES.map((status) => [status, 0])) as Record<string, number>;

  for (const row of grouped) {
    const status = normalizeStatusForStorage(row.operationalStatus);
    statuses[status] = (statuses[status] ?? 0) + row._count._all;
  }

  const active = ACTIVE_ORDER_OPERATIONAL_STATUSES.reduce((total, status) => total + (statuses[status] ?? 0), 0);
  const cancelled = statuses.CANCELLED ?? 0;
  const returned = RETURN_ORDER_OPERATIONAL_STATUSES.reduce((total, status) => total + (statuses[status] ?? 0), 0);
  const inactive = cancelled + returned;

  return {
    active,
    inactive,
    total: active + inactive,
    statuses,
    groups: {
      allActive: active,
      cancelled,
      returned,
    },
  };
}

/**
 * Tworzy ręczne zamówienie (dla platform MANUAL - FB, Instagram, email itp.)
 */
export async function createManualOrder(data: CreateManualOrderInput): Promise<ManualOrderResponse> {
  const manualCasesCreated: Array<{
    id: string;
    token: string;
    orderReference: string;
    customerEmail: string;
    customerName: string;
    shopName: string;
    productName: string;
    quantity: number;
  }> = [];

  // Walidacja: czy sklep istnieje i jest typu MANUAL
  const shop = await prisma.shop.findUnique({
    where: { id: data.shopId },
  });

  if (!shop) {
    throw new Error('Sklep nie istnieje');
  }

  if (shop.platform !== 'MANUAL') {
    throw new Error('Można tworzyć ręczne zamówienia tylko dla sklepów typu MANUAL');
  }

  const personalizationEnabledForTenant = await tenantHasFeature(shop.tenantId, FEATURE_PERSONALIZATION_EDITOR);

  // Sprawdź czy order reference już nie istnieje dla tego sklepu
  const existingOrder = await prisma.order.findUnique({
    where: {
      shopId_externalOrderId: {
        shopId: data.shopId,
        externalOrderId: data.orderReference,
      },
    },
  });

  if (existingOrder) {
    throw new Error(`Zamówienie ${data.orderReference} już istnieje dla tego sklepu`);
  }

  const createdAtShop = data.createdAtShop ? new Date(data.createdAtShop) : new Date();

  // Utwórz zamówienie z pozycjami w transakcji
  const order = await prisma.$transaction(async (tx) => {
    // Utwórz zamówienie
    const newOrder = await tx.order.create({
      data: {
        shopId: data.shopId,
        externalOrderId: data.orderReference,
        orderReference: data.orderReference,
        customerEmail: data.customerEmail,
        customerName: data.customerName || null,
        language: data.language || 'pl',
        currency: data.currency || 'PLN',
        totalPaid: data.totalPaid,
        createdAtShop,
        payloadJson: {
          source: 'manual',
          notes: data.notes,
          createdBy: 'admin', // TODO: pobierać z auth context
        },
        syncedAt: new Date(),
      },
    });

    // Utwórz pozycje zamówienia
    for (const item of data.items) {
      const normalizedSku = normalizeSku(item.sku);

      const shopMapping = await tx.shopProductMapping.findFirst({
        where: {
          shopId: data.shopId,
          externalSku: { equals: normalizedSku, mode: 'insensitive' },
          isActive: true,
        },
        include: {
          personalizationTemplate: true,
        },
      });

      // Legacy fallback for SKU-based personalized products.
      const personalizedProduct = personalizationEnabledForTenant && !shopMapping?.personalizationTemplate
        ? await tx.personalizedProduct.findFirst({
            where: {
              shopId: data.shopId,
              identifierType: 'SKU',
              identifierValue: { equals: normalizedSku, mode: 'insensitive' },
              isActive: true,
            },
            include: { template: true },
          })
        : null;

      const mappingTemplate = personalizationEnabledForTenant &&
        shopMapping?.warehouseProductId &&
        shopMapping?.personalizationEnabled
          ? shopMapping.personalizationTemplate
          : null;
      const caseTemplate = mappingTemplate || personalizedProduct?.template || null;

      // Utwórz pozycję zamówienia
      const orderItem = await tx.orderItem.create({
        data: {
          orderId: newOrder.id,
          externalItemId: `${data.orderReference}-${normalizedSku}`,
          sku: normalizedSku,
          productNameSnapshot: item.productName.trim(),
          quantity: item.quantity,
          personalizedProductId: personalizedProduct?.id || null,
          warehouseProductId: shopMapping?.warehouseProductId || null,
        },
      });

      // Jeśli produkt jest personalizowany, utwórz jeden case dla pozycji
      if (caseTemplate) {
        const { token, hash, encrypted } = generateAccessToken();

        const newCase = await tx.personalizationCase.create({
          data: {
            orderId: newOrder.id,
            orderItemId: orderItem.id,
            templateId: caseTemplate.id,
            templateVersionFrozen: caseTemplate.version,
            status: 'WAITING_FOR_CUSTOMER',
            customerTokenHash: hash,
            customerTokenEncrypted: encrypted,
            tokenActive: true,
          },
        });

        manualCasesCreated.push({
          id: newCase.id,
          token,
          orderReference: newOrder.orderReference,
          customerEmail: newOrder.customerEmail,
          customerName: newOrder.customerName || '',
          shopName: shop.name,
          productName: orderItem.productNameSnapshot,
          quantity: orderItem.quantity,
        });
      }
    }

    return newOrder;
  });

  // Trigger automations for created cases (after transaction commits)
  const { triggerAutomations, AutomationTrigger } = await import('./automation.service');
  const { createWzForOrder, shouldAutoCreateWzForTenant } = await import('./warehouse-documents.service');

  await reserveOrder(order.id);

  if (await shouldAutoCreateWzForTenant(shop.tenantId)) {
    await createWzForOrder(order.id);
  }

  for (const caseItem of manualCasesCreated) {
    await triggerAutomations({
      trigger: AutomationTrigger.CASE_CREATED,
      caseId: caseItem.id,
    });

    if (emailService.isConfigured() && config.smtp.autoSend) {
      await queuePersonalizationEmail({
        to: caseItem.customerEmail,
        customerName: caseItem.customerName,
        orderReference: caseItem.orderReference,
        shopName: caseItem.shopName,
        items: [
          {
            productName: caseItem.productName,
            quantity: caseItem.quantity,
            personalizationUrl: `${config.frontend.portalUrl}/${caseItem.token}`,
          },
        ],
        baseUrl: config.frontend.portalUrl,
        caseId: caseItem.id,
      });
    }
  }

  // Policz ile cases utworzono
  const casesCount = await prisma.personalizationCase.count({
    where: { orderId: order.id },
  });

  return {
    orderId: order.id,
    casesCreated: casesCount,
    message: `Utworzono zamówienie ${data.orderReference} z ${casesCount} przypadkami personalizacji`,
  };
}

/**
 * Usuwa zamówienie wraz z wszystkimi powiązanymi danymi
 */
export async function deleteOrder(orderId: string): Promise<void> {
  // Sprawdź czy zamówienie istnieje
  const order = await prisma.order.findUnique({
    where: { id: orderId },
  });

  if (!order) {
    throw new Error('Zamówienie nie istnieje');
  }

  // Usuń w transakcji
  await releaseOrderReservations(orderId);

  await prisma.$transaction(async (tx) => {
    // Usuń wszystkie case'y powiązane z zamówieniem
    await tx.personalizationCase.deleteMany({
      where: { orderId },
    });

    // Usuń pozycje zamówienia
    await tx.orderItem.deleteMany({
      where: { orderId },
    });

    // Usuń zamówienie
    await tx.order.delete({
      where: { id: orderId },
    });
  });
}
