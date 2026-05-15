import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';
import { getTenantId } from '../../lib/tenant-context';

type DbClient = typeof prisma | Prisma.TransactionClient;

export interface CatalogsQuery {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

export interface CatalogProductsQuery {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

export interface CreateCatalogInput {
  code: string;
  name: string;
  description?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
}

export interface UpdateCatalogInput {
  code?: string;
  name?: string;
  description?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
}

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

function normalizeCode(code: string) {
  return code.trim().toLowerCase();
}

export async function getCatalogs(query: CatalogsQuery = {}) {
  const tenantId = requireTenantId();
  const { page = 1, limit = 50, search, isActive } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.WarehouseCatalogWhereInput = { tenantId };
  if (isActive !== undefined) where.isActive = isActive;
  if (search) {
    where.OR = [
      { code: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.warehouseCatalog.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    }),
    prisma.warehouseCatalog.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getCatalogById(id: string) {
  const tenantId = requireTenantId();

  return prisma.warehouseCatalog.findFirst({
    where: { id, tenantId },
    include: { _count: { select: { products: true } } },
  });
}

export async function createCatalog(input: CreateCatalogInput) {
  const tenantId = requireTenantId();
  const code = normalizeCode(input.code);
  if (!code) throw new Error('Kod katalogu jest wymagany');

  return prisma.$transaction(async (tx) => {
    const existing = await tx.warehouseCatalog.findUnique({
      where: { tenantId_code: { tenantId, code } },
    });
    if (existing) throw new Error(`Katalog z kodem "${code}" już istnieje`);

    const catalogCount = await tx.warehouseCatalog.count({ where: { tenantId } });
    const isDefault = input.isDefault === true || catalogCount === 0;

    if (isDefault) {
      await tx.warehouseCatalog.updateMany({
        where: { tenantId, isDefault: true },
        data: { isDefault: false },
      });
    }

    return tx.warehouseCatalog.create({
      data: {
        tenantId,
        code,
        name: input.name.trim(),
        description: input.description,
        isDefault,
        isActive: input.isActive ?? true,
      },
      include: { _count: { select: { products: true } } },
    });
  });
}

export async function updateCatalog(id: string, input: UpdateCatalogInput) {
  const tenantId = requireTenantId();

  return prisma.$transaction(async (tx) => {
    const catalog = await tx.warehouseCatalog.findFirst({ where: { id, tenantId } });
    if (!catalog) throw new Error('Katalog nie znaleziony');

    const data: Prisma.WarehouseCatalogUpdateInput = {};

    if (input.code !== undefined) {
      const code = normalizeCode(input.code);
      if (!code) throw new Error('Kod katalogu jest wymagany');

      const existing = await tx.warehouseCatalog.findUnique({
        where: { tenantId_code: { tenantId, code } },
      });
      if (existing && existing.id !== id) throw new Error(`Katalog z kodem "${code}" już istnieje`);

      data.code = code;
    }

    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) data.description = input.description;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    if (input.isDefault === true && !catalog.isDefault) {
      await tx.warehouseCatalog.updateMany({
        where: { tenantId, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
      data.isDefault = true;
      data.isActive = true;
    }

    return tx.warehouseCatalog.update({
      where: { id },
      data,
      include: { _count: { select: { products: true } } },
    });
  });
}

export async function deleteCatalog(id: string) {
  const tenantId = requireTenantId();
  const catalog = await prisma.warehouseCatalog.findFirst({
    where: { id, tenantId },
    include: { _count: { select: { products: true } } },
  });

  if (!catalog) throw new Error('Katalog nie znaleziony');
  if (catalog.isDefault) throw new Error('Nie można usunąć domyślnego katalogu');
  if (catalog._count.products > 0) throw new Error('Nie można usunąć katalogu, który ma produkty');

  return prisma.warehouseCatalog.delete({ where: { id } });
}

export async function getCatalogProducts(id: string, query: CatalogProductsQuery = {}) {
  const tenantId = requireTenantId();
  const catalog = await prisma.warehouseCatalog.findFirst({ where: { id, tenantId } });
  if (!catalog) throw new Error('Katalog nie znaleziony');

  const { page = 1, limit = 50, search, isActive } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.WarehouseProductWhereInput = { tenantId, catalogId: id };
  if (isActive !== undefined) where.isActive = isActive;
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
      include: { catalog: true },
    }),
    prisma.warehouseProduct.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function ensureDefaultCatalog(tenantId: string, db: DbClient = prisma) {
  const defaultCatalog = await db.warehouseCatalog.findFirst({
    where: { tenantId, isDefault: true },
  });
  if (defaultCatalog) return defaultCatalog;

  return db.warehouseCatalog.upsert({
    where: { tenantId_code: { tenantId, code: 'default' } },
    create: {
      tenantId,
      code: 'default',
      name: 'Katalog główny',
      description: 'Domyślny katalog produktów magazynowych',
      isDefault: true,
      isActive: true,
    },
    update: {
      isDefault: true,
      isActive: true,
    },
  });
}

export async function resolveCatalogForProduct(
  tenantId: string,
  catalogId?: string | null,
  db: DbClient = prisma,
) {
  if (!catalogId) return ensureDefaultCatalog(tenantId, db);

  const catalog = await db.warehouseCatalog.findFirst({
    where: { id: catalogId, tenantId },
  });

  if (!catalog) throw new Error('Katalog nie znaleziony');
  if (!catalog.isActive) throw new Error('Katalog jest nieaktywny');

  return catalog;
}
