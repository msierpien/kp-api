import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { Prisma, WarehouseReservationSource, WarehouseReservationStatus } from '@prisma/client';
import { syncStockForProducts } from '../stock/stock-sync.service';

type Tx = Prisma.TransactionClient;

export interface ReservationsQuery {
  page?: number;
  limit?: number;
  status?: WarehouseReservationStatus;
}

export interface CreateReservationInput {
  tenantId?: string;
  warehouseProductId: string;
  orderId: string;
  orderItemId?: string | null;
  quantity: Prisma.Decimal.Value;
  source?: WarehouseReservationSource;
  expectedShipDate?: Date | string | null;
  reason?: string | null;
}

export interface UpdateReservationStatusInput {
  status: WarehouseReservationStatus;
  reason?: string | null;
}

export interface OrderReservationIssue {
  orderItemId: string;
  sku: string;
  productName: string;
  requestedQuantity: number;
  reservedQuantity: number;
  warehouseProductId?: string;
  status: 'RESERVED' | 'UNCHANGED' | 'UPDATED' | 'PARTIAL' | 'MISSING_MAPPING' | 'MISSING_STOCK';
  message?: string;
}

export interface OrderReservationResult {
  orderId: string;
  reserved: number;
  unchanged: number;
  updated: number;
  partial: number;
  missingMapping: number;
  missingStock: number;
  restoredQuantity?: Prisma.Decimal;
  issues: OrderReservationIssue[];
}

const RESERVATION_STATUSES: WarehouseReservationStatus[] = ['ACTIVE', 'CONSUMED', 'RELEASED', 'CANCELLED'];
const TERMINAL_STATUSES: WarehouseReservationStatus[] = ['CONSUMED', 'RELEASED', 'CANCELLED'];

const reservationInclude = {
  warehouseProduct: {
    select: {
      id: true,
      sku: true,
      name: true,
      unit: true,
    },
  },
  order: {
    select: {
      id: true,
      orderReference: true,
      externalOrderId: true,
      customerEmail: true,
      shop: {
        select: {
          id: true,
          name: true,
          platform: true,
        },
      },
    },
  },
  orderItem: {
    select: {
      id: true,
      externalItemId: true,
      sku: true,
      productNameSnapshot: true,
      quantity: true,
      sourceType: true,
      bundleGroupId: true,
      bundleName: true,
      shippingDate: true,
      shippingSource: true,
    },
  },
} satisfies Prisma.WarehouseReservationInclude;

type ReservationAvailability = {
  quantity: Prisma.Decimal;
  source: WarehouseReservationSource;
};

function normalizePage(value?: number) {
  const page = Number(value ?? 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizeLimit(value?: number) {
  const limit = Number(value ?? 20);
  if (!Number.isFinite(limit) || limit < 1) return 20;
  return Math.min(Math.floor(limit), 100);
}

function normalizeStatus(status?: WarehouseReservationStatus) {
  if (!status) return undefined;
  if (!RESERVATION_STATUSES.includes(status)) throw new Error('Nieprawidłowy status rezerwacji');
  return status;
}

function normalizeSku(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase();
}

function toPositiveDecimal(value: Prisma.Decimal.Value) {
  let quantity: Prisma.Decimal;
  try {
    quantity = new Prisma.Decimal(value);
  } catch {
    throw new Error('Ilość rezerwacji jest nieprawidłowa');
  }

  if (quantity.lte(0)) throw new Error('Ilość rezerwacji musi być większa od 0');
  return quantity;
}

function statusTimestamp(status: WarehouseReservationStatus) {
  if (status === 'RELEASED') return { releasedAt: new Date() };
  if (status === 'CONSUMED') return { consumedAt: new Date() };
  if (status === 'CANCELLED') return { cancelledAt: new Date() };
  return {};
}

async function getWarehouseSettings(tx: Tx, tenantId: string) {
  const tenant = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { limitsJson: true },
  });

  const limits = tenant?.limitsJson as any;
  return {
    allowNegativeStock: limits?.warehouse?.allowNegativeStock === true,
  };
}

