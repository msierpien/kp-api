import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ZodSchema, ZodError } from 'zod';

declare module 'fastify' {
  interface FastifyContextConfig {
    bodySchema?: ZodSchema;
    paramsSchema?: ZodSchema;
    querySchema?: ZodSchema;
  }
}

/**
 * Plugin do automatycznej walidacji używając Zod schemas
 *
 * Użycie:
 * fastify.post('/', {
 *   config: {
 *     bodySchema: createShopSchema,
 *     paramsSchema: shopIdParamsSchema,
 *   }
 * }, async (request, reply) => {
 *   // request.body i request.params są już zwalidowane!
 * });
 */
export async function validationPlugin(fastify: FastifyInstance) {
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const { bodySchema, paramsSchema, querySchema } = request.routeConfig;

    try {
      // Walidacja body
      if (bodySchema && request.body) {
        const parsed = bodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: formatZodError(parsed.error),
            details: parsed.error.errors,
          });
        }
        // Nadpisz body zwalidowanymi danymi
        request.body = parsed.data;
      }

      // Walidacja params
      if (paramsSchema && request.params) {
        const parsed = paramsSchema.safeParse(request.params);
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: formatZodError(parsed.error),
            details: parsed.error.errors,
          });
        }
        request.params = parsed.data;
      }

      // Walidacja query
      if (querySchema && request.query) {
        const parsed = querySchema.safeParse(request.query);
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: formatZodError(parsed.error),
            details: parsed.error.errors,
          });
        }
        request.query = parsed.data;
      }
    } catch (error) {
      fastify.log.error('Validation plugin error:', error);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Błąd walidacji',
      });
    }
  });
}

/**
 * Formatuje błąd Zod do czytelnej wiadomości
 */
function formatZodError(error: ZodError): string {
  const firstError = error.errors[0];
  if (!firstError) return 'Błąd walidacji';

  const path = firstError.path.join('.');
  const message = firstError.message;

  if (path) {
    return `${path}: ${message}`;
  }
  return message;
}
