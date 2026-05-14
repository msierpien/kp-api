import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';

// ─── Products ────────────────────────────────────────────────────────────────

export interface CreateProductInput {
  sku: string;
  name: string;
  unit?: string;
  description?: string;
}

export interface UpdateProductInput {
  name?: string;
  unit?: string;
  description?: string;
  isActive?: boolean;
}

export interface ProductsQuery {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

export async function getProducts(query: ProductsQuery = {}) {
  const tenantId = getTenantId();
  const { page = 1, limit = 50, search, isActive } = query;
  const skip = (page - 1) * limit;

  const where: any = {};
  if (tenantId) where.tenantId = tenantId;
  if (isActive !== undefined) where.isActive = isActive;
  if (search) {
    where.OR = [
      { sku: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.warehouseProduct.findMany({ where, skip, take: limit, orderBy: { name: 'asc' } }),
    prisma.warehouseProduct.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getProductById(id: string) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  return prisma.warehouseProduct.findFirst({ where });
}

export async function createProduct(input: CreateProductInput) {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');

  const existing = await prisma.warehouseProduct.findUnique({
    where: { tenantId_sku: { tenantId, sku: input.sku } },
  });
  if (existing) throw new Error(`Produkt z SKU "${input.sku}" już istnieje`);

  return prisma.warehouseProduct.create({
    data: { tenantId, sku: input.sku, name: input.name, unit: input.unit ?? 'szt', description: input.description },
  });
}

export async function updateProduct(id: string, input: UpdateProductInput) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const product = await prisma.warehouseProduct.findFirst({ where });
  if (!product) throw new Error('Produkt nie znaleziony');

  return prisma.warehouseProduct.update({ where: { id }, data: input });
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

export interface DocumentItemInput {
  productId: string;
  quantity: number;
  unitPrice?: number;
  notes?: string;
}

export interface CreateDocumentInput {
  type: DocumentType;
  date?: string;
  description?: string;
  orderId?: string;
  items: DocumentItemInput[];
}

export interface UpdateDocumentInput {
  date?: string;
  description?: string;
  orderId?: string | null;
  items?: DocumentItemInput[];
}

export interface DocumentsQuery {
  page?: number;
  limit?: number;
  type?: DocumentType;
  status?: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
  dateFrom?: string;
  dateTo?: string;
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
      include: { items: { include: { product: true } } },
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
    include: { items: { include: { product: true } }, order: true },
  });
}

export async function createDocument(input: CreateDocumentInput) {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');

  // Weryfikacja produktów
  for (const item of input.items) {
    const product = await prisma.warehouseProduct.findFirst({
      where: { id: item.productId, tenantId },
    });
    if (!product) throw new Error(`Produkt ${item.productId} nie znaleziony`);
    if (!product.isActive) throw new Error(`Produkt "${product.name}" jest nieaktywny`);
  }

  const number = await generateDocumentNumber(tenantId, input.type);

  return prisma.warehouseDocument.create({
    data: {
      tenantId,
      number,
      type: input.type,
      status: 'DRAFT',
      date: input.date ? new Date(input.date) : new Date(),
      description: input.description,
      orderId: input.orderId,
      items: {
        create: input.items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          notes: item.notes,
        })),
      },
    },
    include: { items: { include: { product: true } } },
  });
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
    // Weryfikacja produktów
    for (const item of input.items) {
      const product = await prisma.warehouseProduct.findFirst({
        where: { id: item.productId, tenantId: tenantId ?? undefined },
      });
      if (!product) throw new Error(`Produkt ${item.productId} nie znaleziony`);
    }

    await prisma.warehouseDocumentItem.deleteMany({ where: { documentId: id } });
    data.items = {
      create: input.items.map((item) => ({
        productId: item.productId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        notes: item.notes,
      })),
    };
  }

  return prisma.warehouseDocument.update({
    where: { id },
    data,
    include: { items: { include: { product: true } } },
  });
}

export async function confirmDocument(id: string) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const doc = await prisma.warehouseDocument.findFirst({ where });
  if (!doc) throw new Error('Dokument nie znaleziony');
  if (doc.status !== 'DRAFT') throw new Error('Tylko dokumenty DRAFT można zatwierdzić');

  const itemCount = await prisma.warehouseDocumentItem.count({ where: { documentId: id } });
  if (itemCount === 0) throw new Error('Dokument nie ma żadnych pozycji');

  return prisma.warehouseDocument.update({
    where: { id },
    data: { status: 'CONFIRMED' },
    include: { items: { include: { product: true } } },
  });
}

export async function cancelDocument(id: string) {
  const tenantId = getTenantId();
  const where: any = { id };
  if (tenantId) where.tenantId = tenantId;

  const doc = await prisma.warehouseDocument.findFirst({ where });
  if (!doc) throw new Error('Dokument nie znaleziony');
  if (doc.status === 'CANCELLED') throw new Error('Dokument jest już anulowany');

  return prisma.warehouseDocument.update({
    where: { id },
    data: { status: 'CANCELLED' },
    include: { items: { include: { product: true } } },
  });
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

// ─── Numeracja dokumentów ─────────────────────────────────────────────────────

async function generateDocumentNumber(tenantId: string, type: DocumentType): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `${type}/${year}/`;

  // Znajdź najwyższy numer w tym roku dla tego tenanta i typu
  const last = await prisma.warehouseDocument.findFirst({
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
