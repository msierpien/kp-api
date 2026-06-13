import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  createShopSchema,
  ifirmaSettingsSchema,
  shopOrderStatusMappingSchema,
  updateShopSchema,
  shopIdParamsSchema,
  type CreateShopInput,
  type UpdateShopInput,
  type ShopIdParamsInput,
} from '../../schemas/admin.schema';
import { ValidationError } from '../../lib/errors';
import { shopsUseCases } from '../../modules/shops/shops.use-cases';
import * as shopWebhookService from '../../services/webhooks/prestashop-order-webhook.service';
import * as shopOrderStatusesService from '../../services/admin/shop-order-statuses.service';
import * as ifirmaSettingsService from '../../services/admin/ifirma-settings.service';

const shopResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    tenantId: { type: 'string' },
    name: { type: 'string' },
    platform: { type: 'string' },
    baseUrl: { type: 'string' },
    status: { type: 'string' },
    lastSyncAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    apiKey: { type: 'string' },
    apiSecret: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    authType: { type: 'string' },
    config: { type: 'object', additionalProperties: true },
    health: { type: 'string' },
    healthMessage: { type: 'string' },
    latestSyncStatus: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    latestSyncError: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    ordersCount: { type: 'number' },
    casesCount: { type: 'number' },
    mappingsCount: { type: 'number' },
  },
  additionalProperties: true,
};

const shopBodyProperties = {
  name: { type: 'string' },
  tenantId: { type: 'string' },
  platform: {
    type: 'string',
    enum: ['PRESTASHOP', 'WOOCOMMERCE', 'SHOPIFY', 'MAGENTO', 'MANUAL', 'CUSTOM_API', 'OTHER'],
  },
  baseUrl: { type: 'string' },
  apiKey: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  apiSecret: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  status: { type: 'string', enum: ['ACTIVE', 'INACTIVE'] },
  config: { type: 'object', additionalProperties: true },
};

const testConnectionResponseSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    status: { type: 'number' },
    latencyMs: { type: 'number' },
    message: { type: 'string' },
  },
};

const bulkStockDiagnosticsResponseSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    expectedGet405: { type: 'boolean' },
    status: { type: 'number' },
    latencyMs: { type: 'number' },
    contentType: { type: 'string' },
    url: { type: 'string' },
    message: { type: 'string' },
    bodyPreview: { type: 'string' },
  },
};

const webhookSettingsResponseSchema = {
  type: 'object',
  properties: {
    enabled: { type: 'boolean' },
    webhookUrl: { type: 'string' },
    secret: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    timestampToleranceSeconds: { type: 'number' },
    paidStatusIds: { type: 'array', items: { type: 'string' } },
    releaseStatusIds: { type: 'array', items: { type: 'string' } },
    signaturePayload: { type: 'string' },
    eventTypes: { type: 'array', items: { type: 'string' } },
  },
};

const webhookEventSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    shopId: { type: 'string' },
    eventKey: { type: 'string' },
    eventType: { type: 'string' },
    externalOrderId: { type: 'string' },
    prestashopShopId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    orderStatusId: { type: 'string' },
    orderStatusName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    status: { type: 'string' },
    errorMessage: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    receivedAt: { type: 'string' },
    processedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    failedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  additionalProperties: true,
};

function parseShopParams(params: unknown) {
  const parsed = shopIdParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0].message, parsed.error.flatten());
  }
  return parsed.data;
}

function parseCreateShopBody(body: unknown) {
  const parsed = createShopSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0].message, parsed.error.flatten());
  }
  return parsed.data;
}

function parseUpdateShopBody(body: unknown) {
  const parsed = updateShopSchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.errors[0].message, parsed.error.flatten());
  }
  return parsed.data;
}

