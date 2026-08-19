import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';

/**
 * Ocena pokrycia magazynowego zamowienia — CZYTA, nie zmienia stanu.
 *
 * Automatyzacja przy nadaniu listu przewozowego musi wiedziec, czy towar
 * fizycznie jest na polce, ZANIM wystawi fakture i domknie WZ. `reserveOrder`
 * odpowiedzialby na to samo pytanie, ale przy okazji zaklada i zwalnia
 * rezerwacje — a przy brakach mamy nie wywolac zadnych skutkow magazynowych.
 */

export type OrderStockCoverageStatus =
  | 'COVERED'
  | 'SHORTAGE'
  | 'BACKORDER'
  | 'MISSING_MAPPING'
  | 'NOT_TRACKED';

export interface OrderStockCoverageItem {
  orderItemId: string;
  sku: string;
  productName: string;
  requiredQuantity: number;
  coveredQuantity: number;
  missingQuantity: number;
  status: OrderStockCoverageStatus;
  message?: string;
}

export interface OrderStockCoverage {
  orderId: string;
  /** true = kazda pozycja podlegajaca magazynowi ma pokrycie w rezerwacjach lokalnych. */
  covered: boolean;
  items: OrderStockCoverageItem[];
  /** Pozycje, ktore blokuja skutki magazynowe (braki, backorder, brak mapowania). */
  blocking: OrderStockCoverageItem[];
}

const BLOCKING_STATUSES: OrderStockCoverageStatus[] = ['SHORTAGE', 'BACKORDER', 'MISSING_MAPPING'];

export interface CoverageClassificationInput {
  requiredQuantity: number;
  coveredQuantity: number;
  hasMapping: boolean;
  isStockTracked: boolean;
  hasBackorder: boolean;
}

/** Czysta regula decyzyjna — bez bazy, zeby dalo sie ja przetestowac wprost. */
export function classifyCoverage(input: CoverageClassificationInput): OrderStockCoverageStatus {
  if (!input.hasMapping) return 'MISSING_MAPPING';
  if (!input.isStockTracked) return 'NOT_TRACKED';
  if (input.coveredQuantity >= input.requiredQuantity) return 'COVERED';
  return input.hasBackorder ? 'BACKORDER' : 'SHORTAGE';
}

export function isBlockingCoverageStatus(status: OrderStockCoverageStatus) {
  return BLOCKING_STATUSES.includes(status);
}

function normalizeSku(value: string | null | undefined) {
  return (value ?? '').trim().toLowerCase();
}

function decimalToNumber(value: Prisma.Decimal) {
  return Number(value.toDecimalPlaces(3));
}

export function describeCoverageItem(item: OrderStockCoverageItem) {
  const label = `${item.sku || item.productName}`;
  if (item.status === 'MISSING_MAPPING') return `${label}: ${item.message ?? 'brak powiązania z magazynem'}`;
  if (item.status === 'BACKORDER') return `${label}: brakuje ${item.missingQuantity} szt. — czeka na domówienie z hurtowni`;
  return `${label}: brakuje ${item.missingQuantity} z ${item.requiredQuantity} szt. na stanie`;
}

