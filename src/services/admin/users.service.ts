import prisma from '../../lib/prisma';
import { isSuperAdmin, getTenantContext } from '../../lib/tenant-context';
import bcrypt from 'bcrypt';

export interface UserListItem {
  id: string;
  email: string;
  name: string;
  role: string;
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
  role: string;
  tenantId: string; // SUPER_ADMIN can set any tenant
  isActive?: boolean;
}

export interface UpdateUserInput {
  email?: string;
  password?: string;
  name?: string;
  role?: string;
  tenantId?: string; // SUPER_ADMIN can change tenant
  isActive?: boolean;
}

/**
 * Get all users (with optional tenant filter for SUPER_ADMIN)
 */
export async function getAllUsers(tenantIdFilter?: string): Promise<UserListItem[]> {
  const context = getTenantContext();
  
  if (!context) {
    throw new Error('Brak kontekstu użytkownika');
  }

  // SUPER_ADMIN can see all users or filter by tenant
  // Regular users see only users from their tenant
  const where: any = {};
  
  if (isSuperAdmin()) {
    if (tenantIdFilter) {
      where.tenantId = tenantIdFilter;
    }
    // else - no filter, see all
  } else {
    where.tenantId = context.tenantId;
  }

  const users = await prisma.user.findMany({
    where,
    select: {
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
    },
    orderBy: { createdAt: 'desc' },
  });

  return users as UserListItem[];
}

/**
 * Get single user by ID
 */
export async function getUserById(id: string): Promise<UserListItem> {
  const context = getTenantContext();
  
  if (!context) {
    throw new Error('Brak kontekstu użytkownika');
  }

  const where: any = { id };
  
  // Regular users can only see users from their tenant
  if (!isSuperAdmin()) {
    where.tenantId = context.tenantId;
  }

  const user = await prisma.user.findFirst({
    where,
    select: {
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
    },
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
  const context = getTenantContext();
  
  if (!context) {
    throw new Error('Brak kontekstu użytkownika');
  }

  // Validate tenantId assignment
  let targetTenantId = input.tenantId;
  
  if (!isSuperAdmin()) {
    // Regular admins can only create users in their own tenant
    targetTenantId = context.tenantId;
  } else {
    // SUPER_ADMIN must specify tenantId
    if (!input.tenantId) {
      throw new Error('SUPER_ADMIN musi określić tenantId dla nowego użytkownika');
    }
  }

  // Check if email already exists
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
  });

  if (existing) {
    throw new Error(`Użytkownik o email "${input.email}" już istnieje`);
  }

  // Hash password
  const passwordHash = await bcrypt.hash(input.password, 10);

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      name: input.name,
      role: input.role,
      tenantId: targetTenantId,
      isActive: input.isActive ?? true,
    } as any, // tenantId added by middleware but we override it
    select: {
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
    },
  });

  return user as UserListItem;
}

/**
 * Update user
 */
export async function updateUser(id: string, input: UpdateUserInput): Promise<UserListItem> {
  const context = getTenantContext();
  
  if (!context) {
    throw new Error('Brak kontekstu użytkownika');
  }

  // Check if user exists and belongs to tenant (for non-SUPER_ADMIN)
  const existingUser = await getUserById(id);

  // Build update data
  const updateData: any = {};
  
  if (input.email !== undefined) {
    // Check email uniqueness
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
  
  if (input.password !== undefined) {
    updateData.passwordHash = await bcrypt.hash(input.password, 10);
  }
  
  if (input.name !== undefined) updateData.name = input.name;
  if (input.role !== undefined) updateData.role = input.role;
  if (input.isActive !== undefined) updateData.isActive = input.isActive;
  
  // Only SUPER_ADMIN can change tenantId
  if (input.tenantId !== undefined) {
    if (!isSuperAdmin()) {
      throw new Error('Tylko SUPER_ADMIN może zmieniać tenantId użytkownika');
    }
    updateData.tenantId = input.tenantId;
  }

  const user = await prisma.user.update({
    where: { id },
    data: updateData,
    select: {
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
    },
  });

  return user as UserListItem;
}

/**
 * Deactivate user (soft delete)
 */
export async function deleteUser(id: string): Promise<void> {
  const context = getTenantContext();
  
  if (!context) {
    throw new Error('Brak kontekstu użytkownika');
  }

  // Check if user exists and belongs to tenant (for non-SUPER_ADMIN)
  await getUserById(id);

  await prisma.user.update({
    where: { id },
    data: { isActive: false },
  });
}
