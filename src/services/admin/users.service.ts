import bcrypt from 'bcrypt';
import prisma from '../../lib/prisma';
import { getTenantContext, isSuperAdmin } from '../../lib/tenant-context';
import type { UserRole } from '../../types';
import { ensureDefaultCatalog } from './warehouse-catalogs.service';

const USER_ROLES: UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'OPERATOR'];

export interface UserListItem {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  tenantId: string;
  tenant: {
    id: string;
    name: string;
    slug: string;
  };
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface CreateUserInput {
  email: string;
  password: string;
  name: string;
  role: UserRole;
  tenantId?: string;
  isActive?: boolean;
}

export interface UpdateUserInput {
  email?: string;
  password?: string;
  name?: string;
  role?: UserRole;
  tenantId?: string;
  isActive?: boolean;
}

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  isActive: true,
  tenantId: true,
  tenant: {
    select: {
      id: true,
      name: true,
      slug: true,
    },
  },
  lastLoginAt: true,
  createdAt: true,
} as const;

function assertUserRole(role: string | undefined): UserRole {
  if (!role || !USER_ROLES.includes(role as UserRole)) {
    throw new Error('Nieprawidłowa rola użytkownika');
  }

  return role as UserRole;
}

function assertContext() {
  const context = getTenantContext();
  if (!context) {
    throw new Error('Brak kontekstu użytkownika');
  }

  return context;
}

async function assertTenantExists(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, status: true },
  });

  if (!tenant || tenant.status !== 'ACTIVE') {
    throw new Error('Firma nie została znaleziona lub jest nieaktywna');
  }
}

async function assertCanDeactivateUser(targetUser: UserListItem) {
  const context = assertContext();

  if (targetUser.id === context.userId) {
    throw new Error('Nie możesz dezaktywować własnego konta');
  }

  if (targetUser.role !== 'ADMIN') return;

  const remainingActiveAdmins = await prisma.user.count({
    where: {
      tenantId: targetUser.tenantId,
      role: 'ADMIN',
      isActive: true,
      NOT: { id: targetUser.id },
    },
  });

  if (remainingActiveAdmins === 0) {
    throw new Error('Nie można dezaktywować ostatniego aktywnego administratora firmy');
  }
}

/**
 * Get all users (with optional tenant filter for SUPER_ADMIN)
 */
export async function getAllUsers(tenantIdFilter?: string): Promise<UserListItem[]> {
  const context = assertContext();
  const where: any = {};

  if (isSuperAdmin()) {
    if (tenantIdFilter) {
      where.tenantId = tenantIdFilter;
    }
  } else {
    where.tenantId = context.tenantId;
  }

  const users = await prisma.user.findMany({
    where,
    select: userSelect,
    orderBy: { createdAt: 'desc' },
  });

  return users as UserListItem[];
}

/**
 * Get single user by ID
 */
export async function getUserById(id: string): Promise<UserListItem> {
  const context = assertContext();
  const where: any = { id };

  if (!isSuperAdmin()) {
    where.tenantId = context.tenantId;
  }

  const user = await prisma.user.findFirst({
    where,
    select: userSelect,
  });

  if (!user) {
    throw new Error('Użytkownik nie został znaleziony');
  }

  return user as UserListItem;
}

/**
 * Create new user
 */
export async function createUser(input: CreateUserInput): Promise<UserListItem> {
  const context = assertContext();
  const role = assertUserRole(input.role);

  if (!isSuperAdmin() && role === 'SUPER_ADMIN') {
    throw new Error('Tylko SUPER_ADMIN może tworzyć konta SUPER_ADMIN');
  }

  let targetTenantId = input.tenantId;

  if (!isSuperAdmin()) {
    targetTenantId = context.tenantId;
  } else if (!targetTenantId) {
    throw new Error('SUPER_ADMIN musi określić firmę dla nowego użytkownika');
  }

  if (!targetTenantId) {
    throw new Error('Brak firmy dla nowego użytkownika');
  }

  await assertTenantExists(targetTenantId);

  const existing = await prisma.user.findFirst({
    where: { email: input.email },
  });

  if (existing) {
    throw new Error(`Użytkownik o email "${input.email}" już istnieje`);
  }

  const passwordHash = await bcrypt.hash(input.password, 10);

  const user = await prisma.$transaction(async (tx) => {
    await ensureDefaultCatalog(targetTenantId, tx);

    return tx.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        role,
        tenantId: targetTenantId,
        isActive: input.isActive ?? true,
      },
      select: userSelect,
    });
  });

  return user as UserListItem;
}

/**
 * Update user
 */
export async function updateUser(id: string, input: UpdateUserInput): Promise<UserListItem> {
  const existingUser = await getUserById(id);
  const updateData: any = {};

  if (input.email !== undefined) {
    const emailExists = await prisma.user.findFirst({
      where: {
        email: input.email,
        NOT: { id },
      },
    });

    if (emailExists) {
      throw new Error(`Użytkownik o email "${input.email}" już istnieje`);
    }

    updateData.email = input.email;
  }

  if (input.password !== undefined && input.password !== '') {
    updateData.passwordHash = await bcrypt.hash(input.password, 10);
  }

  if (input.name !== undefined) updateData.name = input.name;

  if (input.role !== undefined) {
    const role = assertUserRole(input.role);
    if (!isSuperAdmin() && role === 'SUPER_ADMIN') {
      throw new Error('Tylko SUPER_ADMIN może nadawać rolę SUPER_ADMIN');
    }
    if (existingUser.role === 'ADMIN' && role !== 'ADMIN') {
      await assertCanDeactivateUser(existingUser);
    }
    updateData.role = role;
  }

  if (input.isActive !== undefined) {
    if (!input.isActive && existingUser.isActive) {
      await assertCanDeactivateUser(existingUser);
    }
    updateData.isActive = input.isActive;
  }

  if (input.tenantId !== undefined) {
    if (!isSuperAdmin()) {
      throw new Error('Tylko SUPER_ADMIN może zmieniać firmę użytkownika');
    }

    await assertTenantExists(input.tenantId);
    if (existingUser.role === 'ADMIN' && input.tenantId !== existingUser.tenantId) {
      await assertCanDeactivateUser(existingUser);
    }
    await ensureDefaultCatalog(input.tenantId);
    updateData.tenantId = input.tenantId;
  }

  const user = await prisma.user.update({
    where: { id },
    data: updateData,
    select: userSelect,
  });

  return user as UserListItem;
}

/**
 * Deactivate user (soft delete)
 */
export async function deleteUser(id: string): Promise<void> {
  const user = await getUserById(id);
  await assertCanDeactivateUser(user);

  await prisma.user.update({
    where: { id },
    data: { isActive: false },
  });
}
