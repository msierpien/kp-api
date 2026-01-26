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
  fastify.get('/', async (_req, reply) => {
    const items = await listPersonalizedProducts();
    return reply.send(items);
  });

  // POST /admin/personalized-products
  fastify.post<{ Body: PersonalizedProductInput }>(
    '/',
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
