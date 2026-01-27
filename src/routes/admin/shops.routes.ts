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
import {
  triggerManualSync,
  enableShopSync,
  disableShopSync,
  updateShopSyncInterval,
} from '../../services/scheduler/scheduler.service';

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
        const result = await triggerManualSync(paramsParsed.data.id);
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

  // POST /admin/shops/:id/sync/enable - Enable auto-sync
  fastify.post<{ Params: ShopIdParamsInput }>(
    '/:id/sync/enable',
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        await enableShopSync(paramsParsed.data.id);
        return reply.send({
          success: true,
          message: 'Auto-sync włączona dla sklepu',
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Nie udało się włączyć auto-sync',
        });
      }
    }
  );

  // POST /admin/shops/:id/sync/disable - Disable auto-sync
  fastify.post<{ Params: ShopIdParamsInput }>(
    '/:id/sync/disable',
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        await disableShopSync(paramsParsed.data.id);
        return reply.send({
          success: true,
          message: 'Auto-sync wyłączona dla sklepu',
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Nie udało się wyłączyć auto-sync',
        });
      }
    }
  );

  // PUT /admin/shops/:id/sync/interval - Update sync interval
  fastify.put<{ Params: ShopIdParamsInput; Body: { intervalMinutes: number } }>(
    '/:id/sync/interval',
    async (
      request: FastifyRequest<{ Params: ShopIdParamsInput; Body: { intervalMinutes: number } }>,
      reply: FastifyReply
    ) => {
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      const { intervalMinutes } = request.body;
      if (typeof intervalMinutes !== 'number' || intervalMinutes < 5 || intervalMinutes > 1440) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: 'Interval musi być liczbą między 5 a 1440 minut',
        });
      }

      try {
        await updateShopSyncInterval(paramsParsed.data.id, intervalMinutes);
        return reply.send({
          success: true,
          message: `Interwał synchronizacji zmieniony na ${intervalMinutes} minut`,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Nie udało się zmienić interwału',
        });
      }
    }
  );
}
