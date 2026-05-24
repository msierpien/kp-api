import { FastifyInstance } from 'fastify';
import { registerWholesaleMappingRoutes } from './wholesale/mappings.routes';
import { registerWholesaleProviderRoutes } from './wholesale/providers.routes';

export async function wholesaleRoutes(fastify: FastifyInstance) {
  // ─── Providers ────────────────────────────────────────────────────────────

  await registerWholesaleProviderRoutes(fastify);

  // ─── Offers / mappings ────────────────────────────────────────────────────

  await registerWholesaleMappingRoutes(fastify);
}
