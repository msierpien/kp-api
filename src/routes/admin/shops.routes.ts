import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../lib/prisma';
import { decrypt, encrypt } from '../../lib/encryption';
import {
  createShopSchema,
  updateShopSchema,
  shopIdParamsSchema,
  type CreateShopInput,
  type UpdateShopInput,
  type ShopIdParamsInput,
} from '../../schemas/admin.schema';
import {
  createShop,
  deleteShop,
  getPrestaShopCategories,
  getShopImportReadiness,
  listShops,
  testShopConnection,
  updateShop,
} from '../../services/admin/shops.service';
import {
  triggerManualSync,
  enableShopSync,
  disableShopSync,
  updateShopSyncInterval,
} from '../../services/scheduler/scheduler.service';
import { buildBulkStockUrl } from '../../services/shops/prestashop-stock-client';
import * as shopWebhookService from '../../services/webhooks/prestashop-order-webhook.service';

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

function normalizeOptionalString(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

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
    try {
      const categories = await getPrestaShopCategories(request.params.id);
      return reply.send(categories);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nie udało się pobrać kategorii PrestaShop';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

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

  // PATCH /admin/shops/:id/bulk-stock-config
  fastify.patch<{ Params: ShopIdParamsInput; Body: { bulkStockUrl?: string | null; bulkStockApiKey?: string | null } }>(
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
          },
        },
      },
    },
    async (request, reply) => {
      const shopId = request.params.id;
      const { bulkStockUrl, bulkStockApiKey } = request.body ?? {};
      try {
        const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { id: true, configJson: true } });
        if (!shop) return reply.status(404).send({ error: 'Not Found', message: 'Sklep nie znaleziony' });

        const existing = (shop.configJson && typeof shop.configJson === 'object' && !Array.isArray(shop.configJson))
          ? shop.configJson as Record<string, unknown>
          : {};

        const nextBulkStockUrl = normalizeOptionalString(bulkStockUrl);
        const providedBulkStockApiKey = normalizeOptionalString(bulkStockApiKey);
        const existingBulkStockApiKey = typeof existing.bulkStockApiKey === 'string'
          ? existing.bulkStockApiKey
          : null;
        const nextBulkStockApiKey = bulkStockApiKey === undefined
          ? existingBulkStockApiKey
          : providedBulkStockApiKey
            ? encrypt(providedBulkStockApiKey)
            : null;

        const updated = {
          ...existing,
          bulkStockUrl: nextBulkStockUrl,
          bulkStockApiKey: nextBulkStockApiKey,
        };

        await prisma.shop.update({ where: { id: shopId }, data: { configJson: updated } });
        return reply.send({ success: true, hasBulkStock: Boolean(updated.bulkStockApiKey) });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd zapisu konfiguracji bulk';
        return reply.status(500).send({ error: 'Error', message });
      }
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
      const shopId = request.params.id;
      const shop = await prisma.shop.findUnique({
        where: { id: shopId },
        select: { id: true, baseUrl: true, configJson: true },
      });
      if (!shop) {
        return reply.status(404).send({ error: 'Not Found', message: 'Sklep nie znaleziony' });
      }

      const config = (shop.configJson && typeof shop.configJson === 'object' && !Array.isArray(shop.configJson))
        ? shop.configJson as Record<string, unknown>
        : {};
      const configuredUrl = normalizeOptionalString(config.bulkStockUrl);
      const url = configuredUrl ?? buildBulkStockUrl(shop.baseUrl.replace(/\/+$/, '').replace(/\/api$/, ''));
      const apiKey = typeof config.bulkStockApiKey === 'string' && config.bulkStockApiKey
        ? decrypt(config.bulkStockApiKey)
        : null;

      const startedAt = Date.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (apiKey) headers['X-Api-Key'] = apiKey;

        const res = await fetch(url, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        const text = await res.text().catch(() => '');
        const contentType = res.headers.get('content-type') ?? '';
        const bodyPreview = text.slice(0, 400);
        const looksJson = contentType.includes('application/json') || bodyPreview.trim().startsWith('{');
        const expectedGet405 = res.status === 405 && looksJson;
        const ok = looksJson && res.status !== 503;
        const message = expectedGet405
          ? 'Endpoint modułu jest osiągalny. GET zwrócił oczekiwane HTTP 405 JSON.'
          : res.status === 503 && !looksJson
            ? 'Endpoint zwraca HTML 503 przed kontrolerem modułu. Sprawdź maintenance/CDN/IP whitelist lub URL sklepu multistore.'
            : ok
              ? `Endpoint zwraca JSON HTTP ${res.status}; moduł prawdopodobnie odpowiada, ale oczekiwany test GET to HTTP 405.`
              : `Endpoint nie zwrócił odpowiedzi JSON modułu. HTTP ${res.status}.`;

        return reply.send({
          ok,
          expectedGet405,
          status: res.status,
          latencyMs: Date.now() - startedAt,
          contentType,
          url,
          message,
          bodyPreview,
        });
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : 'Nie udało się połączyć z endpointem kp_bulkstock';
        return reply.send({
          ok: false,
          expectedGet405: false,
          status: 0,
          latencyMs: Date.now() - startedAt,
          contentType: '',
          url,
          message,
          bodyPreview: '',
        });
      } finally {
        clearTimeout(timeout);
      }
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
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        await deleteShop(paramsParsed.data.id);
        return reply.send({
          success: true,
          message: 'Integracja została usunięta',
        });
      } catch (error) {
        fastify.log.error(error);

        if (error instanceof Error && error.message === 'Integracja nie istnieje') {
          return reply.status(404).send({
            error: 'Not Found',
            message: error.message,
          });
        }

        return reply.status(500).send({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Nie udało się usunąć integracji',
        });
      }
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
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        const result = await getShopImportReadiness(paramsParsed.data.id);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się sprawdzić gotowości importu';
        const status = message.includes('nie znalezion') ? 404 : 400;
        return reply.status(status).send({ error: 'Error', message });
      }
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
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        const result = await shopWebhookService.getShopWebhookSettings(paramsParsed.data.id);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się pobrać konfiguracji webhooka';
        return reply.status(message === 'Shop not found' ? 404 : 500).send({
          error: message === 'Shop not found' ? 'Not Found' : 'Internal Server Error',
          message,
        });
      }
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
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        const result = await shopWebhookService.updateShopWebhookSettings(paramsParsed.data.id, request.body || {});
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się zapisać konfiguracji webhooka';
        return reply.status(message === 'Shop not found' ? 404 : 500).send({
          error: message === 'Shop not found' ? 'Not Found' : 'Internal Server Error',
          message,
        });
      }
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
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        const result = await shopWebhookService.rotateShopWebhookSecret(paramsParsed.data.id);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się wygenerować sekretu webhooka';
        return reply.status(message === 'Shop not found' ? 404 : 500).send({
          error: message === 'Shop not found' ? 'Not Found' : 'Internal Server Error',
          message,
        });
      }
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
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        const result = await shopWebhookService.listShopWebhookEvents(paramsParsed.data.id, request.query);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się pobrać zdarzeń webhooka';
        return reply.status(message === 'Shop not found' ? 404 : 500).send({
          error: message === 'Shop not found' ? 'Not Found' : 'Internal Server Error',
          message,
        });
      }
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
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success || !request.params.eventId) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.success ? 'eventId is required' : paramsParsed.error.errors[0].message,
        });
      }

      try {
        const result = await shopWebhookService.reprocessShopWebhookEvent(paramsParsed.data.id, request.params.eventId);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się ponowić zdarzenia webhooka';
        return reply.status(message.includes('not found') ? 404 : 500).send({
          error: message.includes('not found') ? 'Not Found' : 'Internal Server Error',
          message,
        });
      }
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
  fastify.post<{
    Params: ShopIdParamsInput;
    Querystring: { wait?: string | boolean };
    Body: { fromDate?: string; fromOrderId?: string; limit?: number };
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
            fromDate: { type: 'string', description: 'Data od której synchronizować (YYYY-MM-DD)' },
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
        Body: { fromDate?: string; fromOrderId?: string; limit?: number };
      }>,
      reply: FastifyReply
    ) => {
      const paramsParsed = shopIdParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        const wait = request.query.wait === true || request.query.wait === 'true';
        const body = request.body ?? {};
        fastify.log.info({ shopId: paramsParsed.data.id, wait, ...body }, 'Manual sync triggered');
        const result = await triggerManualSync(paramsParsed.data.id, {
          wait,
          fromDate: body.fromDate,
          fromOrderId: body.fromOrderId,
          limit: body.limit,
        });
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
    {
      schema: {
        tags: ['shops'],
        summary: 'Włącz auto-synchronizację dla sklepu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object' } },
      },
    },
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
    {
      schema: {
        tags: ['shops'],
        summary: 'Wyłącz auto-synchronizację dla sklepu',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object' } },
      },
    },
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
