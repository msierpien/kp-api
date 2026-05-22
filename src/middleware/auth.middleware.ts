import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import type { JwtPayload, UserRole } from '../types';
import { FEATURE_PERSONALIZATION_EDITOR, tenantHasFeature } from '../lib/features';
import { getAccessTokenFromRequest } from '../lib/auth-cookies';

export function authMiddleware(fastify: FastifyInstance) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    try {
      const token = getAccessTokenFromRequest(request);

      if (!token) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Brak tokenu autoryzacji',
        });
      }

      const decoded = (await fastify.jwt.verify(token)) as JwtPayload;

      (request as any).user = decoded;
    } catch (error) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Nieprawidłowy lub wygasły token',
      });
    }
  };
}

export function requireRole(...roles: UserRole[]) {
  return async function checkRole(request: FastifyRequest, reply: FastifyReply) {
    const user = (request as any).user as JwtPayload | undefined;

    if (!user) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Brak autoryzacji',
      });
    }

    if (!roles.includes(user.role)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Brak uprawnień do tego zasobu',
      });
    }
  };
}

function adminPath(url: string) {
  const [path] = url.split('?');
  return path.replace(/^\/admin(?=\/|$)/, '') || '/';
}

function isSystemAdminPath(path: string) {
  return path.startsWith('/tenants') || path.startsWith('/queues') || path.startsWith('/storage');
}

function isPersonalizationAdminPath(path: string) {
  return path.startsWith('/personalized-products') ||
    path.startsWith('/templates') ||
    path.startsWith('/cases') ||
    path.startsWith('/render-jobs') ||
    path.startsWith('/fonts');
}

function operatorWarehouseAccess(method: string, path: string) {
  if (!path.startsWith('/warehouse')) return false;
  if (path.startsWith('/warehouse/catalogs')) return false;

  if (path.startsWith('/warehouse/products')) {
    return method === 'GET';
  }

  if (path === '/warehouse/recalculate-stock') return false;
  if (path.startsWith('/warehouse/price-sync-logs') || path.startsWith('/warehouse/stock-sync-logs')) {
    return method === 'GET';
  }

  return true;
}

export function canAccessAdminPath(role: UserRole, method: string, url: string) {
  const path = adminPath(url);

  if (role === 'SUPER_ADMIN') return true;

  if (role === 'ADMIN') {
    return !isSystemAdminPath(path);
  }

  if (role !== 'OPERATOR') return false;

  if (path === '/' || path.startsWith('/stats')) return method === 'GET';
  if (path.startsWith('/sync-logs')) return method === 'GET';
  if (path.startsWith('/render-jobs')) return true;
  if (path.startsWith('/cases')) return true;
  if (path.startsWith('/orders')) return method !== 'DELETE';

  return operatorWarehouseAccess(method, path);
}

export function requireAdminPathAccess() {
  return async function checkAdminPathAccess(request: FastifyRequest, reply: FastifyReply) {
    const user = (request as any).user as JwtPayload | undefined;

    if (!user) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Brak autoryzacji',
      });
    }

    if (!canAccessAdminPath(user.role, request.method, request.url)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Brak uprawnień do tego zasobu',
      });
    }
  };
}

export function requireTenantFeatureAccess() {
  return async function checkTenantFeatureAccess(request: FastifyRequest, reply: FastifyReply) {
    const user = (request as any).user as JwtPayload | undefined;
    if (!user) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Brak autoryzacji',
      });
    }

    const path = adminPath(request.url);
    if (!isPersonalizationAdminPath(path)) return;
    if (user.role === 'SUPER_ADMIN') return;

    const enabled = await tenantHasFeature(user.tenantId, FEATURE_PERSONALIZATION_EDITOR);
    if (!enabled) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Moduł personalizacji nie jest aktywny dla tej firmy',
      });
    }
  };
}
