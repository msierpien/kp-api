import { AsyncLocalStorage } from 'async_hooks';

interface TenantContext {
  tenantId: string;
  userId: string;
  role: string;
  overrideTenantId?: string; // For SUPER_ADMIN to filter by specific tenant
}

export const tenantContext = new AsyncLocalStorage<TenantContext>();

export function getTenantId(): string | null {
  const context = tenantContext.getStore();
  if (!context) return null;
  
  // If SUPER_ADMIN specified override, use it
  if (context.overrideTenantId) {
    return context.overrideTenantId;
  }
  
  // SUPER_ADMIN without override sees all data (return null = no filter)
  if (context.role === 'SUPER_ADMIN') {
    return null;
  }
  
  return context.tenantId || null;
}

export function getTenantContext(): TenantContext | null {
  return tenantContext.getStore() || null;
}

export function setTenantContext(_context: TenantContext) {
  // This should be called within AsyncLocalStorage.run()
  // Typically handled by Fastify hook
}

export function isSuperAdmin(): boolean {
  const context = tenantContext.getStore();
  return context?.role === 'SUPER_ADMIN';
}
