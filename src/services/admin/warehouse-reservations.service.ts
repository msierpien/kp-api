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

type ActiveReservationForPlanning = {
  id: string;
  status: WarehouseReservationStatus;
  warehouseProductId: string;
  quantity: Prisma.Decimal;
  source: WarehouseReservationSource;
  reason: string | null;
};

type ReservationSplitPlan = {
  localQuantity: Prisma.Decimal;
  backorderQuantity: Prisma.Decimal;
  backorderShortfallQuantity: Prisma.Decimal;
  missingQuantity: Prisma.Decimal;
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

function sumReservationQuantity(reservations: Array<{ quantity: Prisma.Decimal }>) {
  return reservations.reduce((sum, reservation) => sum.plus(reservation.quantity), new Prisma.Decimal(0));
}

async function hasWholesaleBackorderAvailability(tx: Tx, productId: string) {
  const wholesale = await tx.wholesaleProductMapping.findFirst({
    where: {
      warehouseProductId: productId,
      isActive: true,
      lastKnownStock: { gt: new Prisma.Decimal(0) },
      provider: { isActive: true },
    },
    select: { id: true },
  });

  return Boolean(wholesale);
}

async function planReservationSplit(
  tx: Tx,
  productId: string,
  targetQuantity: Prisma.Decimal,
  existingLocalQuantity: Prisma.Decimal,
  existingBackorderQuantity: Prisma.Decimal,
  allowNegativeStock: boolean,
): Promise<ReservationSplitPlan> {
  if (targetQuantity.lte(0)) {
    return {
      localQuantity: new Prisma.Decimal(0),
      backorderQuantity: new Prisma.Decimal(0),
      backorderShortfallQuantity: new Prisma.Decimal(0),
      missingQuantity: new Prisma.Decimal(0),
    };
  }

  if (allowNegativeStock) {
    return {
      localQuantity: targetQuantity,
      backorderQuantity: new Prisma.Decimal(0),
      backorderShortfallQuantity: new Prisma.Decimal(0),
      missingQuantity: new Prisma.Decimal(0),
    };
  }

  const product = await tx.warehouseProduct.findUnique({
    where: { id: productId },
    select: { currentStock: true },
  });
  const availableLocal = Prisma.Decimal.max(new Prisma.Decimal(product?.currentStock ?? 0), new Prisma.Decimal(0));
  const hasBackorderAvailability = await hasWholesaleBackorderAvailability(tx, productId);

  if (existingBackorderQuantity.gt(0)) {
    if (availableLocal.gte(targetQuantity)) {
      return {
        localQuantity: targetQuantity,
        backorderQuantity: new Prisma.Decimal(0),
        backorderShortfallQuantity: new Prisma.Decimal(0),
        missingQuantity: new Prisma.Decimal(0),
      };
    }

    return {
      localQuantity: new Prisma.Decimal(0),
      backorderQuantity: targetQuantity,
      backorderShortfallQuantity: new Prisma.Decimal(0),
      missingQuantity: hasBackorderAvailability ? new Prisma.Decimal(0) : targetQuantity,
    };
  }

  const localCapacity = existingLocalQuantity.plus(availableLocal);
  const localQuantity = Prisma.Decimal.min(targetQuantity, localCapacity);
  const remainingQuantity = targetQuantity.minus(localQuantity);

  if (localQuantity.gt(0)) {
    return {
      localQuantity,
      backorderQuantity: new Prisma.Decimal(0),
      backorderShortfallQuantity: hasBackorderAvailability ? remainingQuantity : new Prisma.Decimal(0),
      missingQuantity: hasBackorderAvailability ? new Prisma.Decimal(0) : remainingQuantity,
    };
  }

  if (hasBackorderAvailability) {
    return {
      localQuantity: new Prisma.Decimal(0),
      backorderQuantity: targetQuantity,
      backorderShortfallQuantity: new Prisma.Decimal(0),
      missingQuantity: new Prisma.Decimal(0),
    };
  }

  return {
    localQuantity: new Prisma.Decimal(0),
    backorderQuantity: new Prisma.Decimal(0),
    backorderShortfallQuantity: new Prisma.Decimal(0),
    missingQuantity: targetQuantity,
  };
}

async function setActiveReservationsForSource(
  tx: Tx,
  reservations: ActiveReservationForPlanning[],
  desiredQuantity: Prisma.Decimal,
  input: CreateReservationInput & { source: WarehouseReservationSource },
) {
  const [primary, ...extras] = reservations;

  for (const reservation of extras) {
    await closeActiveReservationInTx(tx, reservation, 'RELEASED', 'Scalenie aktywnych rezerwacji zamówienia');
  }

  if (desiredQuantity.lte(0)) {
    if (primary) {
      await closeActiveReservationInTx(tx, primary, 'RELEASED', 'Aktualizacja ilości rezerwacji zamówienia');
    }
    return;
  }

  if (!primary) {
    await createActiveReservationInTx(tx, input, desiredQuantity);
    return;
  }

  const currentQuantity = new Prisma.Decimal(primary.quantity);
  const delta = desiredQuantity.minus(currentQuantity);
  if (delta.equals(0)) return;

  await tx.warehouseReservation.update({
    where: { id: primary.id },
    data: {
      quantity: desiredQuantity,
      reason: primary.reason ?? input.reason ?? null,
    },
  });

  if (primary.source === 'LOCAL_STOCK') {
    await adjustProductStock(tx, primary.warehouseProductId, delta.mul(-1));
  }
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
    if (!product.isStockTracked) throw new Error('Produkt jest wykluczony z magazynu');

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

  // Read the order header, warehouse settings and the (potentially very large)
  // shop product mapping catalog OUTSIDE the interactive transaction. Doing this
  // inside the transaction held the advisory lock while reading thousands of
  // rows and could exceed the 5s transaction timeout.
  const orderHeader = await prisma.order.findFirst({
    where: {
      id: orderId,
      ...(contextTenantId ? { shop: { tenantId: contextTenantId } } : {}),
    },
    include: { shop: true },
  });
  if (!orderHeader) throw new Error('Zamówienie nie znalezione');

  const settings = await getWarehouseSettings(prisma, orderHeader.shop.tenantId);
  const mappings = await prisma.shopProductMapping.findMany({
    where: {
      tenantId: orderHeader.shop.tenantId,
      shopId: orderHeader.shopId,
      isActive: true,
      warehouseProductId: { not: null },
    },
    include: { warehouseProduct: true },
  });
  const mappingBySku = new Map(mappings.map((mapping) => [normalizeSku(mapping.externalSku), mapping]));

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

      const activeReservations = await tx.warehouseReservation.findMany({
        where: {
          tenantId: order.shop.tenantId,
          orderItemId: item.id,
          status: 'ACTIVE',
        },
        orderBy: { createdAt: 'asc' },
      });

      if (!warehouseProduct.isStockTracked) {
        for (const reservation of activeReservations) {
          await closeActiveReservationInTx(
            tx,
            reservation,
            'RELEASED',
            'Produkt wykluczony z magazynu',
          );
        }
        if (activeReservations.length > 0) {
          result.updated++;
        }
        result.missingMapping++;
        result.issues.push({
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: 0,
          warehouseProductId,
          status: 'MISSING_MAPPING',
          message: 'Produkt wykluczony z magazynu',
        });
        continue;
      }

      if (!item.warehouseProductId || item.warehouseProductId !== warehouseProductId) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { warehouseProductId },
        });
      }

      const consumedReservations = await tx.warehouseReservation.findMany({
        where: {
          tenantId: order.shop.tenantId,
          orderItemId: item.id,
          status: 'CONSUMED',
        },
      });
      const consumedQuantity = consumedReservations
        .filter((reservation) => reservation.warehouseProductId === warehouseProductId)
        .reduce((sum, reservation) => sum.plus(reservation.quantity), new Prisma.Decimal(0));

      if (consumedQuantity.gte(requestedQuantity)) {
        const issue: OrderReservationIssue = {
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: Number(consumedQuantity),
          warehouseProductId,
          status: activeReservations.length > 0 ? 'UPDATED' : 'UNCHANGED',
          message: 'Pozycja została już wydana dokumentem WZ',
        };

        for (const reservation of activeReservations) {
          await closeActiveReservationInTx(
            tx,
            reservation,
            'RELEASED',
            'Pozycja została już wydana dokumentem WZ',
          );
        }
        if (activeReservations.length > 0) {
          result.updated++;
        } else {
          result.unchanged++;
        }
        result.issues.push(issue);
        continue;
      }

      const targetActiveQuantity = requestedQuantity.minus(consumedQuantity);

      const staleReservations = activeReservations.filter((reservation) => reservation.warehouseProductId !== warehouseProductId);
      for (const reservation of staleReservations) {
        await closeActiveReservationInTx(tx, reservation, 'RELEASED', 'Zmiana mapowania produktu zamówienia');
      }

      const productReservations = activeReservations.filter((reservation) => reservation.warehouseProductId === warehouseProductId);
      const localReservations = productReservations.filter((reservation) => reservation.source === 'LOCAL_STOCK');
      const backorderReservations = productReservations.filter((reservation) => reservation.source === 'WHOLESALE_BACKORDER');
      const existingLocalQuantity = sumReservationQuantity(localReservations);
      const existingBackorderQuantity = sumReservationQuantity(backorderReservations);
      const plan = await planReservationSplit(
        tx,
        warehouseProductId,
        targetActiveQuantity,
        existingLocalQuantity,
        existingBackorderQuantity,
        settings.allowNegativeStock,
      );
      const nextActiveQuantity = plan.localQuantity.plus(plan.backorderQuantity);
      const totalReservedQuantity = consumedQuantity.plus(nextActiveQuantity);
      const totalCoveredQuantity = totalReservedQuantity.plus(plan.backorderShortfallQuantity);
      const changed = staleReservations.length > 0 ||
        !existingLocalQuantity.equals(plan.localQuantity) ||
        !existingBackorderQuantity.equals(plan.backorderQuantity);
      const hadProductReservation = productReservations.length > 0;
      const baseReservationInput = {
        tenantId: order.shop.tenantId,
        warehouseProductId,
        orderId: order.id,
        orderItemId: item.id,
        expectedShipDate: item.shippingDate ?? null,
        reason: `Zamówienie ${order.orderReference}`,
      };
      const closesBackorderBeforeLocal = plan.localQuantity.gt(0) &&
        plan.backorderQuantity.lte(0) &&
        localReservations.length === 0 &&
        backorderReservations.length > 0;

      if (closesBackorderBeforeLocal) {
        await setActiveReservationsForSource(
          tx,
          backorderReservations,
          new Prisma.Decimal(0),
          {
            ...baseReservationInput,
            quantity: new Prisma.Decimal(0),
            source: 'WHOLESALE_BACKORDER',
          },
        );
        await setActiveReservationsForSource(
          tx,
          localReservations,
          plan.localQuantity,
          {
            ...baseReservationInput,
            quantity: plan.localQuantity,
            source: 'LOCAL_STOCK',
          },
        );
      } else {
        await setActiveReservationsForSource(
          tx,
          localReservations,
          plan.localQuantity,
          {
            ...baseReservationInput,
            quantity: plan.localQuantity,
            source: 'LOCAL_STOCK',
          },
        );
        await setActiveReservationsForSource(
          tx,
          backorderReservations,
          plan.backorderQuantity,
          {
            ...baseReservationInput,
            quantity: plan.backorderQuantity,
            source: 'WHOLESALE_BACKORDER',
          },
        );
      }

      const splitMessage = plan.backorderShortfallQuantity.gt(0)
        ? 'Część pozycji zarezerwowana lokalnie, reszta do domówienia'
        : plan.backorderQuantity.gt(0)
          ? 'Pozycja do domówienia z hurtowni'
          : consumedQuantity.gt(0)
            ? 'Część pozycji została już wydana WZ'
            : undefined;

      if (plan.missingQuantity.gt(0) && totalReservedQuantity.gt(consumedQuantity)) {
        result.partial++;
        result.issues.push({
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: Number(totalReservedQuantity),
          warehouseProductId,
          status: 'PARTIAL',
          message: 'Rezerwacja częściowa z powodu niewystarczającego stanu lub braku oferty hurtowni',
        });
      } else if (plan.missingQuantity.gt(0)) {
        result.missingStock++;
        result.issues.push({
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: Number(totalReservedQuantity),
          warehouseProductId,
          status: 'MISSING_STOCK',
          message: 'Brak stanu lub aktywnej oferty hurtowni do rezerwacji',
        });
      } else if (!hadProductReservation && nextActiveQuantity.gt(0)) {
        result.reserved++;
        result.issues.push({
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: Number(totalCoveredQuantity),
          warehouseProductId,
          status: 'RESERVED',
          message: splitMessage,
        });
      } else if (changed) {
        result.updated++;
        result.issues.push({
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: Number(totalCoveredQuantity),
          warehouseProductId,
          status: 'UPDATED',
          message: existingBackorderQuantity.gt(0) && plan.backorderQuantity.equals(0) && plan.localQuantity.gte(targetActiveQuantity)
            ? 'Rezerwacja hurtowa została przeniesiona na stan lokalny'
            : splitMessage,
        });
      } else {
        result.unchanged++;
        result.issues.push({
          orderItemId: item.id,
          sku: item.sku,
          productName: item.productNameSnapshot,
          requestedQuantity: item.quantity,
          reservedQuantity: Number(totalCoveredQuantity),
          warehouseProductId,
          status: 'UNCHANGED',
          message: splitMessage,
        });
      }
    }

    return result;
  }, { timeout: 20000, maxWait: 15000 });

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
