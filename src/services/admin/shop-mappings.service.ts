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
  personalizationEnabled?: boolean;
  diagnosis?: 'mapped' | 'ready' | 'missingSku' | 'missingEan' | 'nameOnly' | 'missingData';
}

export interface CreateShopMappingInput {
  shopId: string;
  externalProductId: string;
  externalSku: string;
  externalEan?: string | null;
  externalName?: string;
  externalPrice?: number | null;
  warehouseProductId?: string | null;
  personalizationEnabled?: boolean;
  personalizationTemplateId?: string | null;
  isActive?: boolean;
}

export interface UpdateShopMappingInput {
  externalSku?: string;
  externalEan?: string | null;
  externalName?: string | null;
  externalPrice?: number | null;
  warehouseProductId?: string | null;
  personalizationEnabled?: boolean;
  personalizationTemplateId?: string | null;
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
  const { page = 1, limit = 50, shopId, warehouseProductId, search, isMapped, isActive, personalizationEnabled, diagnosis } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.ShopProductMappingWhereInput = { tenantId };

  if (shopId) where.shopId = shopId;
  if (warehouseProductId) where.warehouseProductId = warehouseProductId;
  if (isActive !== undefined) where.isActive = isActive;
  if (personalizationEnabled !== undefined) where.personalizationEnabled = personalizationEnabled;
  if (isMapped !== undefined && !warehouseProductId) {
    where.warehouseProductId = isMapped ? { not: null } : null;
  }
  applyShopMappingDiagnosis(where, diagnosis);
  if (search) {
    where.OR = [
      { externalSku: { contains: search, mode: 'insensitive' } },
      { externalEan: { contains: search, mode: 'insensitive' } },
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
      include: { shop: true, warehouseProduct: { include: { catalog: true } }, personalizationTemplate: true },
    }),
    prisma.shopProductMapping.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getUnmappedProducts(shopId: string, query: Omit<ShopMappingsQuery, 'shopId' | 'isMapped'> = {}) {
  return getShopMappings({ ...query, shopId, isMapped: false });
}

function applyShopMappingDiagnosis(
  where: Prisma.ShopProductMappingWhereInput,
  diagnosis?: ShopMappingsQuery['diagnosis'],
) {
  if (!diagnosis) return;

  if (diagnosis === 'mapped') {
    where.warehouseProductId = { not: null };
    return;
  }

  where.warehouseProductId = null;

  if (diagnosis === 'ready') {
    where.externalSku = { not: '' };
    where.externalEan = { not: null };
    where.externalName = { not: null };
    return;
  }

  if (diagnosis === 'missingSku') {
    where.externalSku = '';
    return;
  }

  if (diagnosis === 'missingEan') {
    where.externalSku = { not: '' };
    where.externalEan = null;
    return;
  }

  if (diagnosis === 'nameOnly') {
    where.externalSku = '';
    where.externalEan = null;
    where.externalName = { not: null };
    return;
  }

  if (diagnosis === 'missingData') {
    where.externalSku = '';
    where.externalEan = null;
    where.externalName = null;
  }
}

export async function createShopMapping(input: CreateShopMappingInput) {
  const tenantId = requireTenantId();
  const shop = await assertShopBelongsToTenant(input.shopId, tenantId);

  let warehouseProductId = input.warehouseProductId ?? null;
  if (warehouseProductId) {
    const product = await assertWarehouseProductBelongsToTenant(warehouseProductId, tenantId);
    warehouseProductId = product.id;
  }
  const personalizationData = await resolvePersonalizationData(
    tenantId,
    warehouseProductId,
    input.personalizationEnabled,
    input.personalizationTemplateId
  );

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
        ...personalizationData,
        isActive: input.isActive ?? true,
      },
      include: { shop: true, warehouseProduct: { include: { catalog: true } }, personalizationTemplate: true },
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
  const currentMapping = await assertMappingBelongsToTenant(id, tenantId);

  let warehouseProductId = input.warehouseProductId;
  if (warehouseProductId) {
    const product = await assertWarehouseProductBelongsToTenant(warehouseProductId, tenantId);
    warehouseProductId = product.id;
  }
  const effectiveWarehouseProductId = warehouseProductId !== undefined ? warehouseProductId : currentMapping.warehouseProductId;
  const effectivePersonalizationEnabled =
    input.personalizationEnabled ??
    (warehouseProductId === null ? false : currentMapping.personalizationEnabled);
  const effectivePersonalizationTemplateId =
    input.personalizationTemplateId !== undefined
      ? input.personalizationTemplateId
      : warehouseProductId === null
        ? null
        : currentMapping.personalizationTemplateId;
  const personalizationData = await resolvePersonalizationData(
    tenantId,
    effectiveWarehouseProductId,
    effectivePersonalizationEnabled,
    effectivePersonalizationTemplateId
  );

  return prisma.shopProductMapping.update({
    where: { id },
    data: {
      externalSku: input.externalSku?.trim(),
      externalEan: input.externalEan === undefined ? undefined : input.externalEan?.trim() || null,
      externalName: input.externalName === undefined ? undefined : input.externalName?.trim() || null,
      externalPrice: input.externalPrice,
      warehouseProductId,
      ...personalizationData,
      isActive: input.isActive,
    },
    include: { shop: true, warehouseProduct: { include: { catalog: true } }, personalizationTemplate: true },
  });
}

export async function mapShopProductToWarehouse(id: string, input: MapShopProductInput) {
  const tenantId = requireTenantId();
  await assertMappingBelongsToTenant(id, tenantId);
  const product = await assertWarehouseProductBelongsToTenant(input.warehouseProductId, tenantId);

  return prisma.shopProductMapping.update({
    where: { id },
    data: { warehouseProductId: product.id },
    include: { shop: true, warehouseProduct: { include: { catalog: true } }, personalizationTemplate: true },
  });
}

export async function unmapShopProduct(id: string) {
  const tenantId = requireTenantId();
  await assertMappingBelongsToTenant(id, tenantId);

  return prisma.shopProductMapping.update({
    where: { id },
    data: {
      warehouseProductId: null,
      personalizationEnabled: false,
      personalizationTemplateId: null,
    },
    include: { shop: true, warehouseProduct: { include: { catalog: true } }, personalizationTemplate: true },
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

async function assertTemplateBelongsToTenant(id: string, tenantId: string) {
  const template = await prisma.personalizationTemplate.findFirst({
    where: { id, tenantId, isActive: true },
  });
  if (!template) throw new Error('Szablon personalizacji nie znaleziony');
  return template;
}

async function resolvePersonalizationData(
  tenantId: string,
  warehouseProductId: string | null | undefined,
  personalizationEnabled?: boolean,
  personalizationTemplateId?: string | null
) {
  if (personalizationTemplateId) {
    await assertTemplateBelongsToTenant(personalizationTemplateId, tenantId);
  }

  if (personalizationEnabled === true) {
    if (!warehouseProductId) {
      throw new Error('Najpierw powiąż produkt sklepu z produktem magazynowym');
    }
    if (!personalizationTemplateId) {
      throw new Error('Wybierz szablon personalizacji');
    }
    return {
      personalizationEnabled: true,
      personalizationTemplateId,
    };
  }

  if (personalizationEnabled === false) {
    return {
      personalizationEnabled: false,
      personalizationTemplateId: null,
    };
  }

  return {};
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
