import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../services/auth.service';
import { loginSchema, refreshSchema, LoginInput, RefreshInput } from '../schemas/auth.schema';
import prisma from '../lib/prisma';
import { authMiddleware } from '../middleware/auth.middleware';
import { normalizeFeatures } from '../lib/features';
import { clearAuthCookies, getRefreshTokenFromRequest, setAuthCookies } from '../lib/auth-cookies';

export async function authRoutes(fastify: FastifyInstance) {
  const authService = new AuthService({
    sign: (payload, options) => fastify.jwt.sign(payload, options),
    verify: <T extends object | string>(token: string) => fastify.jwt.verify<T>(token),
  });

  function authRequestMeta(request: FastifyRequest) {
    const userAgent = request.headers['user-agent'];
    return {
      userAgent: Array.isArray(userAgent) ? userAgent.join(' ') : userAgent,
      ipAddress: request.ip,
    };
  }

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
              user: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  email: { type: 'string' },
                  name: { type: 'string' },
                  role: { type: 'string' },
                  tenantId: { type: 'string' },
                  tenant: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      slug: { type: 'string' },
                      features: { type: 'object', additionalProperties: true },
                    },
                  },
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
        const result = await authService.login(email, password, authRequestMeta(request));
        setAuthCookies(reply, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        });

        return reply.send({ user: result.user });
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
          properties: {
            refreshToken: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
            },
          },
          401: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Body: RefreshInput }>, reply: FastifyReply) => {
      try {
        const parsed = refreshSchema.safeParse(request.body ?? {});

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const refreshToken = parsed.data.refreshToken || getRefreshTokenFromRequest(request);
        if (!refreshToken) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: 'Refresh token jest wymagany',
          });
        }

        const result = await authService.refresh(refreshToken);
        setAuthCookies(reply, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        });

        return reply.send({ success: true });
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
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    await authService.logout(getRefreshTokenFromRequest(request));
    clearAuthCookies(reply);
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
                  tenant: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      slug: { type: 'string' },
                      features: { type: 'object', additionalProperties: true },
                    },
                  },
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
      const jwtUser = request.user;
      if (!jwtUser) {
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Brak autoryzacji',
        });
      }

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
              featuresJson: true,
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

      return reply.send({
        user: {
          ...user,
          tenant: {
            id: user.tenant.id,
            name: user.tenant.name,
            slug: user.tenant.slug,
            features: normalizeFeatures(user.tenant.featuresJson),
          },
        },
      });
    }
  );
}
