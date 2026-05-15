import type { JwtPayload } from './index';

declare module '@fastify/request-context' {
  interface RequestContextData {
    tenantContext: (Pick<JwtPayload, 'tenantId' | 'userId' | 'role'> & {
      overrideTenantId?: string;
    }) | null;
  }
}
