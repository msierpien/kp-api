import { FastifyInstance } from 'fastify';
import { registerWarehouseDashboardRoutes } from './warehouse/dashboard.routes';
import { registerWarehouseLeadTimeGroupRoutes } from './warehouse/lead-time-groups.routes';
import { registerWarehouseScannerRoutes } from './warehouse/scanner.routes';
import { registerWarehouseStockRoutes } from './warehouse/stock.routes';
import { registerWarehouseDocumentRoutes } from './warehouse/documents.routes';
import { registerWarehouseProductRoutes } from './warehouse/products.routes';
import { registerWarehousePricingRoutes } from './warehouse/pricing.routes';

export async function warehouseRoutes(fastify: FastifyInstance) {
  // ─── Dashboard ────────────────────────────────────────────────────────────

  await registerWarehouseDashboardRoutes(fastify);

  // ─── Lead Time Groups ────────────────────────────────────────────────────

  await registerWarehouseLeadTimeGroupRoutes(fastify);

  // ─── Barcodes / scanner ──────────────────────────────────────────────────

  await registerWarehouseScannerRoutes(fastify);

  // ─── Products ─────────────────────────────────────────────────────────────

  await registerWarehouseProductRoutes(fastify);

  // ─── Pricing ──────────────────────────────────────────────────────────────

  await registerWarehousePricingRoutes(fastify);

  // ─── Documents ────────────────────────────────────────────────────────────

  await registerWarehouseDocumentRoutes(fastify);

  // ─── Stock ────────────────────────────────────────────────────────────────

  await registerWarehouseStockRoutes(fastify);
}
