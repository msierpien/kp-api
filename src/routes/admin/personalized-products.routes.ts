import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  personalizedProductSchema,
  personalizedProductParamsSchema,
  type PersonalizedProductInput,
  type PersonalizedProductParams,
} from '../../schemas/admin.schema';
import {
  listPersonalizedProducts,
  createPersonalizedProduct,
  updatePersonalizedProduct,
  deletePersonalizedProduct,
} from '../../services/admin/personalized-products.service';

export async function personalizedProductsRoutes(fastify: FastifyInstance) {
  // GET /admin/personalized-products
  fastify.get('/', {
    schema: {
      tags: ['personalized-products'],
      summary: 'Lista mapowań SKU → szablon',
      response: { 200: { type: 'array', items: { type: 'object' } } },
    },
  }, async (_req, reply) => {
    const items = await listPersonalizedProducts();
    return reply.send(items);
  });

  // POST /admin/personalized-products
  fastify.post<{ Body: PersonalizedProductInput }>(
    '/',
    {
      schema: {
        tags: ['personalized-products'],
        summary: 'Dodaj mapowanie produktu e-commerce na szablon',
        body: {
          type: 'object',
          required: ['shopId', 'identifierType', 'identifierValue', 'templateId'],
          properties: {
            shopId: { type: 'string' },
            name: { type: 'string' },
            identifierType: { type: 'string', enum: ['SKU', 'INDEX', 'EAN'] },
            identifierValue: { type: 'string' },
            templateId: { type: 'string' },
          },
        },
        response: {
          201: { type: 'object' },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Body: PersonalizedProductInput }>, reply: FastifyReply) => {
      const parsed = personalizedProductSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }
      const item = await createPersonalizedProduct(parsed.data);
      return reply.status(201).send(item);
    }
  );

  // PUT /admin/personalized-products/:id
  fastify.put<{ Params: PersonalizedProductParams; Body: PersonalizedProductInput }>(
    '/:id',
    {
      schema: {
        tags: ['personalized-products'],
        summary: 'Zaktualizuj mapowanie',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: { type: 'object' },
        response: { 200: { type: 'object' } },
      },
    },
    async (
      request: FastifyRequest<{ Params: PersonalizedProductParams; Body: PersonalizedProductInput }>,
      reply: FastifyReply
    ) => {
      const params = personalizedProductParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'Validation Error', message: params.error.errors[0].message });
      }
      const body = personalizedProductSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'Validation Error', message: body.error.errors[0].message });
      }
      const item = await updatePersonalizedProduct(params.data.id, body.data);
      return reply.send(item);
    }
  );

  // DELETE /admin/personalized-products/:id
  fastify.delete<{ Params: PersonalizedProductParams }>(
    '/:id',
    {
      schema: {
        tags: ['personalized-products'],
        summary: 'Usuń mapowanie',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } } },
      },
    },
    async (request: FastifyRequest<{ Params: PersonalizedProductParams }>, reply: FastifyReply) => {
      const params = personalizedProductParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'Validation Error', message: params.error.errors[0].message });
      }
      await deletePersonalizedProduct(params.data.id);
      return reply.send({ success: true });
    }
  );
}
