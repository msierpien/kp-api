import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../services/auth.service';
import { loginSchema, refreshSchema, LoginInput, RefreshInput } from '../schemas/auth.schema';

export async function authRoutes(fastify: FastifyInstance) {
  const authService = new AuthService({
    sign: (payload, options) => fastify.jwt.sign(payload, options),
    verify: (token: string) => fastify.jwt.verify(token) as any,
  });

  // POST /auth/login
  fastify.post<{ Body: LoginInput }>(
    '/login',
    async (request: FastifyRequest<{ Body: LoginInput }>, reply: FastifyReply) => {
      try {
        const parsed = loginSchema.safeParse(request.body);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const { email, password } = parsed.data;
        const result = await authService.login(email, password);

        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd logowania';
        return reply.status(401).send({
          error: 'Authentication Failed',
          message,
        });
      }
    }
  );

  // POST /auth/refresh
  fastify.post<{ Body: RefreshInput }>(
    '/refresh',
    async (request: FastifyRequest<{ Body: RefreshInput }>, reply: FastifyReply) => {
      try {
        const parsed = refreshSchema.safeParse(request.body);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const { refreshToken } = parsed.data;
        const result = await authService.refresh(refreshToken);

        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd odświeżania tokenu';
        return reply.status(401).send({
          error: 'Token Refresh Failed',
          message,
        });
      }
    }
  );

  // POST /auth/logout
  fastify.post('/logout', async (_request: FastifyRequest, reply: FastifyReply) => {
    // W JWT stateless, logout jest po stronie klienta (usunięcie tokenu)
    // Tutaj możemy dodać blacklistowanie tokenu w Redis w przyszłości
    return reply.send({ message: 'Wylogowano pomyślnie' });
  });

  // GET /auth/me - pobierz aktualnego użytkownika (wymaga auth)
  fastify.get(
    '/me',
    {
      preHandler: [async (request, reply) => {
        try {
          const authHeader = request.headers.authorization;
          if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return reply.status(401).send({
              error: 'Unauthorized',
              message: 'Brak tokenu autoryzacji',
            });
          }
          const token = authHeader.substring(7);
          request.user = await fastify.jwt.verify(token);
        } catch {
          return reply.status(401).send({
            error: 'Unauthorized',
            message: 'Nieprawidłowy lub wygasły token',
          });
        }
      }],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      return reply.send({ user: request.user });
    }
  );
}
