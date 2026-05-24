import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Middleware that ensures tenantId is present in request context.
 * Must be used after authMiddleware.
 */
export async function tenantMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user;

  if (!user) {
    return reply.status(401).send({
      error: 'Unauthorized',
      message: 'Brak autoryzacji',
    });
  }

  if (!user.tenantId) {
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Brak informacji o tenancie',
    });
  }

  // Tenant context is available via request.user.tenantId
}
