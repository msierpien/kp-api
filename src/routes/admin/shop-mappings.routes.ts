import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as shopMappingsService from '../../services/admin/shop-mappings.service';

export async function shopMappingsRoutes(fastify: FastifyInstance) {
  fastify.get('/', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Lista mapowań produktów sklepu do produktów magazynowych',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          shopId: { type: 'string' },
          search: { type: 'string' },
          isMapped: { type: 'boolean' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: shopMappingsService.ShopMappingsQuery }>, reply: FastifyReply) => {
    try {
      const result = await shopMappingsService.getShopMappings(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania mapowań';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Dodaj ręczne mapowanie produktu sklepu',
      body: {
        type: 'object',
        required: ['shopId', 'externalProductId', 'externalSku'],
        properties: {
          shopId: { type: 'string' },
          externalProductId: { type: 'string', minLength: 1 },
          externalSku: { type: 'string', minLength: 1 },
          externalName: { type: 'string' },
          warehouseProductId: { type: ['string', 'null'] },
          isActive: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: shopMappingsService.CreateShopMappingInput }>, reply: FastifyReply) => {
    try {
      const mapping = await shopMappingsService.createShopMapping(request.body);
      return reply.status(201).send(mapping);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia mapowania';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.get('/unmapped/:shopId', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Lista niezamapowanych produktów sklepu',
      params: {
        type: 'object',
        required: ['shopId'],
        properties: { shopId: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          search: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { shopId: string };
    Querystring: Omit<shopMappingsService.ShopMappingsQuery, 'shopId' | 'isMapped'>;
  }>, reply: FastifyReply) => {
    try {
      const result = await shopMappingsService.getUnmappedProducts(request.params.shopId, request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania niezamapowanych produktów';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.put('/:id', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Edytuj mapowanie produktu sklepu',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          externalSku: { type: 'string', minLength: 1 },
          externalName: { type: ['string', 'null'] },
          warehouseProductId: { type: ['string', 'null'] },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: shopMappingsService.UpdateShopMappingInput;
  }>, reply: FastifyReply) => {
    try {
      const mapping = await shopMappingsService.updateShopMapping(request.params.id, request.body);
      return reply.send(mapping);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji mapowania';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.put('/:id/map', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Powiąż produkt sklepu z produktem magazynowym',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['warehouseProductId'],
        properties: { warehouseProductId: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: shopMappingsService.MapShopProductInput;
  }>, reply: FastifyReply) => {
    try {
      const mapping = await shopMappingsService.mapShopProductToWarehouse(request.params.id, request.body);
      return reply.send(mapping);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd mapowania produktu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.delete('/:id/unmap', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Odepnij produkt sklepu od produktu magazynowego',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const mapping = await shopMappingsService.unmapShopProduct(request.params.id);
      return reply.send(mapping);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd odpinania mapowania';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.delete('/:id', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Usuń mapowanie produktu sklepu',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      await shopMappingsService.deleteShopMapping(request.params.id);
      return reply.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania mapowania';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });
}
