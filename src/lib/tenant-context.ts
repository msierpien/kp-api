import { requestContext } from '@fastify/request-context';

interface TenantContext {
  tenantId: string;
  userId: string;
  role: string;
  overrideTenantId?: string; // For SUPER_ADMIN to filter by specific tenant
}

export function getTenantId(): string | null {
  const context = requestContext.get('tenantContext') as TenantContext | null;

  // Debug logging
  console.log('[getTenantId] Context:', JSON.stringify(context || { status: 'NO_CONTEXT' }));

  if (!context) {
    console.log('[getTenantId] NO CONTEXT - returning null');
    return null;
  }

  // If SUPER_ADMIN specified override, use it
  if (context.overrideTenantId) {
    console.log('[getTenantId] Using override:', context.overrideTenantId);
    return context.overrideTenantId;
  }

  // SUPER_ADMIN without override sees all data (return null = no filter)
  if (context.role === 'SUPER_ADMIN') {
    console.log('[getTenantId] SUPER_ADMIN without override - returning null');
    return null;
  }

  console.log('[getTenantId] Returning tenantId:', context.tenantId);
  return context.tenantId || null;
}

export function getTenantContext(): TenantContext | null {
  return (requestContext.get('tenantContext') as TenantContext | null) || null;
}

export function setTenantContext(_context: TenantContext) {
  // Context is set in Fastify onRequest hook via requestContext
}

export function isSuperAdmin(): boolean {
  const context = requestContext.get('tenantContext') as TenantContext | null;
  return context?.role === 'SUPER_ADMIN';
}
