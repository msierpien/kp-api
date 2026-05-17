import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { getTenantId } from '../../lib/tenant-context';

export interface StockEntry {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number; // może być ujemna (brak towaru)
}

// Typy dokumentów które dodają do stanu
const INCOMING_TYPES = ['PZ', 'PW'];
// Typy dokumentów które odejmują od stanu
const OUTGOING_TYPES = ['WZ', 'RW'];

export async function getStock(): Promise<StockEntry[]> {
  const tenantId = getTenantId();
  const productWhere: any = {};
  if (tenantId) productWhere.tenantId = tenantId;

  const products = await prisma.warehouseProduct.findMany({
    where: { ...productWhere, isActive: true },
    include: {
      items: {
        include: { document: true },
        where: { document: { status: 'CONFIRMED' } },
      },
      warehouseReservations: {
        where: { status: 'ACTIVE' },
        select: { quantity: true },
      },
    },
    orderBy: { name: 'asc' },
  });

  return products.map((product) => {
    const quantity = calculateQuantity(product.items, product.warehouseReservations);
    return { productId: product.id, sku: product.sku, name: product.name, unit: product.unit, quantity };
  });
}

export async function getProductStock(productId: string): Promise<StockEntry | null> {
  const tenantId = getTenantId();
  const where: any = { id: productId };
  if (tenantId) where.tenantId = tenantId;

  const product = await prisma.warehouseProduct.findFirst({
    where,
    include: {
      items: {
        include: { document: true },
        where: { document: { status: 'CONFIRMED' } },
      },
      warehouseReservations: {
        where: { status: 'ACTIVE' },
        select: { quantity: true },
      },
    },
  });

  if (!product) return null;

  const quantity = calculateQuantity(product.items, product.warehouseReservations);

  return { productId: product.id, sku: product.sku, name: product.name, unit: product.unit, quantity };
}

export async function recalculateStockCache() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');

  const products = await prisma.warehouseProduct.findMany({
    where: { tenantId },
    include: {
      items: {
        include: { document: true },
        where: { document: { status: 'CONFIRMED' } },
      },
      warehouseReservations: {
        where: { status: 'ACTIVE' },
        select: { quantity: true },
      },
    },
  });

  await prisma.$transaction(
    products.map((product) =>
      prisma.warehouseProduct.update({
        where: { id: product.id },
        data: { currentStock: new Prisma.Decimal(calculateQuantity(product.items, product.warehouseReservations)) },
      }),
    ),
  );

  return { updated: products.length };
}

function calculateQuantity(
  items: Array<{ quantity: Prisma.Decimal; document: { type: string } }>,
  reservations: Array<{ quantity: Prisma.Decimal }> = [],
) {
  let quantity = 0;
  for (const item of items) {
    const type = item.document.type;
    const qty = Number(item.quantity);
    if (INCOMING_TYPES.includes(type)) {
      quantity += qty;
    } else if (OUTGOING_TYPES.includes(type)) {
      quantity -= qty;
    }
  }
  for (const reservation of reservations) {
    quantity -= Number(reservation.quantity);
  }
  return quantity;
}
