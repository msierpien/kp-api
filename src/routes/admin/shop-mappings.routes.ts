import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as shopMappingsService from '../../services/admin/shop-mappings.service';
import * as shopProductImportService from '../../services/admin/shop-product-import.service';

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
          warehouseProductId: { type: 'string' },
          search: { type: 'string' },
          isMapped: { type: 'boolean' },
          isActive: { type: 'boolean' },
          diagnosis: { type: 'string', enum: ['mapped', 'ready', 'missingSku', 'missingEan', 'nameOnly', 'missingData'] },
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
          externalEan: { type: ['string', 'null'] },
          externalName: { type: 'string' },
          externalPrice: { type: ['number', 'null'], minimum: 0 },
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

  fastify.post('/import/:shopId', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Importuj katalog produktów sklepu do mapowań magazynowych',
      params: {
        type: 'object',
        required: ['shopId'],
        properties: { shopId: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 5000 },
          activeOnly: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { shopId: string };
    Body: shopProductImportService.ImportProductsOptions;
  }>, reply: FastifyReply) => {
    try {
      const result = await shopProductImportService.importProductsFromShop(request.params.shopId, request.body ?? {});
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd importu produktów sklepu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/import/:shopId/preview', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Podejrzyj import katalogu produktów sklepu bez zapisu do bazy',
      params: {
        type: 'object',
        required: ['shopId'],
        properties: { shopId: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 5000 },
          activeOnly: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { shopId: string };
    Body: shopProductImportService.ImportProductsOptions;
  }>, reply: FastifyReply) => {
    try {
      const result = await shopProductImportService.previewProductsImport(request.params.shopId, request.body ?? {});
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd podglądu importu produktów sklepu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.get('/import-logs', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Historia importów produktów ze sklepów',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          shopId: { type: 'string' },
          status: { type: 'string', enum: ['SUCCESS', 'FAILED', 'PARTIAL'] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: shopProductImportService.ImportLogsQuery }>, reply: FastifyReply) => {
    try {
      const result = await shopProductImportService.getProductImportLogs(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania historii importów';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/bulk/auto-map', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Automatycznie powiąż produkty sklepu z magazynem po SKU',
      body: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
          activeOnly: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: shopProductImportService.AutoMapShopProductsInput }>, reply: FastifyReply) => {
    try {
      const result = await shopProductImportService.autoMapShopProducts(request.body ?? {});
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd automatycznego mapowania';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/bulk/create-products', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Hurtowo utwórz produkty magazynowe z mapowań sklepu',
      body: {
        type: 'object',
        required: ['mappingIds'],
        properties: {
          mappingIds: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: { type: 'string' },
          },
          catalogId: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: shopProductImportService.BulkCreateWarehouseProductsInput }>, reply: FastifyReply) => {
    try {
      const result = await shopProductImportService.bulkCreateWarehouseProductsFromMappings(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd hurtowego tworzenia produktów magazynowych';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/bulk/create-products-by-filter', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Hurtowo utwórz produkty magazynowe z mapowań pasujących do filtrów',
      body: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
          search: { type: 'string' },
          isMapped: { type: 'boolean' },
          isActive: { type: 'boolean' },
          diagnosis: { type: 'string', enum: ['mapped', 'ready', 'missingSku', 'missingEan', 'nameOnly', 'missingData'] },
          catalogId: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: shopProductImportService.BulkCreateWarehouseProductsFromFiltersInput }>, reply: FastifyReply) => {
    try {
      const result = await shopProductImportService.bulkCreateWarehouseProductsFromFilters(request.body ?? {});
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd hurtowego tworzenia produktów magazynowych po filtrach';
      const status = message.includes('nie znalezion') ? 404 : 400;
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
          externalEan: { type: ['string', 'null'] },
          externalName: { type: ['string', 'null'] },
          externalPrice: { type: ['number', 'null'], minimum: 0 },
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

  fastify.post('/:id/create-product', {
    schema: {
      tags: ['shop-mappings'],
      summary: 'Utwórz produkt magazynowy z mapowania produktu sklepu',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          catalogId: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: shopProductImportService.CreateWarehouseProductFromMappingOptions;
  }>, reply: FastifyReply) => {
    try {
      const mapping = await shopProductImportService.createWarehouseProductFromMapping(
        request.params.id,
        request.body ?? {},
      );
      return reply.status(201).send(mapping);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia produktu magazynowego';
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