async function lockOrderForReservation(tx: Tx, orderId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`order-reservation:${orderId}`}, 0))`;
}

async function adjustProductStock(tx: Tx, productId: string, delta: Prisma.Decimal) {
  if (delta.equals(0)) return;

  await tx.warehouseProduct.update({
    where: { id: productId },
    data: { currentStock: { increment: delta } },
  });
}

async function reserveQuantityForProduct(
  tx: Tx,
  productId: string,
  requestedQuantity: Prisma.Decimal,
  allowNegativeStock: boolean,
): Promise<ReservationAvailability> {
  const product = await tx.warehouseProduct.findUnique({
    where: { id: productId },
    select: { currentStock: true },
  });
  const available = new Prisma.Decimal(product?.currentStock ?? 0);
  if (allowNegativeStock) {
    return {
      quantity: requestedQuantity,
      source: 'LOCAL_STOCK',
    };
  }

  if (available.gt(0)) {
    return {
      quantity: Prisma.Decimal.min(available, requestedQuantity),
      source: 'LOCAL_STOCK',
    };
  }

  const wholesale = await tx.wholesaleProductMapping.findFirst({
    where: {
      warehouseProductId: productId,
      isActive: true,
      lastKnownStock: { gt: new Prisma.Decimal(0) },
      provider: { isActive: true },
    },
    orderBy: [
      { lastKnownPrice: 'asc' },
      { lastSyncAt: 'desc' },
    ],
    select: { id: true },
  });

  if (wholesale) {
    return {
      quantity: requestedQuantity,
      source: 'WHOLESALE_BACKORDER',
    };
  }

  return {
    quantity: new Prisma.Decimal(0),
    source: 'LOCAL_STOCK',
  };
}

async function createActiveReservationInTx(tx: Tx, input: CreateReservationInput, quantity: Prisma.Decimal) {
  const reservation = await tx.warehouseReservation.create({
    data: {
      tenantId: input.tenantId as string,
      warehouseProductId: input.warehouseProductId,
      orderId: input.orderId,
      orderItemId: input.orderItemId ?? null,
      quantity,
      status: 'ACTIVE',
      source: input.source ?? 'LOCAL_STOCK',
      expectedShipDate: input.expectedShipDate ? new Date(input.expectedShipDate) : null,
      reason: input.reason ?? null,
    },
    include: reservationInclude,
  });

  if ((input.source ?? 'LOCAL_STOCK') === 'LOCAL_STOCK') {
    await adjustProductStock(tx, input.warehouseProductId, quantity.mul(-1));
  }
  return reservation;
}

async function closeActiveReservationInTx(
  tx: Tx,
  reservation: {
    id: string;
    status: WarehouseReservationStatus;
    warehouseProductId: string;
    quantity: Prisma.Decimal;
    source: WarehouseReservationSource;
    reason: string | null;
  },
  status: Exclude<WarehouseReservationStatus, 'ACTIVE'>,
  reason?: string | null,
) {
  if (reservation.status !== 'ACTIVE') {
    throw new Error('Można zamknąć tylko aktywną rezerwację');
  }

  if ((status === 'RELEASED' || status === 'CANCELLED') && reservation.source === 'LOCAL_STOCK') {
    await adjustProductStock(tx, reservation.warehouseProductId, new Prisma.Decimal(reservation.quantity));
  }

  return tx.warehouseReservation.update({
    where: { id: reservation.id },
    data: {
      status,
      reason: reason ?? reservation.reason,
      ...statusTimestamp(status),
    },
    include: reservationInclude,
  });
}

export async function createReservation(input: CreateReservationInput) {
  const contextTenantId = getTenantId();
  const quantity = toPositiveDecimal(input.quantity);

  return prisma.$transaction(async (tx) => {
    await lockOrderForReservation(tx, input.orderId);

    const product = await tx.warehouseProduct.findFirst({
      where: {
        id: input.warehouseProductId,
        ...(contextTenantId ? { tenantId: contextTenantId } : {}),
      },
    });
    if (!product) throw new Error('Produkt magazynowy nie znaleziony');

    const tenantId = input.tenantId ?? product.tenantId;
    if (product.tenantId !== tenantId) {
      throw new Error('Produkt magazynowy należy do innego tenanta');
    }

    const order = await tx.order.findFirst({
      where: {
        id: input.orderId,
        shop: { tenantId },
      },
      include: { shop: true },
    });
    if (!order) throw new Error('Zamówienie nie znalezione');

    const orderItemId: string | null = input.orderItemId ?? null;
    if (orderItemId) {
      const orderItem = await tx.orderItem.findFirst({
        where: {
          id: orderItemId,
          orderId: order.id,
        },
      });
      if (!orderItem) throw new Error('Pozycja zamówienia nie znaleziona dla tego zamówienia');
    }

    const settings = await getWarehouseSettings(tx, tenantId);
    const availability = await reserveQuantityForProduct(tx, product.id, quantity, settings.allowNegativeStock);
    if (availability.quantity.lt(quantity)) {
      throw new Error('Niewystarczający stan produktu do utworzenia pełnej rezerwacji');
    }

    return createActiveReservationInTx(
      tx,
      {
        ...input,
        tenantId,
        warehouseProductId: product.id,
        orderId: order.id,
        orderItemId,
        source: availability.source,
      },
      quantity,
    );
  });
}

export async function reserveOrder(orderId: string): Promise<OrderReservationResult> {
  const contextTenantId = getTenantId();

  const result = await prisma.$transaction(async (tx) => {
    await lockOrderForReservation(tx, orderId);

    const order = await tx.order.findFirst({
      where: {
        id: orderId,
        ...(contextTenantId ? { shop: { tenantId: contextTenantId } } : {}),
      },
      include: {
        shop: true,
        items: {
          include: {
            warehouseProduct: true,
          },
        },
      },
    });
    if (!order) throw new Error('Zamówienie nie znalezione');

    const settings = await getWarehouseSettings(tx, order.shop.tenantId);
    const mappings = await tx.shopProductMapping.findMany({
      where: {
        tenantId: order.shop.tenantId,
        shopId: order.shopId,
        isActive: true,
        warehouseProductId: { not: null },
      },
      include: { warehouseProduct: true },
    });
    const mappingBySku = new Map(mappings.map((mapping) => [normalizeSku(mapping.externalSku), mapping]));

    const result: OrderReservationResult = {
      orderId: order.id,
      reserved: 0,
      unchanged: 0,
      updated: 0,
      partial: 0,
      missingMapping: 0,
      missingStock: 0,
      issues: [],
    };

    for (const item of order.items) {
      const requestedQuantity = new Prisma.Decimal(item.quantity);
      const mapping = mappingBySku.get(normalizeSku(item.sku));
      const warehouseProductId = item.warehouseProductId ?? mapping?.warehouseProductId ?? null;
      const warehouseProduct = item.warehouseProduct ?? mapping?.warehouseProduct ?? null;

      if (!warehouseProductId || !warehouseProduct) {
        result.missingMapping++;
        result.issues.push({
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: 0,
          status: 'MISSING_MAPPING',
          message: 'Brak aktywnego mapowania produktu sklepu do magazynu',
        });
        continue;
      }

      if (!item.warehouseProductId || item.warehouseProductId !== warehouseProductId) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { warehouseProductId },
        });
      }

      const existingReservation = await tx.warehouseReservation.findFirst({
        where: {
          tenantId: order.shop.tenantId,
          orderItemId: item.id,
          status: 'ACTIVE',
        },
      });

      if (existingReservation && existingReservation.warehouseProductId !== warehouseProductId) {
        await closeActiveReservationInTx(tx, existingReservation, 'RELEASED', 'Zmiana mapowania produktu zamówienia');
      } else if (existingReservation) {
        const currentQuantity = new Prisma.Decimal(existingReservation.quantity);
        const delta = requestedQuantity.minus(currentQuantity);

        if (delta.equals(0)) {
          result.unchanged++;
          result.issues.push({
            orderItemId: item.id,
            sku: item.sku,
            productName: item.productNameSnapshot,
            requestedQuantity: item.quantity,
            reservedQuantity: Number(currentQuantity),
            warehouseProductId,
            status: 'UNCHANGED',
          });
          continue;
        }

        if (delta.lt(0)) {
          await tx.warehouseReservation.update({
            where: { id: existingReservation.id },
            data: { quantity: requestedQuantity },
          });
          if (existingReservation.source === 'LOCAL_STOCK') {
            await adjustProductStock(tx, warehouseProductId, delta.mul(-1));
          }
          result.updated++;
          result.issues.push({
            orderItemId: item.id,
            sku: item.sku,
            productName: item.productNameSnapshot,
            requestedQuantity: item.quantity,
            reservedQuantity: item.quantity,
            warehouseProductId,
            status: 'UPDATED',
          });
          continue;
        }

        const additionalAvailability = await reserveQuantityForProduct(tx, warehouseProductId, delta, settings.allowNegativeStock);
        if (additionalAvailability.quantity.lte(0) || additionalAvailability.source !== existingReservation.source) {
          result.missingStock++;
          result.issues.push({
            orderItemId: item.id,
            sku: item.sku,
            productName: item.productNameSnapshot,
            requestedQuantity: item.quantity,
            reservedQuantity: Number(currentQuantity),
            warehouseProductId,
            status: 'MISSING_STOCK',
            message: additionalAvailability.source !== existingReservation.source
              ? 'Nie można mieszać źródeł realizacji w jednej rezerwacji'
              : 'Brak dodatkowego stanu do zwiększenia rezerwacji',
          });
          continue;
        }

        const nextQuantity = currentQuantity.plus(additionalAvailability.quantity);
        await tx.warehouseReservation.update({
          where: { id: existingReservation.id },
          data: { quantity: nextQuantity },
        });
        if (existingReservation.source === 'LOCAL_STOCK') {
          await adjustProductStock(tx, warehouseProductId, additionalAvailability.quantity.mul(-1));
        }

        if (nextQuantity.lt(requestedQuantity)) {
          result.partial++;
          result.issues.push({
            orderItemId: item.id,
            sku: item.sku,
            productName: item.productNameSnapshot,
            requestedQuantity: item.quantity,
            reservedQuantity: Number(nextQuantity),
            warehouseProductId,
            status: 'PARTIAL',
            message: 'Rezerwacja częściowa z powodu niewystarczającego stanu',
          });
        } else {
          result.updated++;
          result.issues.push({
            orderItemId: item.id,
            sku: item.sku,
            productName: item.productNameSnapshot,
            requestedQuantity: item.quantity,
            reservedQuantity: item.quantity,
            warehouseProductId,
            status: 'UPDATED',
          });
        }
        continue;
      }

      const availability = await reserveQuantityForProduct(tx, warehouseProductId, requestedQuantity, settings.allowNegativeStock);
      if (availability.quantity.lte(0)) {
        result.missingStock++;
        result.issues.push({
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: 0,
          warehouseProductId,
          status: 'MISSING_STOCK',
          message: 'Brak stanu do rezerwacji',
        });
        continue;
      }

      await createActiveReservationInTx(
        tx,
        {
          tenantId: order.shop.tenantId,
          warehouseProductId,
          orderId: order.id,
          orderItemId: item.id,
          quantity: availability.quantity,
          source: availability.source,
          expectedShipDate: item.shippingDate ?? null,
          reason: `Zamówienie ${order.orderReference}`,
        },
        availability.quantity,
      );

      if (availability.quantity.lt(requestedQuantity)) {
        result.partial++;
        result.issues.push({
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: Number(availability.quantity),
          warehouseProductId,
          status: 'PARTIAL',
          message: 'Rezerwacja częściowa z powodu niewystarczającego stanu',
        });
      } else {
        result.reserved++;
        result.issues.push({
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: item.quantity,
          warehouseProductId,
          status: 'RESERVED',
        });
      }
    }

    return result;
  });

  const affectedProductIds = result.issues
    .filter((issue) => issue.warehouseProductId && ['RESERVED', 'UPDATED', 'PARTIAL'].includes(issue.status))
    .map((issue) => issue.warehouseProductId as string);
  await syncStockForProducts(affectedProductIds, 'ORDER_RESERVATION');

  return result;
}

export async function releaseOrderReservations(orderId: string): Promise<OrderReservationResult> {
  const contextTenantId = getTenantId();

  const result = await prisma.$transaction(async (tx) => {
    await lockOrderForReservation(tx, orderId);

    const order = await tx.order.findFirst({
      where: {
        id: orderId,
        ...(contextTenantId ? { shop: { tenantId: contextTenantId } } : {}),
      },
      include: { shop: true },
    });
    if (!order) throw new Error('Zamówienie nie znalezione');

    const activeReservations = await tx.warehouseReservation.findMany({
      where: {
        tenantId: order.shop.tenantId,
        orderId: order.id,
        status: 'ACTIVE',
      },
      include: {
        orderItem: true,
      },
    });

    let restoredQuantity = new Prisma.Decimal(0);
    const issues: OrderReservationIssue[] = [];

    for (const reservation of activeReservations) {
      await closeActiveReservationInTx(tx, reservation, 'RELEASED', 'Ręczne zwolnienie rezerwacji zamówienia');
      if (reservation.source === 'LOCAL_STOCK') {
        restoredQuantity = restoredQuantity.plus(reservation.quantity);
      }
      issues.push({
        orderItemId: reservation.orderItemId ?? '',
        sku: reservation.orderItem?.sku ?? '',
        productName: reservation.orderItem?.productNameSnapshot ?? '',
        requestedQuantity: Number(reservation.quantity),
        reservedQuantity: 0,
        warehouseProductId: reservation.warehouseProductId,
        status: 'UPDATED',
      });
    }

    return {
      orderId: order.id,
      reserved: 0,
      unchanged: 0,
      updated: activeReservations.length,
      partial: 0,
      missingMapping: 0,
      missingStock: 0,
      restoredQuantity,
      issues,
    };
  });

  const affectedProductIds = result.issues
    .filter((issue) => issue.warehouseProductId)
    .map((issue) => issue.warehouseProductId as string);
  await syncStockForProducts(affectedProductIds, 'ORDER_RESERVATION_RELEASE');

  return result;
}

export async function consumeDocumentReservations(
  tx: Tx,
  items: Array<{ productId: string; reservationId?: string | null }>,
) {
  for (const item of items) {
    if (!item.reservationId) continue;

    const reservation = await tx.warehouseReservation.findUnique({
      where: { id: item.reservationId },
    });
    if (!reservation) throw new Error('Rezerwacja powiązana z dokumentem nie istnieje');
    if (reservation.warehouseProductId !== item.productId) {
      throw new Error('Rezerwacja dokumentu dotyczy innego produktu');
    }
    if (reservation.status === 'CONSUMED') continue;
    if (reservation.status !== 'ACTIVE') {
      throw new Error('Tylko aktywna rezerwacja może zostać skonsumowana przez WZ');
    }

    await tx.warehouseReservation.update({
      where: { id: reservation.id },
      data: {
        status: 'CONSUMED',
        consumedAt: new Date(),
      },
    });
  }
}

export async function releaseDocumentReservations(
  tx: Tx,
  items: Array<{ productId: string; reservationId?: string | null }>,
) {
  for (const item of items) {
    if (!item.reservationId) continue;

    const reservation = await tx.warehouseReservation.findUnique({
      where: { id: item.reservationId },
    });
    if (!reservation) continue;
    if (reservation.warehouseProductId !== item.productId) {
      throw new Error('Rezerwacja dokumentu dotyczy innego produktu');
    }
    if (reservation.status === 'RELEASED') continue;
    if (reservation.status !== 'CONSUMED' && reservation.status !== 'ACTIVE') {
      throw new Error('Tylko aktywna albo skonsumowana rezerwacja może zostać zwolniona przez anulowanie WZ');
    }

    if (reservation.source === 'LOCAL_STOCK') {
      await adjustProductStock(tx, reservation.warehouseProductId, new Prisma.Decimal(reservation.quantity));
    }
    await tx.warehouseReservation.update({
      where: { id: reservation.id },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        reason: reservation.reason ?? 'Anulowanie dokumentu WZ',
      },
    });
  }
}

export async function updateReservationStatus(id: string, input: UpdateReservationStatusInput) {
  const tenantId = getTenantId();
  const status = normalizeStatus(input.status);
  if (!status) throw new Error('Status rezerwacji jest wymagany');

  return prisma.$transaction(async (tx) => {
    const reservation = await tx.warehouseReservation.findFirst({
      where: {
        id,
        ...(tenantId ? { tenantId } : {}),
      },
    });
    if (!reservation) throw new Error('Rezerwacja nie znaleziona');

    if (reservation.status === status) {
      return tx.warehouseReservation.findUnique({
        where: { id },
        include: reservationInclude,
      });
    }

    if (TERMINAL_STATUSES.includes(reservation.status)) {
      throw new Error('Nie można zmienić statusu rezerwacji terminalnej');
    }

    if (status === 'ACTIVE') {
      throw new Error('Nie można przywrócić rezerwacji do statusu ACTIVE');
    }

    return closeActiveReservationInTx(tx, reservation, status, input.reason);
  });
}

export async function getProductReservations(productId: string, query: ReservationsQuery = {}) {
  const tenantId = getTenantId();
  const page = normalizePage(query.page);
  const limit = normalizeLimit(query.limit);
  const status = normalizeStatus(query.status);
  const skip = (page - 1) * limit;

  const product = await prisma.warehouseProduct.findFirst({
    where: {
      id: productId,
      ...(tenantId ? { tenantId } : {}),
    },
  });
  if (!product) throw new Error('Produkt magazynowy nie znaleziony');

  const where: Prisma.WarehouseReservationWhereInput = {
    tenantId: product.tenantId,
    warehouseProductId: product.id,
    ...(status ? { status } : {}),
  };
  const activeWhere: Prisma.WarehouseReservationWhereInput = {
    tenantId: product.tenantId,
    warehouseProductId: product.id,
    status: 'ACTIVE',
  };

  const [data, total, activeAggregate] = await Promise.all([
    prisma.warehouseReservation.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: reservationInclude,
    }),
    prisma.warehouseReservation.count({ where }),
    prisma.warehouseReservation.aggregate({
      where: activeWhere,
      _sum: { quantity: true },
    }),
  ]);

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    summary: {
      activeQuantity: activeAggregate._sum.quantity ?? new Prisma.Decimal(0),
    },
  };
}

export async function getOrderReservations(orderId: string, query: ReservationsQuery = {}) {
  const tenantId = getTenantId();
  const page = normalizePage(query.page);
  const limit = normalizeLimit(query.limit);
  const status = normalizeStatus(query.status);
  const skip = (page - 1) * limit;

  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      ...(tenantId ? { shop: { tenantId } } : {}),
    },
    include: { shop: true },
  });
  if (!order) throw new Error('Zamówienie nie znalezione');

  const where: Prisma.WarehouseReservationWhereInput = {
    tenantId: order.shop.tenantId,
    orderId: order.id,
    ...(status ? { status } : {}),
  };
  const activeWhere: Prisma.WarehouseReservationWhereInput = {
    tenantId: order.shop.tenantId,
    orderId: order.id,
    status: 'ACTIVE',
  };

  const [data, total, activeAggregate] = await Promise.all([
    prisma.warehouseReservation.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: reservationInclude,
    }),
    prisma.warehouseReservation.count({ where }),
    prisma.warehouseReservation.aggregate({
      where: activeWhere,
      _sum: { quantity: true },
    }),
  ]);

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    summary: {
      activeQuantity: activeAggregate._sum.quantity ?? new Prisma.Decimal(0),
    },
  };
}
