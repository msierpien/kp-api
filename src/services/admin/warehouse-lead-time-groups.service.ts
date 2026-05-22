import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { publishInventoryToShops } from '../stock/stock-sync.service';

export interface LeadTimeGroupsQuery {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

export interface CreateLeadTimeGroupInput {
  code: string;
  name: string;
  leadTimeDays: number;
  isActive?: boolean;
}

export interface UpdateLeadTimeGroupInput {
  code?: string;
  name?: string;
  leadTimeDays?: number;
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

function normalizeLeadTimeDays(value: number) {
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new Error('Czas wysyłki musi być liczbą całkowitą od 0 do 365 dni');
  }
  return days;
}

export async function getLeadTimeGroups(query: LeadTimeGroupsQuery = {}) {
  const tenantId = requireTenantId();
  const { page = 1, limit = 50, search, isActive } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.WarehouseLeadTimeGroupWhereInput = { tenantId };
  if (isActive !== undefined) where.isActive = isActive;
  if (search) {
    where.OR = [
      { code: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.warehouseLeadTimeGroup.findMany({
      where,
      skip,
      take: limit,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    }),
    prisma.warehouseLeadTimeGroup.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getLeadTimeGroupById(id: string) {
  const tenantId = requireTenantId();
  return prisma.warehouseLeadTimeGroup.findFirst({
    where: { id, tenantId },
    include: { _count: { select: { products: true } } },
  });
}

export async function createLeadTimeGroup(input: CreateLeadTimeGroupInput) {
  const tenantId = requireTenantId();
  const code = normalizeCode(input.code);
  if (!code) throw new Error('Kod grupy jest wymagany');

  const existing = await prisma.warehouseLeadTimeGroup.findUnique({
    where: { tenantId_code: { tenantId, code } },
  });
  if (existing) throw new Error(`Grupa czasu wysyłki z kodem "${code}" już istnieje`);

  return prisma.warehouseLeadTimeGroup.create({
    data: {
      tenantId,
      code,
      name: input.name.trim(),
      leadTimeDays: normalizeLeadTimeDays(input.leadTimeDays),
      isActive: input.isActive ?? true,
    },
    include: { _count: { select: { products: true } } },
  });
}

export async function updateLeadTimeGroup(id: string, input: UpdateLeadTimeGroupInput) {
  const tenantId = requireTenantId();
  const group = await prisma.warehouseLeadTimeGroup.findFirst({ where: { id, tenantId } });
  if (!group) throw new Error('Grupa czasu wysyłki nie znaleziona');

  const data: Prisma.WarehouseLeadTimeGroupUpdateInput = {};

  if (input.code !== undefined) {
    const code = normalizeCode(input.code);
    if (!code) throw new Error('Kod grupy jest wymagany');
    const existing = await prisma.warehouseLeadTimeGroup.findUnique({
      where: { tenantId_code: { tenantId, code } },
    });
    if (existing && existing.id !== id) throw new Error(`Grupa czasu wysyłki z kodem "${code}" już istnieje`);
    data.code = code;
  }
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.leadTimeDays !== undefined) data.leadTimeDays = normalizeLeadTimeDays(input.leadTimeDays);
  if (input.isActive !== undefined) data.isActive = input.isActive;

  const shouldSync = (input.leadTimeDays !== undefined && input.leadTimeDays !== group.leadTimeDays) ||
    (input.isActive !== undefined && input.isActive !== group.isActive);

  const updated = await prisma.warehouseLeadTimeGroup.update({
    where: { id },
    data,
    include: { _count: { select: { products: true } } },
  });

  if (shouldSync) {
    enqueueLeadTimeGroupStockSync(id, tenantId).catch((error) => {
      console.error('[LeadTimeGroups] Failed to enqueue stock sync for group change:', error);
    });
  }

  return updated;
}

export async function deleteLeadTimeGroup(id: string) {
  const tenantId = requireTenantId();
  const group = await prisma.warehouseLeadTimeGroup.findFirst({
    where: { id, tenantId },
    include: { _count: { select: { products: true } } },
  });
  if (!group) throw new Error('Grupa czasu wysyłki nie znaleziona');
  if (group._count.products > 0) {
    throw new Error('Nie można usunąć grupy czasu wysyłki przypisanej do produktów');
  }

  return prisma.warehouseLeadTimeGroup.delete({ where: { id } });
}

async function enqueueLeadTimeGroupStockSync(groupId: string, tenantId: string) {
  const products = await prisma.warehouseProduct.findMany({
    where: { tenantId, leadTimeGroupId: groupId, isActive: true },
    select: { id: true },
  });
  if (products.length === 0) return;

  for (let i = 0; i < products.length; i += 500) {
    await publishInventoryToShops({
      tenantId,
      warehouseProductIds: products.slice(i, i + 500).map((product) => product.id),
      triggeredBy: 'LEAD_TIME_UPDATE',
    });
  }
}
