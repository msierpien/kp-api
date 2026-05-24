import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as diagnosticsService from '../../services/admin/warehouse-diagnostics.service';
import { registerWarehouseLeadTimeGroupRoutes } from './warehouse/lead-time-groups.routes';
import { registerWarehouseScannerRoutes } from './warehouse/scanner.routes';
import { registerWarehouseStockRoutes } from './warehouse/stock.routes';
import { registerWarehouseDocumentRoutes } from './warehouse/documents.routes';
import { registerWarehouseProductRoutes } from './warehouse/products.routes';

export async function warehouseRoutes(fastify: FastifyInstance) {
  fastify.get('/dashboard', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Dashboard problemów i kontroli magazynu',
      querystring: {
        type: 'object',
        properties: {
          lowStockThreshold: { type: 'number', default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          failedSinceDays: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: diagnosticsService.WarehouseDashboardQuery }>, reply: FastifyReply) => {
    try {
      const result = await diagnosticsService.getWarehouseDashboard(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania dashboardu magazynu';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // ─── Lead Time Groups ────────────────────────────────────────────────────

  await registerWarehouseLeadTimeGroupRoutes(fastify);

  // ─── Barcodes / scanner ──────────────────────────────────────────────────

  await registerWarehouseScannerRoutes(fastify);

  // ─── Products ─────────────────────────────────────────────────────────────

  await registerWarehouseProductRoutes(fastify);

  // ─── Documents ────────────────────────────────────────────────────────────

  await registerWarehouseDocumentRoutes(fastify);

  // ─── Stock ────────────────────────────────────────────────────────────────

  await registerWarehouseStockRoutes(fastify);
}
