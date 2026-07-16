import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as wholesaleService from '../../../services/admin/wholesale.service';
import {
  refreshWholesaleProviderSchedule,
  removeWholesaleProviderFromScheduler,
} from '../../../services/scheduler/scheduler.service';

export async function registerWholesaleProviderRoutes(fastify: FastifyInstance) {
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
          availabilityRule: { type: 'string', enum: ['STOCK_ONLY', 'STOCK_OR_FUTURE_DELIVERY'] },
          feedSafety: {
            type: 'object',
            properties: {
              minItems: { type: 'integer', minimum: 1, maximum: 1000000 },
              maxDropPercent: { type: 'number', minimum: 0, maximum: 95 },
              maxInvalidPercent: { type: 'number', minimum: 0, maximum: 100 },
            },
          },
          syncEnabled: { type: 'boolean', default: true },
          syncInterval: { type: 'integer', minimum: 30, maximum: 1440, default: 1440 },
          leadTimeDays: { type: ['integer', 'null'], minimum: 0, maximum: 365 },
          isActive: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: wholesaleService.CreateWholesaleProviderInput }>, reply: FastifyReply) => {
    try {
      const provider = await wholesaleService.createWholesaleProvider(request.body);
      await refreshWholesaleProviderSchedule(provider.id);
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

  fastify.patch('/providers/lead-times', {
    schema: {
      tags: ['wholesale'],
      summary: 'Masowo zapisz czasy dostawy dostawców hurtowni',
      body: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: {
              type: 'object',
              required: ['providerId'],
              properties: {
                providerId: { type: 'string', minLength: 1 },
                leadTimeDays: { type: ['integer', 'null'], minimum: 0, maximum: 365 },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: wholesaleService.BulkUpdateWholesaleProviderLeadTimesInput }>, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.bulkUpdateWholesaleProviderLeadTimes(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd zapisu czasów dostawy dostawców';
      const status = message.includes('Brak kontekstu') ? 400 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.get('/providers/diagnostics', {
    schema: {
      tags: ['wholesale'],
      summary: 'Diagnostyka duplikatów providerów i kodów hurtowni',
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.getWholesaleDiagnostics();
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd diagnostyki hurtowni';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
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
          availabilityRule: { type: 'string', enum: ['STOCK_ONLY', 'STOCK_OR_FUTURE_DELIVERY'] },
          feedSafety: {
            type: 'object',
            properties: {
              minItems: { type: 'integer', minimum: 1, maximum: 1000000 },
              maxDropPercent: { type: 'number', minimum: 0, maximum: 95 },
              maxInvalidPercent: { type: 'number', minimum: 0, maximum: 100 },
            },
          },
          syncEnabled: { type: 'boolean' },
          syncInterval: { type: 'integer', minimum: 30, maximum: 1440 },
          leadTimeDays: { type: ['integer', 'null'], minimum: 0, maximum: 365 },
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
      await refreshWholesaleProviderSchedule(request.params.id);
      return reply.send(provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji hurtowni';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.put('/providers/:id/sync/interval', {
    schema: {
      tags: ['wholesale'],
      summary: 'Ustaw harmonogram synchronizacji hurtowni',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['intervalMinutes'],
        properties: {
          intervalMinutes: { type: 'integer', minimum: 30, maximum: 1440 },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: wholesaleService.UpdateWholesaleSyncIntervalInput;
  }>, reply: FastifyReply) => {
    try {
      const provider = await wholesaleService.updateWholesaleProviderSyncInterval(request.params.id, request.body);
      await refreshWholesaleProviderSchedule(request.params.id);
      return reply.send(provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd zmiany harmonogramu hurtowni';
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
      removeWholesaleProviderFromScheduler(request.params.id);
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
      summary: 'Zleć synchronizację feedu CSV hurtowni do kolejki',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1 },
          batchSize: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: wholesaleService.SyncWholesaleProviderOptions;
  }>, reply: FastifyReply) => {
    try {
      const result = await wholesaleService.syncWholesaleProvider(request.params.id, request.body ?? {});
      return reply.status(202).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd synchronizacji hurtowni';
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