export async function evaluateOrderStockCoverage(orderId: string): Promise<OrderStockCoverage> {
  const contextTenantId = getTenantId();
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      ...(contextTenantId ? { shop: { tenantId: contextTenantId } } : {}),
    },
    include: {
      shop: true,
      items: { include: { warehouseProduct: true }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!order) throw new Error('Zamówienie nie znalezione');

  const mappings = await prisma.shopProductMapping.findMany({
    where: {
      tenantId: order.shop.tenantId,
      shopId: order.shopId,
      isActive: true,
      warehouseProductId: { not: null },
    },
    include: { warehouseProduct: true },
  });
  const mappingBySku = new Map(mappings.map((mapping) => [normalizeSku(mapping.externalSku), mapping]));

  const reservations = await prisma.warehouseReservation.findMany({
    where: {
      tenantId: order.shop.tenantId,
      orderId: order.id,
      status: { in: ['ACTIVE', 'CONSUMED'] },
    },
  });

  // Pozycje zatwierdzonego WZ bez rezerwacji (sciezka DETACH) tez znacza towar
  // juz wydany — inaczej domkniete zamowienie wygladaloby na niepokryte.
  const issuedWithoutReservation = await prisma.warehouseDocumentItem.findMany({
    where: {
      reservationId: null,
      document: { orderId: order.id, type: 'WZ', status: 'CONFIRMED' },
    },
    select: { productId: true, quantity: true },
  });
  const issuedByProduct = new Map<string, Prisma.Decimal>();
  for (const issued of issuedWithoutReservation) {
    issuedByProduct.set(
      issued.productId,
      (issuedByProduct.get(issued.productId) ?? new Prisma.Decimal(0)).plus(issued.quantity),
    );
  }

  const items: OrderStockCoverageItem[] = order.items.map((item) => {
    const mapping = mappingBySku.get(normalizeSku(item.sku));
    const warehouseProductId = item.warehouseProductId ?? mapping?.warehouseProductId ?? null;
    const warehouseProduct = item.warehouseProduct ?? mapping?.warehouseProduct ?? null;
    const requiredQuantity = item.quantity;

    if (!warehouseProductId || !warehouseProduct) {
      return {
        orderItemId: item.id,
        sku: item.sku,
        productName: item.productNameSnapshot,
        requiredQuantity,
        coveredQuantity: 0,
        missingQuantity: requiredQuantity,
        status: 'MISSING_MAPPING',
        message: 'Brak aktywnego mapowania produktu sklepu do magazynu',
      };
    }

    // Produkt wykluczony ze stanu (np. usluga, produkt wirtualny) nigdy nie ma
    // rezerwacji i nie moze blokowac faktury.
    if (!warehouseProduct.isStockTracked) {
      return {
        orderItemId: item.id,
        sku: item.sku,
        productName: item.productNameSnapshot,
        requiredQuantity,
        coveredQuantity: 0,
        missingQuantity: 0,
        status: 'NOT_TRACKED',
        message: 'Produkt wykluczony z magazynu',
      };
    }

    const itemReservations = reservations.filter(
      (reservation) => reservation.orderItemId === item.id && reservation.warehouseProductId === warehouseProductId,
    );
    let covered = itemReservations
      .filter((reservation) => reservation.status === 'CONSUMED' || reservation.source === 'LOCAL_STOCK')
      .reduce((sum, reservation) => sum.plus(reservation.quantity), new Prisma.Decimal(0));

    const issued = issuedByProduct.get(warehouseProductId);
    if (issued?.gt(0) && covered.lt(requiredQuantity)) {
      const usable = Prisma.Decimal.min(issued, new Prisma.Decimal(requiredQuantity).minus(covered));
      covered = covered.plus(usable);
      issuedByProduct.set(warehouseProductId, issued.minus(usable));
    }

    const coveredQuantity = decimalToNumber(covered);
    const missingQuantity = Math.max(0, requiredQuantity - coveredQuantity);

    const hasBackorder = itemReservations.some(
      (reservation) => reservation.status === 'ACTIVE' && reservation.source === 'WHOLESALE_BACKORDER',
    ) || item.shippingSource === 'WHOLESALE_BACKORDER';
    const status = classifyCoverage({
      requiredQuantity,
      coveredQuantity,
      hasMapping: true,
      isStockTracked: true,
      hasBackorder,
    });

    return {
      orderItemId: item.id,
      sku: item.sku,
      productName: item.productNameSnapshot,
      requiredQuantity,
      coveredQuantity,
      missingQuantity: status === 'COVERED' ? 0 : missingQuantity,
      status,
      ...(status === 'BACKORDER' ? { message: 'Pozycja czeka na domówienie z hurtowni' } : {}),
      ...(status === 'SHORTAGE' ? { message: 'Brak wystarczającej rezerwacji na stanie lokalnym' } : {}),
    };
  });

  const blocking = items.filter((item) => isBlockingCoverageStatus(item.status));

  return {
    orderId: order.id,
    covered: blocking.length === 0,
    items,
    blocking,
  };
}
