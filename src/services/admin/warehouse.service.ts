import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { syncStockForProducts } from '../stock/stock-sync.service';
import { resolveCatalogForProduct } from './warehouse-catalogs.service';

// ─── Products ────────────────────────────────────────────────────────────────

export interface CreateProductInput {
  catalogId?: string | null;
  sku: string;
  name: string;
  unit?: string;
  description?: string;
  purchasePrice?: number;
  retailPrice?: number;
}

export interface UpdateProductInput {
  catalogId?: string | null;
  name?: string;
  unit?: string;
  description?: string;
  purchasePrice?: number | null;
  retailPrice?: number | null;
  isActive?: boolean;
}

export interface ProductsQuery {
  page?: number;
  limit?: number;
  search?: string;
  catalogId?: string;
  isActive?: boolean;
  stockBelow?: number;
  hasBarcode?: boolean;
  hasShopMapping?: boolean;
  hasWholesaleOffer?: boolean;
}

function requireTenantId() {
  const tenantId = getTenantId();
  const context = getTenantContext();
  if (!tenantId && context?.role !== 'SUPER_ADMIN') throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

export async function getProducts(query: ProductsQuery = {}) {
  const tenantId = requireTenantId();
  const {
    page = 1,
    limit = 50,
    search,
    catalogId,
    isActive,
    stockBelow,
    hasBarcode,
    hasShopMapping,
    hasWholesaleOffer,
  } = query;
  const skip = (page - 1) * limit;

  const where: any = {};
  if (tenantId) where.tenantId = tenantId;
  if (catalogId) where.catalogId = catalogId;
  if (isActive !== undefined) where.isActive = isActive;
  if (stockBelow !== undefined) where.currentStock = { lt: stockBelow };
  if (hasBarcode !== undefined) {
    where.barcodes = hasBarcode
      ? { some: { isActive: true } }
      : { none: { isActive: true } };
  }
  if (hasShopMapping !== undefined) {
    where.shopProductMappings = hasShopMapping
      ? { some: { isActive: true } }
      : { none: { isActive: true } };
  }
  if (hasWholesaleOffer !== undefined) {
    where.wholesaleMappings = hasWholesaleOffer
      ? { some: { isActive: true } }
      : { none: { isActive: true } };
  }
  if (search) {
    where.OR = [
      { sku: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.warehouseProduct.findMany({
      where,
      skip,
      take: limit,
      orderBy: { name: 'asc' },
      include: {
        catalog: true,
        _count: {
          select: {
            barcodes: { where: { isActive: true } },
            shopProductMappings: { where: { isActive: true } },
            wholesaleMappings: { where: { isActive: true } },
          },
        },
      },
    }),
    prisma.warehouseProduct.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getProductById(id: string) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  return prisma.warehouseProduct.findFirst({ where, include: { catalog: true } });
}

export async function createProduct(input: CreateProductInput) {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');

  const existing = await prisma.warehouseProduct.findUnique({
    where: { tenantId_sku: { tenantId, sku: input.sku } },
  });
  if (existing) throw new Error(`Produkt z SKU "${input.sku}" już istnieje`);

  const catalog = await resolveCatalogForProduct(tenantId, input.catalogId);

  return prisma.warehouseProduct.create({
    data: {
      tenantId,
      catalogId: catalog.id,
      sku: input.sku,
      name: input.name,
      unit: input.unit ?? 'szt',
      description: input.description,
      purchasePrice: input.purchasePrice,
      retailPrice: input.retailPrice,
    },
  });
}

export async function updateProduct(id: string, input: UpdateProductInput) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const product = await prisma.warehouseProduct.findFirst({ where });
  if (!product) throw new Error('Produkt nie znaleziony');

  const data: Prisma.WarehouseProductUpdateInput = { ...input };
  delete (data as any).catalogId;

  if (input.catalogId !== undefined) {
    const catalog = await resolveCatalogForProduct(product.tenantId, input.catalogId);
    data.catalog = { connect: { id: catalog.id } };
  }

  return prisma.warehouseProduct.update({
    where: { id },
    data,
    include: { catalog: true },
  });
}

export async function deleteProduct(id: string) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const product = await prisma.warehouseProduct.findFirst({ where });
  if (!product) throw new Error('Produkt nie znaleziony');

  const itemCount = await prisma.warehouseDocumentItem.count({ where: { productId: id } });
  if (itemCount > 0) throw new Error('Nie można usunąć produktu — posiada powiązane pozycje dokumentów');

  return prisma.warehouseProduct.delete({ where: { id } });
}

// ─── Documents ───────────────────────────────────────────────────────────────

export type DocumentType = 'PZ' | 'PW' | 'WZ' | 'RW';
const STOCK_INCOMING_TYPES: DocumentType[] = ['PZ', 'PW'];
const STOCK_OUTGOING_TYPES: DocumentType[] = ['WZ', 'RW'];

export interface DocumentItemInput {
  productId: string;
  quantity?: number;
  barcodeId?: string;
  scannedEan?: string;
  baseQuantity?: number;
  quantityMultiplier?: number;
  unitPrice?: number;
  notes?: string;
}

export interface CreateDocumentInput {
  type: DocumentType;
  date?: string;
  description?: string;
  orderId?: string;
  isAutoGenerated?: boolean;
  metadataJson?: Prisma.InputJsonValue;
  items: DocumentItemInput[];
}

export interface UpdateDocumentInput {
  date?: string;
  description?: string;
  orderId?: string | null;
  items?: DocumentItemInput[];
}

export interface CancelDocumentInput {
  reason?: string;
}

export interface CreateWzForOrderResult {
  document: Awaited<ReturnType<typeof getDocumentById>>;
  created: boolean;
  skippedReason?: string;
}

export interface DocumentsQuery {
  page?: number;
  limit?: number;
  type?: DocumentType;
  status?: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
  dateFrom?: string;
  dateTo?: string;
}

interface PreparedDocumentItem {
  productId: string;
  quantity: number;
  barcodeId?: string;
  scannedEan?: string;
  baseQuantity?: number;
  quantityMultiplier?: number;
  unitPrice?: number;
  notes?: string;
}

export async function getDocuments(query: DocumentsQuery = {}) {
  const tenantId = getTenantId();
  const { page = 1, limit = 20, type, status, dateFrom, dateTo } = query;
  const skip = (page - 1) * limit;

  const where: any = {};
  if (tenantId) where.tenantId = tenantId;
  if (type) where.type = type;
  if (status) where.status = status;
  if (dateFrom || dateTo) {
    where.date = {};
    if (dateFrom) where.date.gte = new Date(dateFrom);
    if (dateTo) where.date.lte = new Date(dateTo);
  }

  const [data, total] = await Promise.all([
    prisma.warehouseDocument.findMany({
      where,
      skip,
      take: limit,
      orderBy: { date: 'desc' },
      include: { items: { include: { product: true, barcode: true } } },
    }),
    prisma.warehouseDocument.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getDocumentById(id: string) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  return prisma.warehouseDocument.findFirst({
    where,
    include: { items: { include: { product: true, barcode: true } }, order: true },
  });
}

export async function createDocument(input: CreateDocumentInput) {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');

  const preparedItems = await prepareDocumentItems(tenantId, input.items, true);
  const context = getTenantContext();

  return prisma.$transaction(async (tx) => {
    const number = await generateDocumentNumber(tx, tenantId, input.type);

    return tx.warehouseDocument.create({
      data: {
        tenantId,
        number,
        type: input.type,
        status: 'DRAFT',
        date: input.date ? new Date(input.date) : new Date(),
        description: input.description,
        orderId: input.orderId,
        createdByUserId: context?.userId,
        isAutoGenerated: input.isAutoGenerated ?? false,
        metadataJson: input.metadataJson,
        items: {
          create: preparedItems.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            barcodeId: item.barcodeId,
            scannedEan: item.scannedEan,
            baseQuantity: item.baseQuantity,
            quantityMultiplier: item.quantityMultiplier,
            unitPrice: item.unitPrice,
            notes: item.notes,
          })),
        },
      },
      include: { items: { include: { product: true, barcode: true } } },
    });
  });
}

export async function createWzForOrder(orderId: string): Promise<CreateWzForOrderResult> {
  const contextTenantId = getTenantId();
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      ...(contextTenantId ? { shop: { tenantId: contextTenantId } } : {}),
    },
    include: {
      shop: true,
      items: true,
    },
  });

  if (!order) throw new Error('Zamówienie nie znalezione');

  const existingDocument = await prisma.warehouseDocument.findFirst({
    where: {
      tenantId: order.shop.tenantId,
      orderId,
      type: 'WZ',
      status: { not: 'CANCELLED' },
    },
    include: { items: { include: { product: true, barcode: true } }, order: true },
  });

  if (existingDocument) {
    return { document: existingDocument, created: false, skippedReason: 'WZ dla tego zamówienia już istnieje' };
  }

  if (order.items.length === 0) {
    return { document: null, created: false, skippedReason: 'Zamówienie nie ma pozycji' };
  }

  const mappings = await prisma.shopProductMapping.findMany({
    where: {
      tenantId: order.shop.tenantId,
      shopId: order.shopId,
      isActive: true,
      warehouseProductId: { not: null },
    },
    include: { warehouseProduct: true },
  });

  const mappingBySku = new Map(
    mappings.map((mapping) => [normalizeSku(mapping.externalSku), mapping]),
  );

  const itemsByProduct = new Map<string, {
    productId: string;
    quantity: number;
    productName: string;
    currentStock: number;
  }>();

  for (const item of order.items) {
    const mapping = mappingBySku.get(normalizeSku(item.sku));
    if (!mapping?.warehouseProduct) continue;

    const existing = itemsByProduct.get(mapping.warehouseProduct.id);
    if (existing) {
      existing.quantity += item.quantity;
      continue;
    }

    itemsByProduct.set(mapping.warehouseProduct.id, {
      productId: mapping.warehouseProduct.id,
      quantity: item.quantity,
      productName: mapping.warehouseProduct.name,
      currentStock: Number(mapping.warehouseProduct.currentStock),
    });
  }

  const items = Array.from(itemsByProduct.values());
  if (items.length === 0) {
    return { document: null, created: false, skippedReason: 'Brak pozycji zamówienia powiązanych z magazynem' };
  }

  const stockWarning = items.some((item) => item.currentStock - item.quantity < 0);
  const settings = await getWarehouseSettings(order.shop.tenantId);

  if (settings.autoConfirmWzOnOrder) {
    await assertCanConfirmWithoutNegativeStock(
      order.shop.tenantId,
      'WZ',
      items.map((item) => ({
        productId: item.productId,
        quantity: new Prisma.Decimal(item.quantity),
        product: { name: item.productName, unit: 'szt' },
      })),
    );
  }

  const document = await prisma.$transaction(async (tx) => {
    const number = await generateDocumentNumber(tx, order.shop.tenantId, 'WZ');

    if (settings.autoConfirmWzOnOrder) {
      await applyStockDeltas(
        tx,
        'WZ',
        items.map((item) => ({
          productId: item.productId,
          quantity: new Prisma.Decimal(item.quantity),
        })),
      );
    }

    return tx.warehouseDocument.create({
      data: {
        tenantId: order.shop.tenantId,
        number,
        type: 'WZ',
        status: settings.autoConfirmWzOnOrder ? 'CONFIRMED' : 'DRAFT',
        date: new Date(),
        description: `WZ automatyczne dla zamówienia ${order.orderReference}`,
        orderId: order.id,
        isAutoGenerated: true,
        metadataJson: stockWarning ? { stockWarning: true } : undefined,
        confirmedAt: settings.autoConfirmWzOnOrder ? new Date() : undefined,
        items: {
          create: items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            notes: `Zamówienie ${order.orderReference}`,
          })),
        },
      },
      include: { items: { include: { product: true, barcode: true } }, order: true },
    });
  });

  return { document, created: true };
}

