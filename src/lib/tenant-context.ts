import { requestContext } from '@fastify/request-context';
import type { UserRole } from '../types';
import { createLogger } from './logger';

interface TenantContext {
  tenantId: string;
  userId: string;
  role: UserRole;
  overrideTenantId?: string; // For SUPER_ADMIN to filter by specific tenant
}

const DEBUG_TENANT_CONTEXT = process.env.DEBUG_TENANT_CONTEXT === 'true';
const logger = createLogger('tenant-context');

export function getTenantId(): string | null {
  const context = requestContext.get('tenantContext') as TenantContext | null;

  if (DEBUG_TENANT_CONTEXT) {
    logger.debug({ context }, 'Tenant context lookup');
  }

  if (!context) {
    if (DEBUG_TENANT_CONTEXT) logger.debug('No tenant context found');
    return null;
  }

  // If SUPER_ADMIN specified override, use it
  if (context.overrideTenantId) {
    if (DEBUG_TENANT_CONTEXT) logger.debug({ tenantId: context.overrideTenantId }, 'Using tenant override');
    return context.overrideTenantId;
  }

  // SUPER_ADMIN without override sees all data (return null = no filter)
  if (context.role === 'SUPER_ADMIN') {
    if (DEBUG_TENANT_CONTEXT) logger.debug('Super admin without tenant override');
    return null;
  }

  if (DEBUG_TENANT_CONTEXT) logger.debug({ tenantId: context.tenantId }, 'Using tenant context');
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
