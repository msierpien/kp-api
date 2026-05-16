import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../services/auth.service';
import { loginSchema, refreshSchema, LoginInput, RefreshInput } from '../schemas/auth.schema';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/auth.middleware';

export async function authRoutes(fastify: FastifyInstance) {
  const authService = new AuthService({
    sign: (payload, options) => fastify.jwt.sign(payload, options),
    verify: (token: string) => fastify.jwt.verify(token) as any,
  });

  // POST /auth/login
  fastify.post<{ Body: LoginInput }>(
    '/login',
    {
      schema: {
        tags: ['auth'],
        summary: 'Logowanie',
        security: [],
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accessToken: { type: 'string' },
              refreshToken: { type: 'string' },
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  tenantId: { type: 'string' },
                  tenant: { type: 'object' },
                },
              },
            },
          },
          401: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
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
    {
      schema: {
        tags: ['auth'],
        summary: 'Odśwież token dostępu',
        security: [],
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accessToken: { type: 'string' },
            },
          },
          401: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
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
  fastify.post('/logout', {
    schema: {
      tags: ['auth'],
      summary: 'Wylogowanie',
      response: {
        200: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    // W JWT stateless, logout jest po stronie klienta (usunięcie tokenu)
    // Tutaj możemy dodać blacklistowanie tokenu w Redis w przyszłości
    return reply.send({ message: 'Wylogowano pomyślnie' });
  });

  // GET /auth/me - pobierz aktualnego użytkownika (wymaga auth)
  fastify.get(
    '/me',
    {
      schema: {
        tags: ['auth'],
        summary: 'Pobierz dane zalogowanego użytkownika',
        response: {
          200: {
            type: 'object',
            properties: {
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  tenantId: { type: 'string' },
                  tenant: { type: 'object' },
                },
              },
            },
          },
          401: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
      preHandler: [authMiddleware(fastify)],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const jwtUser = request.user as any;
      const user = await prisma.user.findUnique({
        where: { id: jwtUser.userId },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          tenantId: true,
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      });

      if (!user || !user.tenant) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Użytkownik nie został znaleziony',
        });
      }

      return reply.send({ user });
    }
  );
}
