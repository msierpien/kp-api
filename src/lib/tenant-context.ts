import { AsyncLocalStorage } from 'async_hooks';

interface TenantContext {
  tenantId: string;
  userId: string;
  role: string;
}

export const tenantContext = new AsyncLocalStorage<TenantContext>();

export function getTenantId(): string | null {
  const context = tenantContext.getStore();
  return context?.tenantId || null;
}

export function getTenantContext(): TenantContext | null {
  return tenantContext.getStore() || null;
}

export function setTenantContext(_context: TenantContext) {
  // This should be called within AsyncLocalStorage.run()
  // Typically handled by Fastify hook
}
