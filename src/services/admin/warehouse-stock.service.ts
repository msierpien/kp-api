import prisma from '../../lib/prisma';
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
    },
    orderBy: { name: 'asc' },
  });

  return products.map((product) => {
    let quantity = 0;
    for (const item of product.items) {
      const type = item.document.type;
      const qty = Number(item.quantity);
      if (INCOMING_TYPES.includes(type)) {
        quantity += qty;
      } else if (OUTGOING_TYPES.includes(type)) {
        quantity -= qty;
      }
    }
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
    },
  });

  if (!product) return null;

  let quantity = 0;
  for (const item of product.items) {
    const type = item.document.type;
    const qty = Number(item.quantity);
    if (INCOMING_TYPES.includes(type)) {
      quantity += qty;
    } else if (OUTGOING_TYPES.includes(type)) {
      quantity -= qty;
    }
  }

  return { productId: product.id, sku: product.sku, name: product.name, unit: product.unit, quantity };
}
