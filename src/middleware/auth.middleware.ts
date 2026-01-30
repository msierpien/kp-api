import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import type { JwtPayload } from '../types';

export function authMiddleware(fastify: FastifyInstance) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    try {
      const authHeader = request.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Brak tokenu autoryzacji',
        });
      }

      const token = authHeader.substring(7);
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

export function requireRole(...roles: Array<'ADMIN' | 'SELLER' | 'SUPER_ADMIN'>) {
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
