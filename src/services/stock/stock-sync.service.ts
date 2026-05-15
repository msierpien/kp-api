import prisma from '../../lib/prisma';
import { addStockSyncJob, type StockSyncTriggeredBy } from '../queue/stock-sync.queue';

export async function syncStockToAllShops(
  warehouseProductId: string,
  triggeredBy: StockSyncTriggeredBy,
  documentId?: string,
) {
  const product = await prisma.warehouseProduct.findUnique({
    where: { id: warehouseProductId },
  });
  if (!product) throw new Error(`Produkt magazynowy nie znaleziony: ${warehouseProductId}`);

  const mappings = await prisma.shopProductMapping.findMany({
    where: {
      tenantId: product.tenantId,
      warehouseProductId,
      isActive: true,
      shop: {
        status: 'ACTIVE',
      },
    },
    include: { shop: true },
  });

  const jobs = [];
  for (const mapping of mappings) {
    const log = await prisma.stockSyncLog.create({
      data: {
        tenantId: product.tenantId,
        warehouseProductId,
        shopId: mapping.shopId,
        triggeredBy,
        documentId,
        stockBefore: null,
        stockAfter: product.currentStock,
        status: 'PENDING',
      },
    });

    jobs.push(await addStockSyncJob({
      logId: log.id,
      tenantId: product.tenantId,
      warehouseProductId,
      shopId: mapping.shopId,
      externalProductId: mapping.externalProductId,
      triggeredBy,
      documentId,
    }));
  }

  return { enqueued: jobs.length };
}

export async function syncStockForProducts(
  warehouseProductIds: string[],
  triggeredBy: StockSyncTriggeredBy,
  documentId?: string,
) {
  const uniqueIds = Array.from(new Set(warehouseProductIds));
  let enqueued = 0;

  for (const productId of uniqueIds) {
    const result = await syncStockToAllShops(productId, triggeredBy, documentId);
    enqueued += result.enqueued;
  }

  return { enqueued };
}