export async function shopsRoutes(fastify: FastifyInstance) {
  // GET /admin/shops
  fastify.get('/', {
    schema: {
      tags: ['shops'],
      summary: 'Lista integracji z platformami e-commerce',
      response: {
        200: { type: 'array', items: shopResponseSchema },
      },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const shops = await shopsUseCases.list();
    return reply.send(shops);
  });

  fastify.get('/:id/prestashop-categories', {
    schema: {
      tags: ['shops'],
      summary: 'Lista aktywnych kategorii PrestaShop dla integracji',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response: {
        200: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              active: { type: 'boolean' },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const categories = await shopsUseCases.getPrestaShopCategories(request.params.id);
    return reply.send(categories);
  });

  fastify.get<{ Params: ShopIdParamsInput }>(
    '/:id/order-statuses',
    {
      schema: {
        tags: ['shops'],
        summary: 'Lista statusów zamówień PrestaShop dla integracji',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      },
    },
    async (request, reply) => {
      const params = parseShopParams(request.params);
      const result = await shopOrderStatusesService.listShopOrderStatuses(params.id);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: ShopIdParamsInput }>(
    '/:id/order-statuses/sync',
    {
      schema: {
        tags: ['shops'],
        summary: 'Pobierz statusy zamówień z PrestaShop i zapisz katalog lokalny',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      },
    },
    async (request, reply) => {
      const params = parseShopParams(request.params);
      const result = await shopOrderStatusesService.syncShopOrderStatuses(params.id);
      return reply.send(result);
    },
  );

  fastify.put<{ Params: ShopIdParamsInput; Body: unknown }>(
    '/:id/order-statuses/mapping',
    {
      schema: {
        tags: ['shops'],
        summary: 'Zapisz mapowanie statusów workflow dla sklepu',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } },
      },
    },
    async (request, reply) => {
      const params = parseShopParams(request.params);
      const parsed = shopOrderStatusMappingSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.errors[0].message, parsed.error.flatten());
      }
      const result = await shopOrderStatusesService.updateShopOrderStatusMappings(params.id, parsed.data);
      return reply.send(result);
    },
  );

  fastify.get<{ Params: ShopIdParamsInput }>(
    '/:id/ifirma-settings',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Pobierz konfigurację iFirma dla sklepu',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request, reply) => {
      const params = parseShopParams(request.params);
      const result = await ifirmaSettingsService.getIfirmaSettings(params.id);
      return reply.send(result);
    },
  );

  fastify.put<{ Params: ShopIdParamsInput; Body: unknown }>(
    '/:id/ifirma-settings',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Zapisz konfigurację iFirma dla sklepu',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request, reply) => {
      const params = parseShopParams(request.params);
      const parsed = ifirmaSettingsSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.errors[0].message, parsed.error.flatten());
      }
      const result = await ifirmaSettingsService.upsertIfirmaSettings(params.id, parsed.data);
      return reply.send(result);
    },
  );

  // POST /admin/shops
  fastify.post<{ Body: CreateShopInput }>(
    '/',
    {
      schema: {
        tags: ['shops'],
        summary: 'Dodaj nową integrację z platformą e-commerce',
        body: {
          type: 'object',
          required: ['name', 'platform', 'baseUrl'],
          properties: shopBodyProperties,
        },
        response: {
          201: shopResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateShopInput }>, reply: FastifyReply) => {
      const shop = await shopsUseCases.create(parseCreateShopBody(request.body));
      return reply.status(201).send(shop);
    }
  );

  // PUT /admin/shops/:id
  fastify.put<{ Params: ShopIdParamsInput; Body: UpdateShopInput }>(
    '/:id',
    {
      schema: {
        tags: ['shops'],
        summary: 'Zaktualizuj integrację',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: shopBodyProperties,
        },
        response: {
          200: shopResponseSchema,
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: ShopIdParamsInput; Body: UpdateShopInput }>,
      reply: FastifyReply
    ) => {
      const params = parseShopParams(request.params);
      const body = parseUpdateShopBody(request.body);
      const shop = await shopsUseCases.update(params.id, body);
      return reply.send(shop);
    }
  );

  // PATCH /admin/shops/:id/order-sync-config
  fastify.patch<{ Params: ShopIdParamsInput; Body: { fromDate?: string | null } }>(
    '/:id/order-sync-config',
    {
      schema: {
        tags: ['shops'],
        summary: 'Zapisz konfigurację synchronizacji zamówień',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            fromDate: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
              description: 'Najwcześniejsza data importu zamówień (YYYY-MM-DD). Null usuwa ograniczenie.',
            },
          },
        },
        response: { 200: shopResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await shopsUseCases.updateOrderSyncConfig(request.params.id, request.body ?? {});
      return reply.send(result);
    },
  );

  // PATCH /admin/shops/:id/bulk-stock-config
  fastify.patch<{
    Params: ShopIdParamsInput;
    Body: {
      bulkStockUrl?: string | null;
      bulkStockApiKey?: string | null;
      defaultLeadTimeDays?: number | null;
      bulkStockBatchSize?: number | null;
    };
  }>(
    '/:id/bulk-stock-config',
    {
      schema: {
        tags: ['shops'],
        summary: 'Zapisz konfigurację modułu kp_bulkstock dla sklepu',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            bulkStockUrl: { type: 'string', nullable: true },
            bulkStockApiKey: { type: 'string', nullable: true },
            defaultLeadTimeDays: { type: ['integer', 'null'], minimum: 0, maximum: 365 },
            bulkStockBatchSize: { type: ['integer', 'null'], minimum: 1, maximum: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await shopsUseCases.updateBulkStockConfig(request.params.id, request.body ?? {}, fastify.log);
      return reply.send(result);
    },
  );

  // GET /admin/shops/:id/bulk-stock-diagnostics
  fastify.get<{ Params: ShopIdParamsInput }>(
    '/:id/bulk-stock-diagnostics',
    {
      schema: {
        tags: ['shops'],
        summary: 'Niemutujący test osiągalności endpointu kp_bulkstock',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: bulkStockDiagnosticsResponseSchema },
      },
    },
    async (request, reply) => {
      const result = await shopsUseCases.getBulkStockDiagnostics(request.params.id);
      return reply.send(result);
    },
  );

  fastify.get<{ Params: ShopIdParamsInput }>(
    '/:id/delete-preview',
    {
      schema: {
        tags: ['shops'],
        summary: 'Podgląd skutków usunięcia integracji',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request, reply) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.deletePreview(params.id);
      return reply.send(result);
    },
  );

  // DELETE /admin/shops/:id
  fastify.delete<{ Params: ShopIdParamsInput }>(
    '/:id',
    {
      schema: {
        tags: ['shops'],
        summary: 'Usuń integrację',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.remove(params.id);
      return reply.send(result);
    }
  );

  fastify.get<{ Params: ShopIdParamsInput }>(
    '/:id/import-readiness',
    {
      schema: {
        tags: ['shops'],
        summary: 'Sprawdź gotowość integracji sklepu do importu produktów',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.getImportReadiness(params.id);
      return reply.send(result);
    }
  );

  fastify.get<{ Params: ShopIdParamsInput }>(
    '/:id/webhook',
    {
      schema: {
        tags: ['shops'],
        summary: 'Pobierz konfigurację webhooka PrestaShop dla sklepu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: webhookSettingsResponseSchema },
      },
    },
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.getWebhookSettings(params.id);
      return reply.send(result);
    }
  );

  fastify.put<{ Params: ShopIdParamsInput; Body: { enabled?: boolean } }>(
    '/:id/webhook',
    {
      schema: {
        tags: ['shops'],
        summary: 'Zaktualizuj ustawienia webhooka PrestaShop',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
          },
        },
        response: { 200: webhookSettingsResponseSchema },
      },
    },
    async (
      request: FastifyRequest<{ Params: ShopIdParamsInput; Body: { enabled?: boolean } }>,
      reply: FastifyReply
    ) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.updateWebhookSettings(params.id, request.body || {});
      return reply.send(result);
    }
  );

  fastify.post<{ Params: ShopIdParamsInput }>(
    '/:id/webhook-secret/rotate',
    {
      schema: {
        tags: ['shops'],
        summary: 'Wygeneruj nowy sekret webhooka PrestaShop',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: webhookSettingsResponseSchema },
      },
    },
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.rotateWebhookSecret(params.id);
      return reply.send(result);
    }
  );

  fastify.get<{ Params: ShopIdParamsInput; Querystring: shopWebhookService.ShopWebhookEventsQuery }>(
    '/:id/webhook-events',
    {
      schema: {
        tags: ['shops'],
        summary: 'Lista zdarzeń webhooka PrestaShop dla sklepu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            status: { type: 'string', enum: ['PENDING', 'PROCESSED', 'FAILED'] },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'array', items: webhookEventSchema },
              total: { type: 'number' },
              page: { type: 'number' },
              limit: { type: 'number' },
              totalPages: { type: 'number' },
            },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: ShopIdParamsInput; Querystring: shopWebhookService.ShopWebhookEventsQuery }>,
      reply: FastifyReply
    ) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.listWebhookEvents(params.id, request.query);
      return reply.send(result);
    }
  );

  fastify.post<{ Params: ShopIdParamsInput & { eventId: string } }>(
    '/:id/webhook-events/:eventId/reprocess',
    {
      schema: {
        tags: ['shops'],
        summary: 'Ponownie przetwórz zdarzenie webhooka PrestaShop',
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            eventId: { type: 'string' },
          },
        },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (
      request: FastifyRequest<{ Params: ShopIdParamsInput & { eventId: string } }>,
      reply: FastifyReply
    ) => {
      const params = parseShopParams(request.params);
      if (!request.params.eventId) {
        throw new ValidationError('eventId is required');
      }
      const result = await shopsUseCases.reprocessWebhookEvent(params.id, request.params.eventId);
      return reply.send(result);
    }
  );

  // POST /admin/shops/:id/test
  fastify.post<{ Params: ShopIdParamsInput }>(
    '/:id/test',
    {
      schema: {
        tags: ['shops'],
        summary: 'Przetestuj połączenie z API sklepu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: testConnectionResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.testConnection(params.id);
      return reply.send(result);
    }
  );

  // POST /admin/shops/:id/sync - Manual sync trigger
  fastify.post<{
    Params: ShopIdParamsInput;
    Querystring: { wait?: string | boolean };
    Body: { fromDate?: string | null; fromOrderId?: string; limit?: number };
  }>(
    '/:id/sync',
    {
      schema: {
        tags: ['shops'],
        summary: 'Ręcznie uruchom synchronizację zamówień',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        querystring: {
          type: 'object',
          properties: {
            wait: { anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['true', 'false'] }] },
          },
        },
        body: {
          type: 'object',
          properties: {
            fromDate: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Data od której synchronizować (YYYY-MM-DD)' },
            fromOrderId: { type: 'string', description: 'ID zamówienia od którego synchronizować (włącznie)' },
            limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maks. liczba zamówień do pobrania' },
          },
        },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (
      request: FastifyRequest<{
        Params: ShopIdParamsInput;
        Querystring: { wait?: string | boolean };
        Body: { fromDate?: string | null; fromOrderId?: string; limit?: number };
      }>,
      reply: FastifyReply
    ) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.triggerManualSync(params.id, {
        wait: request.query.wait,
        ...request.body,
      }, fastify.log);
      return reply.send(result);
    }
  );

  // POST /admin/shops/:id/sync/enable - Enable auto-sync
  fastify.post<{ Params: ShopIdParamsInput }>(
    '/:id/sync/enable',
    {
      schema: {
        tags: ['shops'],
        summary: 'Włącz auto-synchronizację dla sklepu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object' } },
      },
    },
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.enableSync(params.id);
      return reply.send(result);
    }
  );

  // POST /admin/shops/:id/sync/disable - Disable auto-sync
  fastify.post<{ Params: ShopIdParamsInput }>(
    '/:id/sync/disable',
    {
      schema: {
        tags: ['shops'],
        summary: 'Wyłącz auto-synchronizację dla sklepu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object' } },
      },
    },
    async (request: FastifyRequest<{ Params: ShopIdParamsInput }>, reply: FastifyReply) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.disableSync(params.id);
      return reply.send(result);
    }
  );

  // PUT /admin/shops/:id/sync/interval - Update sync interval
  fastify.put<{ Params: ShopIdParamsInput; Body: { intervalMinutes: number } }>(
    '/:id/sync/interval',
    {
      schema: {
        tags: ['shops'],
        summary: 'Ustaw interwał synchronizacji (5–1440 minut)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['intervalMinutes'],
          properties: {
            intervalMinutes: { type: 'integer', minimum: 5, maximum: 1440 },
          },
        },
        response: { 200: { type: 'object' } },
      },
    },
    async (
      request: FastifyRequest<{ Params: ShopIdParamsInput; Body: { intervalMinutes: number } }>,
      reply: FastifyReply
    ) => {
      const params = parseShopParams(request.params);
      const result = await shopsUseCases.updateSyncInterval(params.id, request.body.intervalMinutes);
      return reply.send(result);
    }
  );
}
