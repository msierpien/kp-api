import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createShopSchema,
  updateShopSchema,
  shopIdParamsSchema,
  type CreateShopInput,
  type UpdateShopInput,
  type ShopIdParamsInput,
} from '../../schemas/admin.schema';
import { createShop, listShops, testShopConnection, updateShop } from '../../services/admin/shops.service';
import { syncShopOrders } from '../../services/sync/sync-orders.service';

export async function shopsRoutes(fastify: FastifyInstance) {
  // GET /admin/shops
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const shops = await listShops();
      return reply.send(shops);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Nie udało się pobrać listy integracji',
      });
    }
  });

  // POST /admin/shops
  fastify.post<{ Body: CreateShopInput }>(
    '/',
    async (request: FastifyRequest<{ Body: CreateShopInput }>, reply: FastifyReply) => {
      const parsed = createShopSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      try {
        const shop = await createShop(parsed.data);
        return reply.status(201).send(shop);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się utworzyć integracji',
        });
      }
    }
  );

  // PUT /admin/shops/:id
  fastify.put<{ Params: ShopIdParamsInput; Body: UpdateShopInput }>(
    '/:id',
    async (
      request: FastifyRequest<{ Params: ShopIdParamsInput; Body: UpdateShopInput }>,
      reply: FastifyReply
    ) => {
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      const bodyParsed = updateShopSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: bodyParsed.error.errors[0].message,
        });
      }

      try {
        const shop = await updateShop(paramsParsed.data.id, bodyParsed.data);
        return reply.send(shop);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zaktualizować integracji',
        });
      }
    }
  );

  // POST /admin/shops/:id/test
  fastify.post<{ Params: ShopIdParamsInput }>(
    '/:id/test',
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        const result = await testShopConnection(paramsParsed.data.id);
        return reply.send(result);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Nie udało się przetestować połączenia',
        });
      }
    }
  );

  // POST /admin/shops/:id/sync - Manual sync trigger
  fastify.post<{ Params: ShopIdParamsInput }>(
    '/:id/sync',
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        fastify.log.info({ shopId: paramsParsed.data.id }, 'Manual sync triggered');
        const result = await syncShopOrders(paramsParsed.data.id);
        return reply.send(result);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Nie udało się zsynchronizować zamówień',
        });
      }
    }
  );
}
