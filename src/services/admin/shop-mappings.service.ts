import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';

export interface ShopMappingsQuery {
  page?: number;
  limit?: number;
  shopId?: string;
  warehouseProductId?: string;
  search?: string;
  isMapped?: boolean;
  isActive?: boolean;
}

export interface CreateShopMappingInput {
  shopId: string;
  externalProductId: string;
  externalSku: string;
  externalEan?: string | null;
  externalName?: string;
  externalPrice?: number | null;
  warehouseProductId?: string | null;
  isActive?: boolean;
}

export interface UpdateShopMappingInput {
  externalSku?: string;
  externalEan?: string | null;
  externalName?: string | null;
  externalPrice?: number | null;
  warehouseProductId?: string | null;
  isActive?: boolean;
}

export interface MapShopProductInput {
  warehouseProductId: string;
}

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

export async function getShopMappings(query: ShopMappingsQuery = {}) {
  const tenantId = requireTenantId();
  const { page = 1, limit = 50, shopId, warehouseProductId, search, isMapped, isActive } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.ShopProductMappingWhereInput = { tenantId };

  if (shopId) where.shopId = shopId;
  if (warehouseProductId) where.warehouseProductId = warehouseProductId;
  if (isActive !== undefined) where.isActive = isActive;
  if (isMapped !== undefined && !warehouseProductId) {
    where.warehouseProductId = isMapped ? { not: null } : null;
  }
  if (search) {
    where.OR = [
      { externalSku: { contains: search, mode: 'insensitive' } },
      { externalName: { contains: search, mode: 'insensitive' } },
      { externalProductId: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.shopProductMapping.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ isActive: 'desc' }, { externalSku: 'asc' }],
      include: { shop: true, warehouseProduct: true },
    }),
    prisma.shopProductMapping.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getUnmappedProducts(shopId: string, query: Omit<ShopMappingsQuery, 'shopId' | 'isMapped'> = {}) {
  return getShopMappings({ ...query, shopId, isMapped: false });
}

export async function createShopMapping(input: CreateShopMappingInput) {
  const tenantId = requireTenantId();
  const shop = await assertShopBelongsToTenant(input.shopId, tenantId);

  let warehouseProductId = input.warehouseProductId ?? null;
  if (warehouseProductId) {
    const product = await assertWarehouseProductBelongsToTenant(warehouseProductId, tenantId);
    warehouseProductId = product.id;
  }

  try {
    return await prisma.shopProductMapping.create({
      data: {
        tenantId,
        shopId: shop.id,
        externalProductId: input.externalProductId.trim(),
        externalSku: input.externalSku.trim(),
        externalEan: input.externalEan?.trim() || null,
        externalName: input.externalName?.trim() || null,
        externalPrice: input.externalPrice ?? null,
        warehouseProductId,
        isActive: input.isActive ?? true,
      },
      include: { shop: true, warehouseProduct: true },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new Error('Mapowanie dla tego produktu sklepu już istnieje');
    }
    throw error;
  }
}

export async function updateShopMapping(id: string, input: UpdateShopMappingInput) {
  const tenantId = requireTenantId();
  await assertMappingBelongsToTenant(id, tenantId);

  let warehouseProductId = input.warehouseProductId;
  if (warehouseProductId) {
    const product = await assertWarehouseProductBelongsToTenant(warehouseProductId, tenantId);
    warehouseProductId = product.id;
  }

  return prisma.shopProductMapping.update({
    where: { id },
    data: {
      externalSku: input.externalSku?.trim(),
      externalEan: input.externalEan === undefined ? undefined : input.externalEan?.trim() || null,
      externalName: input.externalName === undefined ? undefined : input.externalName?.trim() || null,
      externalPrice: input.externalPrice,
      warehouseProductId,
      isActive: input.isActive,
    },
    include: { shop: true, warehouseProduct: true },
  });
}

export async function mapShopProductToWarehouse(id: string, input: MapShopProductInput) {
  const tenantId = requireTenantId();
  await assertMappingBelongsToTenant(id, tenantId);
  const product = await assertWarehouseProductBelongsToTenant(input.warehouseProductId, tenantId);

  return prisma.shopProductMapping.update({
    where: { id },
    data: { warehouseProductId: product.id },
    include: { shop: true, warehouseProduct: true },
  });
}

export async function unmapShopProduct(id: string) {
  const tenantId = requireTenantId();
  await assertMappingBelongsToTenant(id, tenantId);

  return prisma.shopProductMapping.update({
    where: { id },
    data: { warehouseProductId: null },
    include: { shop: true, warehouseProduct: true },
  });
}

export async function deleteShopMapping(id: string) {
  const tenantId = requireTenantId();
  await assertMappingBelongsToTenant(id, tenantId);
  await prisma.shopProductMapping.delete({ where: { id } });
}

async function assertMappingBelongsToTenant(id: string, tenantId: string) {
  const mapping = await prisma.shopProductMapping.findFirst({
    where: { id, tenantId },
  });
  if (!mapping) throw new Error('Mapowanie nie znalezione');
  return mapping;
}

async function assertShopBelongsToTenant(id: string, tenantId: string) {
  const shop = await prisma.shop.findFirst({
    where: { id, tenantId },
  });
  if (!shop) throw new Error('Sklep nie znaleziony');
  return shop;
}

async function assertWarehouseProductBelongsToTenant(id: string, tenantId: string) {
  const product = await prisma.warehouseProduct.findFirst({
    where: { id, tenantId },
  });
  if (!product) throw new Error('Produkt magazynowy nie znaleziony');
  return product;
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
