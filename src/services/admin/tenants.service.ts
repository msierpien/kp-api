import prisma from '../../lib/prisma';
import { isSuperAdmin } from '../../lib/tenant-context';
import type { Tenant, TenantStatus } from '@prisma/client';
import { ensureDefaultCatalog } from './warehouse-catalogs.service';

export interface TenantItem {
  id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: string;
  limits: {
    max_shops?: number;
    max_users?: number;
    max_cases_per_month?: number;
  };
  _count?: {
    users: number;
    shops: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTenantInput {
  name: string;
  slug: string;
  plan?: string;
  limits?: {
    max_shops?: number;
    max_users?: number;
    max_cases_per_month?: number;
  };
}

export interface UpdateTenantInput {
  name?: string;
  slug?: string;
  status?: TenantStatus;
  plan?: string;
  limits?: {
    max_shops?: number;
    max_users?: number;
    max_cases_per_month?: number;
  };
}

function mapTenant(tenant: Tenant & { _count?: any }): TenantItem {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status,
    plan: tenant.plan || 'FREE',
    limits: (tenant.limitsJson as any) || {},
    _count: tenant._count,
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  };
}

/**
 * Get all tenants (SUPER_ADMIN only)
 */
export async function getAllTenants(): Promise<TenantItem[]> {
  if (!isSuperAdmin()) {
    throw new Error('Tylko SUPER_ADMIN może przeglądać listę tenantów');
  }

  const tenants = await prisma.tenant.findMany({
    include: {
      _count: {
        select: {
          users: true,
          shops: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return tenants.map(mapTenant);
}

/**
 * Get single tenant by ID (SUPER_ADMIN only)
 */
export async function getTenantById(id: string): Promise<TenantItem> {
  if (!isSuperAdmin()) {
    throw new Error('Tylko SUPER_ADMIN może przeglądać szczegóły tenant');
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          users: true,
          shops: true,
        },
      },
    },
  });

  if (!tenant) {
    throw new Error('Tenant nie został znaleziony');
  }

  return mapTenant(tenant);
}

/**
 * Create new tenant (SUPER_ADMIN only)
 */
export async function createTenant(input: CreateTenantInput): Promise<TenantItem> {
  if (!isSuperAdmin()) {
    throw new Error('Tylko SUPER_ADMIN może tworzyć tenant');
  }

  // Check if slug already exists
  const existing = await prisma.tenant.findUnique({
    where: { slug: input.slug },
  });

  if (existing) {
    throw new Error(`Tenant o slug "${input.slug}" już istnieje`);
  }

  const tenant = await prisma.$transaction(async (tx) => {
    const createdTenant = await tx.tenant.create({
      data: {
        name: input.name,
        slug: input.slug,
        status: 'ACTIVE',
        plan: input.plan || 'FREE',
        limitsJson: input.limits || {},
      },
      include: {
        _count: {
          select: {
            users: true,
            shops: true,
          },
        },
      },
    });

    await ensureDefaultCatalog(createdTenant.id, tx);

    return createdTenant;
  });

  return mapTenant(tenant);
}

/**
 * Update tenant (SUPER_ADMIN only)
 */
export async function updateTenant(id: string, input: UpdateTenantInput): Promise<TenantItem> {
  if (!isSuperAdmin()) {
    throw new Error('Tylko SUPER_ADMIN może edytować tenant');
  }

  // If changing slug, check uniqueness
  if (input.slug) {
    const existing = await prisma.tenant.findFirst({
      where: {
        slug: input.slug,
        NOT: { id },
      },
    });

    if (existing) {
      throw new Error(`Tenant o slug "${input.slug}" już istnieje`);
    }
  }

  const updateData: any = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.slug !== undefined) updateData.slug = input.slug;
  if (input.status !== undefined) updateData.status = input.status;
  if (input.plan !== undefined) updateData.plan = input.plan;
  if (input.limits !== undefined) updateData.limitsJson = input.limits;

  const tenant = await prisma.tenant.update({
    where: { id },
    data: updateData,
    include: {
      _count: {
        select: {
          users: true,
          shops: true,
        },
      },
    },
  });

  return mapTenant(tenant);
}

/**
 * Soft delete tenant (set status to DELETED)
 */
export async function deleteTenant(id: string): Promise<void> {
  if (!isSuperAdmin()) {
    throw new Error('Tylko SUPER_ADMIN może usuwać tenant');
  }

  await prisma.tenant.update({
    where: { id },
    data: { status: 'DELETED' },
  });
}
