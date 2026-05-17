import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { Prisma, WarehouseReservationStatus } from '@prisma/client';

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
  reason?: string | null;
}

export interface UpdateReservationStatusInput {
  status: WarehouseReservationStatus;
  reason?: string | null;
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
    },
  },
} satisfies Prisma.WarehouseReservationInclude;

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

export async function createReservation(input: CreateReservationInput) {
  const contextTenantId = getTenantId();
  const quantity = toPositiveDecimal(input.quantity);

  return prisma.$transaction(async (tx) => {
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

    return tx.warehouseReservation.create({
      data: {
        tenantId,
        warehouseProductId: product.id,
        orderId: order.id,
        orderItemId,
        quantity,
        status: 'ACTIVE',
        reason: input.reason ?? null,
      },
      include: reservationInclude,
    });
  });
}

export async function updateReservationStatus(id: string, input: UpdateReservationStatusInput) {
  const tenantId = getTenantId();
  const status = normalizeStatus(input.status);
  if (!status) throw new Error('Status rezerwacji jest wymagany');

  const reservation = await prisma.warehouseReservation.findFirst({
    where: {
      id,
      ...(tenantId ? { tenantId } : {}),
    },
  });
  if (!reservation) throw new Error('Rezerwacja nie znaleziona');

  if (reservation.status === status) {
    return prisma.warehouseReservation.findUnique({
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

  return prisma.warehouseReservation.update({
    where: { id },
    data: {
      status,
      reason: input.reason ?? reservation.reason,
      ...statusTimestamp(status),
    },
    include: reservationInclude,
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
