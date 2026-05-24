import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import type { JwtPayload, UserRole } from '../types';
import { FEATURE_PERSONALIZATION_EDITOR, tenantHasFeature } from '../lib/features';
import { getAccessTokenFromRequest } from '../lib/auth-cookies';
import { adminPath, canAccessAdminPath, isPersonalizationAdminPath } from '../lib/authz/admin-policy';

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
