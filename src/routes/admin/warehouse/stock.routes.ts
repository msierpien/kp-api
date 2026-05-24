import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as diagnosticsService from '../../../services/admin/warehouse-diagnostics.service';
import * as priceSyncService from '../../../services/price/price-sync.service';
import * as prestaReconciliationService from '../../../services/prestashop/prestashop-reconciliation.service';
import { getStock, recalculateStockCache } from '../../../services/admin/warehouse-stock.service';

export async function registerWarehouseStockRoutes(fastify: FastifyInstance) {
  // GET /admin/warehouse/stock
  fastify.get('/stock', {
    schema: { tags: ['warehouse'], summary: 'Aktualny stan magazynowy wszystkich produktów' },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const stock = await getStock();
      return reply.send(stock);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Błąd pobierania stanów' });
    }
  });

  fastify.get('/stock/discrepancies', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Rozbieżności currentStock względem dokumentów CONFIRMED',
      querystring: {
        type: 'object',
        properties: {
          includeZero: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: diagnosticsService.StockDiscrepanciesQuery }>, reply: FastifyReply) => {
    try {
      const result = await diagnosticsService.getStockDiscrepancies(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania rozbieżności stanów';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.get('/prestashop-reconciliation', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Porównaj ceny i stany magazynu z aktualnymi danymi w PrestaShop',
      querystring: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
          warehouseProductId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
          includeInSync: { type: 'boolean', default: false },
          priceTolerance: { type: 'number', minimum: 0, default: 0.01 },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Querystring: prestaReconciliationService.PrestaShopReconciliationQuery;
  }>, reply: FastifyReply) => {
    try {
      const result = await prestaReconciliationService.getPrestaShopReconciliation(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd reconciliation PrestaShop';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/import-stock-from-prestashop', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Jednorazowy import stanów magazynowych z PrestaShop do bazy magazynowej',
      querystring: {
        type: 'object',
        properties: { shopId: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: { shopId?: string } }>, reply: FastifyReply) => {
    try {
      const result = await prestaReconciliationService.importStockFromPrestaShop(request.query.shopId);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd importu stanów z PrestaShop';
      return reply.status(500).send({ error: 'Error', message });
    }
  });

  fastify.post('/recalculate-stock', {
    schema: { tags: ['warehouse'], summary: 'Przelicz cache currentStock z dokumentów CONFIRMED' },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await recalculateStockCache();
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd przeliczania stanów';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // ─── Stock sync diagnostics ───────────────────────────────────────────────

  fastify.get('/stock-sync-logs', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Logi synchronizacji stanów magazynowych do sklepów',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          shopId: { type: 'string' },
          warehouseProductId: { type: 'string' },
          status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'] },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: diagnosticsService.StockSyncLogsQuery }>, reply: FastifyReply) => {
    try {
      const result = await diagnosticsService.getStockSyncLogs(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania logów synchronizacji stanów';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/stock-sync-logs/:id/retry', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Ponów synchronizację stanu na podstawie logu',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const result = await diagnosticsService.retryStockSyncLog(request.params.id);
      return reply.status(201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd ponawiania synchronizacji stanu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/stock-sync-logs/requeue-pending', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Ponów oczekujące zadania synchronizacji stanu (PENDING) - przywraca je do kolejki BullMQ',
      querystring: {
        type: 'object',
        properties: { shopId: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: { shopId?: string } }>, reply: FastifyReply) => {
    try {
      const { shopId } = request.query;
      const result = await diagnosticsService.requeuePendingStockSyncLogs(shopId);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd ponowienia oczekujących zadań';
      return reply.status(400).send({ error: 'Error', message });
    }
  });

  // ─── Price sync diagnostics ───────────────────────────────────────────────

  fastify.get('/price-sync-logs', {
    schema: {
      tags: ['price-sync'],
      summary: 'Logi synchronizacji cen sprzedaży do sklepów',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          shopId: { type: 'string' },
          warehouseProductId: { type: 'string' },
          status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'] },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: priceSyncService.PriceSyncLogsQuery }>, reply: FastifyReply) => {
    try {
      const result = await priceSyncService.getPriceSyncLogs(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania logów synchronizacji cen';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/price-sync-logs/:id/retry', {
    schema: {
      tags: ['price-sync'],
      summary: 'Ponów synchronizację ceny na podstawie logu',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const result = await priceSyncService.retryPriceSyncLog(request.params.id);
      return reply.status(201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd ponawiania synchronizacji ceny';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });
}
