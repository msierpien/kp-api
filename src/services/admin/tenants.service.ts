import prisma from '../../lib/prisma';
import { isSuperAdmin } from '../../lib/tenant-context';
import type { Tenant, TenantStatus } from '@prisma/client';
import { ensureDefaultCatalog } from './warehouse-catalogs.service';
import bcrypt from 'bcrypt';
import { encrypt } from '../../lib/encryption';
import { clearTenantFeaturesCache, normalizeFeatures, type TenantFeatures } from '../../lib/features';

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
  features: TenantFeatures;
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
  features?: TenantFeatures;
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
  features?: TenantFeatures;
}

export interface SetupTenantInput {
  tenant: CreateTenantInput;
  admin: {
    email: string;
    password: string;
    name: string;
  };
  shop?: {
    name?: string;
    platform?: 'PRESTASHOP';
    baseUrl: string;
    apiKey?: string | null;
    authType?: 'WEB_SERVICE';
  };
}

export interface SetupTenantResult {
  tenant: TenantItem;
  admin: {
    id: string;
    email: string;
    name: string;
    role: 'ADMIN';
    tenantId: string;
    isActive: boolean;
    createdAt: Date;
  };
  shop?: {
    id: string;
    name: string;
    platform: string;
    baseUrl: string;
    status: string;
    tenantId: string;
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
    features: normalizeFeatures(tenant.featuresJson),
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
        featuresJson: input.features || {},
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

  clearTenantFeaturesCache(tenant.id);

  return mapTenant(tenant);
}

/**
 * Create tenant with first ADMIN user and optional PrestaShop integration.
 */
export async function setupTenant(input: SetupTenantInput): Promise<SetupTenantResult> {
  if (!isSuperAdmin()) {
    throw new Error('Tylko SUPER_ADMIN może tworzyć firmę z administratorem');
  }

  if (!input.tenant?.name || !input.tenant?.slug) {
    throw new Error('Nazwa i slug firmy są wymagane');
  }

  if (!input.admin?.email || !input.admin?.name || !input.admin?.password) {
    throw new Error('Dane pierwszego administratora są wymagane');
  }

  const [existingTenant, existingUser] = await Promise.all([
    prisma.tenant.findUnique({ where: { slug: input.tenant.slug } }),
    prisma.user.findUnique({ where: { email: input.admin.email } }),
  ]);

  if (existingTenant) {
    throw new Error(`Firma o slug "${input.tenant.slug}" już istnieje`);
  }

  if (existingUser) {
    throw new Error(`Użytkownik o email "${input.admin.email}" już istnieje`);
  }

  const passwordHash = await bcrypt.hash(input.admin.password, 10);

  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: input.tenant.name,
        slug: input.tenant.slug,
        status: 'ACTIVE',
        plan: input.tenant.plan || 'FREE',
        limitsJson: input.tenant.limits || {},
        featuresJson: input.tenant.features || {},
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

    await ensureDefaultCatalog(tenant.id, tx);

    const admin = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: input.admin.email,
        passwordHash,
        name: input.admin.name,
        role: 'ADMIN',
        isActive: true,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        tenantId: true,
        isActive: true,
        createdAt: true,
      },
    });

    const shop = input.shop
      ? await tx.shop.create({
          data: {
            tenantId: tenant.id,
            name: input.shop.name || 'Kreatywne Papierki - PrestaShop',
            platform: 'PRESTASHOP',
            baseUrl: input.shop.baseUrl.replace(/\/+$/, ''),
            apiKey: input.shop.apiKey ? encrypt(input.shop.apiKey) : '',
            status: 'ACTIVE',
            configJson: {
              authType: input.shop.authType || 'WEB_SERVICE',
            },
          },
          select: {
            id: true,
            name: true,
            platform: true,
            baseUrl: true,
            status: true,
            tenantId: true,
          },
        })
      : undefined;

    return { tenant, admin, shop };
  });

  clearTenantFeaturesCache(result.tenant.id);

  return {
    tenant: mapTenant(result.tenant),
    admin: result.admin as SetupTenantResult['admin'],
    shop: result.shop,
  };
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
  if (input.features !== undefined) updateData.featuresJson = input.features;

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

  clearTenantFeaturesCache(id);

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

  clearTenantFeaturesCache(id);
}
