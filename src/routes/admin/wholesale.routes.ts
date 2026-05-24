import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as wholesaleService from '../../services/admin/wholesale.service';
import { registerWholesaleProviderRoutes } from './wholesale/providers.routes';

export async function wholesaleRoutes(fastify: FastifyInstance) {
  // ─── Providers ────────────────────────────────────────────────────────────

  await registerWholesaleProviderRoutes(fastify);

  // ─── Offers / mappings ────────────────────────────────────────────────────

  fastify.get('/product-offers', {
    schema: {
      tags: ['wholesale'],
      summary: 'Oferty hurtowni pogrupowane po produktach magazynowych',
      querystring: {
        type: 'object',
        required: ['productIds'],
        properties: {
          productIds: {
            type: 'string',
            description: 'Lista ID produktów magazynowych oddzielona przecinkami',
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: wholesaleService.WholesaleProductOffersQuery }>, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.getWholesaleProductOffers(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania ofert hurtowni dla produktów';
      const status = message.includes('Brak kontekstu') ? 400 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/providers/:id/auto-map', {
    schema: {
      tags: ['wholesale'],
      summary: 'Automatycznie powiąż produkty hurtowni z magazynem po SKU i EAN',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          activeOnly: { type: 'boolean', default: true },
          mode: { type: 'string', enum: ['sku_ean', 'sku', 'ean', 'name'], default: 'sku_ean' },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: wholesaleService.AutoMapWholesaleProviderOptions;
  }>, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.autoMapWholesaleProvider(request.params.id, request.body ?? {});
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd automatycznego mapowania hurtowni';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.get('/providers/:id/mappings', {
    schema: {
      tags: ['wholesale'],
      summary: 'Lista produktów hurtowni do mapowania',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          search: { type: 'string' },
          isMapped: { type: 'boolean' },
          isActive: { type: 'boolean' },
          diagnosis: { type: 'string', enum: ['mapped', 'ready', 'missingSku', 'missingEan', 'nameOnly', 'missingData'] },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Querystring: wholesaleService.WholesaleMappingsQuery;
  }>, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.getWholesaleMappings(request.params.id, request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania mapowań hurtowni';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.put('/mappings/:id', {
    schema: {
      tags: ['wholesale'],
      summary: 'Powiąż produkt hurtowni z produktem magazynowym',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['warehouseProductId'],
        properties: {
          warehouseProductId: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: wholesaleService.MapWholesaleProductInput;
  }>, reply: FastifyReply) => {
    try {
      const mapping = await wholesaleService.mapWholesaleProduct(request.params.id, request.body);
      return reply.send(mapping);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd mapowania produktu hurtowni';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/providers/:id/bulk-create-products', {
    schema: {
      tags: ['wholesale'],
      summary: 'Utwórz produkty magazynowe z niezamapowanych ofert hurtowni',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          catalogId: { type: 'string' },
          importEan: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: wholesaleService.BulkCreateWarehouseProductsFromWholesaleInput;
  }>, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.bulkCreateWarehouseProductsFromWholesale(request.params.id, request.body ?? {});
      return reply.status(201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia produktów z hurtowni';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

}