export async function updateDocument(id: string, input: UpdateDocumentInput) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const doc = await prisma.warehouseDocument.findFirst({ where });
  if (!doc) throw new Error('Dokument nie znaleziony');
  if (doc.status !== 'DRAFT') throw new Error('Można edytować tylko dokumenty w statusie DRAFT');

  const data: any = {};
  if (input.date !== undefined) data.date = new Date(input.date);
  if (input.description !== undefined) data.description = input.description;
  if (input.orderId !== undefined) data.orderId = input.orderId;

  if (input.items) {
    const preparedItems = await prepareDocumentItems(tenantId ?? doc.tenantId, input.items, true);

    await prisma.warehouseDocumentItem.deleteMany({ where: { documentId: id } });
    data.items = {
      create: preparedItems.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        barcodeId: item.barcodeId,
        scannedEan: item.scannedEan,
        baseQuantity: item.baseQuantity,
        quantityMultiplier: item.quantityMultiplier,
        unitPrice: item.unitPrice,
        notes: item.notes,
      })),
    };
  }

  return prisma.warehouseDocument.update({
    where: { id },
    data,
    include: { items: { include: { product: true, barcode: true } } },
  });
}

export async function confirmDocument(id: string) {
  const tenantId = getTenantId();
  const context = getTenantContext();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const doc = await prisma.warehouseDocument.findFirst({
    where,
    include: { items: { include: { product: true } } },
  });
  if (!doc) throw new Error('Dokument nie znaleziony');
  if (doc.status !== 'DRAFT') throw new Error('Tylko dokumenty DRAFT można zatwierdzić');

  if (doc.items.length === 0) throw new Error('Dokument nie ma żadnych pozycji');

  await assertCanConfirmWithoutNegativeStock(doc.tenantId, doc.type, doc.items);

  const confirmedDocument = await prisma.$transaction(async (tx) => {
    await applyStockDeltas(tx, doc.type, doc.items);

    return tx.warehouseDocument.update({
      where: { id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedByUserId: context?.userId,
      },
      include: { items: { include: { product: true, barcode: true } } },
    });
  });

  await syncStockForProducts(
    doc.items.map((item) => item.productId),
    'DOCUMENT_CONFIRM',
    id,
  );

  return confirmedDocument;
}

