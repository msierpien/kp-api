import type { JwtPayload } from './index';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: JwtPayload | undefined;
  }
}
