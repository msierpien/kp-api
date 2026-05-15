import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as wholesaleService from '../../services/admin/wholesale.service';

export async function wholesaleRoutes(fastify: FastifyInstance) {
  fastify.get('/providers', {
    schema: {
      tags: ['wholesale'],
      summary: 'Lista providerów hurtowni',
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
  }, async (request: FastifyRequest<{ Querystring: wholesaleService.WholesaleProvidersQuery }>, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.getWholesaleProviders(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania hurtowni';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/providers', {
    schema: {
      tags: ['wholesale'],
      summary: 'Utwórz providera hurtowni CSV',
      body: {
        type: 'object',
        required: ['name', 'feedUrl'],
        properties: {
          name: { type: 'string', minLength: 1 },
          feedUrl: { type: 'string', minLength: 1 },
          platform: { type: 'string', enum: ['CSV_FEED', 'XML_FEED', 'REST_API'], default: 'CSV_FEED' },
          preset: { type: 'string', enum: ['GODAN', 'PARTYDECO', 'CUSTOM'] },
          delimiter: { type: 'string', default: ';' },
          fieldMapping: { type: 'object', additionalProperties: true },
          syncEnabled: { type: 'boolean', default: true },
          isActive: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: wholesaleService.CreateWholesaleProviderInput }>, reply: FastifyReply) => {
    try {
      const provider = await wholesaleService.createWholesaleProvider(request.body);
      return reply.status(201).send(provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia hurtowni';
      return reply.status(400).send({ error: 'Error', message });
    }
  });

  fastify.post('/providers/preview', {
    schema: {
      tags: ['wholesale'],
      summary: 'Podejrzyj kolumny i przykładowe wiersze feedu CSV hurtowni bez zapisu',
      body: {
        type: 'object',
        required: ['feedUrl'],
        properties: {
          feedUrl: { type: 'string', minLength: 1 },
          delimiter: { type: 'string', default: ';' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: wholesaleService.PreviewWholesaleProviderInput }>, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.previewWholesaleProvider(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd podglądu feedu hurtowni';
      const status = message.includes('Brak kontekstu') ? 400 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.get('/providers/:id', {
    schema: {
      tags: ['wholesale'],
      summary: 'Szczegóły providera hurtowni',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const provider = await wholesaleService.getWholesaleProviderById(request.params.id);
      if (!provider) return reply.status(404).send({ error: 'Not Found', message: 'Provider hurtowni nie znaleziony' });
      return reply.send(provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania hurtowni';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.put('/providers/:id', {
    schema: {
      tags: ['wholesale'],
      summary: 'Edytuj providera hurtowni',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          feedUrl: { type: 'string', minLength: 1 },
          platform: { type: 'string', enum: ['CSV_FEED', 'XML_FEED', 'REST_API'] },
          preset: { type: 'string', enum: ['GODAN', 'PARTYDECO', 'CUSTOM'] },
          delimiter: { type: 'string' },
          fieldMapping: { type: 'object', additionalProperties: true },
          syncEnabled: { type: 'boolean' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: wholesaleService.UpdateWholesaleProviderInput;
  }>, reply: FastifyReply) => {
    try {
      const provider = await wholesaleService.updateWholesaleProvider(request.params.id, request.body);
      return reply.send(provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji hurtowni';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.delete('/providers/:id', {
    schema: {
      tags: ['wholesale'],
      summary: 'Usuń providera hurtowni',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      await wholesaleService.deleteWholesaleProvider(request.params.id);
      return reply.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania hurtowni';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/providers/:id/sync', {
    schema: {
      tags: ['wholesale'],
      summary: 'Ręcznie zsynchronizuj feed CSV hurtowni',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: wholesaleService.SyncWholesaleProviderOptions;
  }>, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.syncWholesaleProvider(request.params.id, request.body ?? {});
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd synchronizacji hurtowni';
      const status = message.includes('nie znalezion') ? 404 : 400;
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

  fastify.get('/providers/:id/logs', {
    schema: {
      tags: ['wholesale'],
      summary: 'Logi synchronizacji hurtowni',
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
          status: { type: 'string' },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Querystring: wholesaleService.WholesaleSyncLogsQuery;
  }>, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.getWholesaleSyncLogs(request.params.id, request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania logów hurtowni';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });
}