async function assertCanConfirmWithoutNegativeStock(
  tenantId: string,
  type: DocumentType,
  items: Array<{ productId: string; quantity: Prisma.Decimal; product: { name: string; unit: string } }>,
) {
  if (!['WZ', 'RW'].includes(type)) return;

  const settings = await getWarehouseSettings(tenantId);
  if (settings.allowNegativeStock) return;

  const requestedByProduct = new Map<string, { quantity: number; name: string; unit: string }>();

  for (const item of items) {
    const existing = requestedByProduct.get(item.productId);
    const quantity = Number(item.quantity);

    if (existing) {
      existing.quantity += quantity;
    } else {
      requestedByProduct.set(item.productId, {
        quantity,
        name: item.product.name,
        unit: item.product.unit,
      });
    }
  }

  for (const [productId, requested] of requestedByProduct) {
    const stock = await calculateProductStock(tenantId, productId);
    const requestedQuantity = requested.quantity;
    const nextStock = stock - requestedQuantity;

    if (nextStock < 0) {
      throw new Error(
        `Niewystarczający stan produktu "${requested.name}": dostępne ${stock} ${requested.unit}, wymagane ${requestedQuantity} ${requested.unit}`,
      );
    }
  }
}

async function getWarehouseSettings(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { limitsJson: true },
  });

  const limits = tenant?.limitsJson as any;
  return {
    allowNegativeStock: limits?.warehouse?.allowNegativeStock !== false,
    autoCreateWzOnOrder: limits?.warehouse?.autoCreateWzOnOrder !== false,
    autoConfirmWzOnOrder: limits?.warehouse?.autoConfirmWzOnOrder === true,
  };
}

