import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as replenishmentService from '../../../services/admin/warehouse-replenishment.service';

type ReplenishmentListRequest = FastifyRequest<{
  Querystring: replenishmentService.ReplenishmentQuery;
}>;

type ProviderRequest<TBody = unknown> = FastifyRequest<{
  Params: { providerId: string };
  Body: TBody;
}>;

const sourceSchema = { type: 'string', enum: ['order', 'low', 'all'] };
const separatorSchema = { type: 'string', enum: [';', ',', '\t', 'semicolon', 'comma', 'tab'] };

function sendError(reply: FastifyReply, error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const status = message.includes('Brak kontekstu') ||
    message.includes('Nieprawidł') ||
    message.includes('Brak pozycji')
    ? 400
    : 500;

  return reply.status(status).send({ error: 'Error', message });
}

export async function registerWarehouseReplenishmentRoutes(fastify: FastifyInstance) {
  fastify.get('/replenishment', {
    schema: {
      tags: ['warehouse-replenishment'],
      summary: 'Lista pozycji do zamówienia w hurtowni',
      querystring: {
        type: 'object',
        properties: {
          source: sourceSchema,
          providerId: { type: 'string' },
          lowStockThreshold: { type: 'number', default: 1 },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      },
    },
  }, async (request: ReplenishmentListRequest, reply: FastifyReply) => {
    try {
      const result = await replenishmentService.getReplenishment(request.query);
      return reply.send(result);
    } catch (error) {
      return sendError(reply, error, 'Błąd pobierania listy do zamówienia');
    }
  });

  fastify.post('/replenishment/providers/:providerId/export', {
    schema: {
      tags: ['warehouse-replenishment'],
      summary: 'Eksport CSV zamówienia hurtowego dla dostawcy',
      params: {
        type: 'object',
        required: ['providerId'],
        properties: {
          providerId: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          source: sourceSchema,
          lowStockThreshold: { type: 'number', default: 1 },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          format: { type: 'string', enum: ['ean', 'symbol', 'full'], default: 'full' },
          separator: separatorSchema,
          includeHeader: { type: 'boolean', default: true },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['productId', 'quantity'],
              properties: {
                productId: { type: 'string' },
                quantity: { type: 'number', exclusiveMinimum: 0 },
              },
            },
          },
        },
      },
    },
  }, async (request: ProviderRequest<replenishmentService.ReplenishmentCsvInput>, reply: FastifyReply) => {
    try {
      const result = await replenishmentService.buildReplenishmentCsv(request.params.providerId, request.body ?? {});
      return reply.send(result);
    } catch (error) {
      return sendError(reply, error, 'Błąd eksportu CSV zamówienia hurtowego');
    }
  });

  fastify.post('/replenishment/providers/:providerId/order', {
    schema: {
      tags: ['warehouse-replenishment'],
      summary: 'Utworzenie zamówienia hurtowego ZH z listy do zamówienia',
      params: {
        type: 'object',
        required: ['providerId'],
        properties: {
          providerId: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          source: sourceSchema,
          lowStockThreshold: { type: 'number', default: 1 },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['productId', 'quantity'],
              properties: {
                productId: { type: 'string' },
                quantity: { type: 'number', exclusiveMinimum: 0 },
              },
            },
          },
        },
      },
    },
  }, async (request: ProviderRequest<replenishmentService.CreateReplenishmentOrderInput>, reply: FastifyReply) => {
    try {
      const document = await replenishmentService.createWholesaleOrderFromReplenishment(request.params.providerId, request.body ?? {});
      return reply.status(201).send(document);
    } catch (error) {
      return sendError(reply, error, 'Błąd tworzenia zamówienia hurtowego');
    }
  });

  fastify.post('/replenishment/providers/:providerId/draft-pz', {
    schema: {
      tags: ['warehouse-replenishment'],
      summary: 'Alias: utworzenie zamówienia hurtowego ZH z listy do zamówienia',
      params: {
        type: 'object',
        required: ['providerId'],
        properties: {
          providerId: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          source: sourceSchema,
          lowStockThreshold: { type: 'number', default: 1 },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['productId', 'quantity'],
              properties: {
                productId: { type: 'string' },
                quantity: { type: 'number', exclusiveMinimum: 0 },
              },
            },
          },
        },
      },
    },
  }, async (request: ProviderRequest<replenishmentService.CreateReplenishmentOrderInput>, reply: FastifyReply) => {
    try {
      const document = await replenishmentService.createWholesaleOrderFromReplenishment(request.params.providerId, request.body ?? {});
      return reply.status(201).send(document);
    } catch (error) {
      return sendError(reply, error, 'Błąd tworzenia zamówienia hurtowego');
    }
  });
}
