import { requestContext } from '@fastify/request-context';
import type { UserRole } from '../types';

interface TenantContext {
  tenantId: string;
  userId: string;
  role: UserRole;
  overrideTenantId?: string; // For SUPER_ADMIN to filter by specific tenant
}

const DEBUG_TENANT_CONTEXT = process.env.DEBUG_TENANT_CONTEXT === 'true';

export function getTenantId(): string | null {
  const context = requestContext.get('tenantContext') as TenantContext | null;

  if (DEBUG_TENANT_CONTEXT) {
    console.log('[getTenantId] Context:', JSON.stringify(context || { status: 'NO_CONTEXT' }));
  }

  if (!context) {
    if (DEBUG_TENANT_CONTEXT) console.log('[getTenantId] NO CONTEXT - returning null');
    return null;
  }

  // If SUPER_ADMIN specified override, use it
  if (context.overrideTenantId) {
    if (DEBUG_TENANT_CONTEXT) console.log('[getTenantId] Using override:', context.overrideTenantId);
    return context.overrideTenantId;
  }

  // SUPER_ADMIN without override sees all data (return null = no filter)
  if (context.role === 'SUPER_ADMIN') {
    if (DEBUG_TENANT_CONTEXT) console.log('[getTenantId] SUPER_ADMIN without override - returning null');
    return null;
  }

  if (DEBUG_TENANT_CONTEXT) console.log('[getTenantId] Returning tenantId:', context.tenantId);
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