export async function shouldAutoCreateWzForTenant(tenantId: string) {
  const settings = await getWarehouseSettings(tenantId);
  return settings.autoCreateWzOnOrder;
}

function normalizeSku(value: string) {
  return value.trim().toLowerCase();
}

async function calculateProductStock(tenantId: string, productId: string) {
  const items = await prisma.warehouseDocumentItem.findMany({
    where: {
      productId,
      document: {
        tenantId,
        status: 'CONFIRMED',
      },
    },
    include: {
      document: true,
    },
  });

  return items.reduce((stock, item) => {
    const quantity = Number(item.quantity);
    if (['PZ', 'PW'].includes(item.document.type)) return stock + quantity;
    if (['WZ', 'RW'].includes(item.document.type)) return stock - quantity;
    return stock;
  }, 0);
}

export async function cancelDocument(id: string, input: CancelDocumentInput = {}) {
  const tenantId = getTenantId();
  const context = getTenantContext();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const doc = await prisma.warehouseDocument.findFirst({
    where,
    include: { items: true },
  });
  if (!doc) throw new Error('Dokument nie znaleziony');
  if (doc.status === 'CANCELLED') throw new Error('Dokument jest już anulowany');

  const cancelledDocument = await prisma.$transaction(async (tx) => {
    if (doc.status === 'CONFIRMED') {
      await applyStockDeltas(tx, doc.type, doc.items, true);
    }

    return tx.warehouseDocument.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledByUserId: context?.userId,
        cancelReason: input.reason,
      },
      include: { items: { include: { product: true, barcode: true } } },
    });
  });

  if (doc.status === 'CONFIRMED') {
    await syncStockForProducts(
      doc.items.map((item) => item.productId),
      'DOCUMENT_CANCEL',
      id,
    );
  }

  return cancelledDocument;
}

export async function deleteDocument(id: string) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const doc = await prisma.warehouseDocument.findFirst({ where });
  if (!doc) throw new Error('Dokument nie znaleziony');
  if (doc.status !== 'DRAFT') throw new Error('Można usunąć tylko dokumenty w statusie DRAFT');

  return prisma.warehouseDocument.delete({ where: { id } });
}

async function prepareDocumentItems(
  tenantId: string,
  items: DocumentItemInput[],
  requireActiveProduct: boolean,
): Promise<PreparedDocumentItem[]> {
  const preparedItems: PreparedDocumentItem[] = [];

  for (const item of items) {
    const product = await prisma.warehouseProduct.findFirst({
      where: { id: item.productId, tenantId },
    });
    if (!product) throw new Error(`Produkt ${item.productId} nie znaleziony`);
    if (requireActiveProduct && !product.isActive) throw new Error(`Produkt "${product.name}" jest nieaktywny`);

    let scannedEan = item.scannedEan?.trim() || undefined;
    let quantityMultiplier = item.quantityMultiplier;
    const barcodeId = item.barcodeId;

    if (barcodeId) {
      const barcode = await prisma.warehouseProductBarcode.findFirst({
        where: { id: barcodeId, tenantId, warehouseProductId: item.productId },
      });
      if (!barcode) throw new Error(`Kod EAN ${barcodeId} nie znaleziony dla produktu "${product.name}"`);
      if (!barcode.isActive) throw new Error(`Kod EAN "${barcode.ean}" jest nieaktywny`);
      scannedEan = scannedEan ?? barcode.ean;
      quantityMultiplier = quantityMultiplier ?? Number(barcode.quantityMultiplier);
    }

    const baseQuantity = item.baseQuantity ?? item.quantity;
    if (baseQuantity === undefined || baseQuantity <= 0) throw new Error('Ilość pozycji musi być większa od 0');

    quantityMultiplier = quantityMultiplier ?? 1;
    if (quantityMultiplier <= 0) throw new Error('Przelicznik EAN musi być większy od 0');

    const quantity = item.quantity ?? baseQuantity * quantityMultiplier;
    if (quantity <= 0) throw new Error('Ilość pozycji musi być większa od 0');

    preparedItems.push({
      productId: item.productId,
      quantity,
      barcodeId,
      scannedEan,
      baseQuantity,
      quantityMultiplier,
      unitPrice: item.unitPrice,
      notes: item.notes,
    });
  }

  return preparedItems;
}

async function applyStockDeltas(
  tx: Prisma.TransactionClient,
  type: DocumentType,
  items: Array<{ productId: string; quantity: Prisma.Decimal }>,
  reverse = false,
) {
  const baseSign = getStockDeltaSign(type);
  if (baseSign === 0) return;

  const sign = reverse ? -baseSign : baseSign;
  const deltas = new Map<string, Prisma.Decimal>();

  for (const item of items) {
    const current = deltas.get(item.productId) ?? new Prisma.Decimal(0);
    deltas.set(item.productId, current.plus(item.quantity.mul(sign)));
  }

  for (const [productId, delta] of deltas) {
    await tx.warehouseProduct.update({
      where: { id: productId },
      data: { currentStock: { increment: delta } },
    });
  }
}

function getStockDeltaSign(type: DocumentType) {
  if (STOCK_INCOMING_TYPES.includes(type)) return 1;
  if (STOCK_OUTGOING_TYPES.includes(type)) return -1;
  return 0;
}

// ─── Numeracja dokumentów ─────────────────────────────────────────────────────

async function generateDocumentNumber(
  tx: Prisma.TransactionClient,
  tenantId: string,
  type: DocumentType,
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `${type}/${year}/`;
  const lockKey = `${tenantId}:${type}:${year}`;

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

  // Znajdź najwyższy numer w tym roku dla tego tenanta i typu
  const last = await tx.warehouseDocument.findFirst({
    where: { tenantId, number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
  });

  let seq = 1;
  if (last) {
    const parts = last.number.split('/');
    const lastSeq = parseInt(parts[2], 10);
    if (!isNaN(lastSeq)) seq = lastSeq + 1;
  }

  return `${prefix}${String(seq).padStart(3, '0')}`;
}
