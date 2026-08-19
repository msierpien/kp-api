import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAllowedOrigin } from '../../lib/allowed-origins';
import { authMiddleware, requireAdminPathAccess, requireTenantFeatureAccess } from '../../middleware/auth.middleware';
import { requireAdminApiCompatibility } from '../../middleware/admin-compatibility.middleware';
import { statsRoutes } from './stats.routes';
import { casesRoutes } from './cases.routes';
import { emailRoutes } from './email.routes';
import { syncLogsRoutes } from './sync-logs.routes';
import { shopsRoutes } from './shops.routes';
import { ordersRoutes } from './orders.routes';
import { orderReturnsRoutes } from './order-returns.routes';
import { customerReturnRequestsRoutes } from './customer-return-requests.routes';
import { invoicesRoutes } from './invoices.routes';
import { personalizedProductsRoutes } from './personalized-products.routes';
import { shopMappingsRoutes } from './shop-mappings.routes';
import { templatesRoutes } from './templates.routes';
import { emailSettingsRoutes } from './email-settings.routes';
import { aiSettingsRoutes } from './ai-settings.routes';
import { printSettingsRoutes } from './print-settings.routes';
import { automationsRoutes } from './automations.routes';
import { renderJobsRoutes } from './render-jobs.routes';
import { printJobsRoutes } from './print-jobs.routes';
import { printAgentsRoutes } from './print-agents.routes';
import { tenantsRoutes } from './tenants.routes';
import { usersRoutes } from './users.routes';
import { storageRoutes } from './storage.routes';
import { queueRoutes } from './queue.routes';
import { fontsRoutes } from './fonts.routes';
import { decorationsRoutes } from './decorations.routes';
import { templateBlocksRoutes } from './template-blocks.routes';
import { warehouseCatalogsRoutes } from './warehouse-catalogs.routes';
import { warehouseRoutes } from './warehouse.routes';
import { wholesaleRoutes } from './wholesale.routes';
import { competitorAnalyticsRoutes } from './competitor-analytics.routes';
import { writeAdminAuditLog } from '../../services/audit/audit-log.service';

/**
 * Straznik CSRF dla zapisow w panelu.
 *
 * Ciasteczka sesji admina musza miec `SameSite=None` (panel stoi na innej
 * domenie niz API), wiec przegladarka dolacza je takze do zadan z obcych
 * stron. Preflight ratuje tylko JSON - `multipart/form-data` to zadanie
 * proste i CORS go nie zatrzyma, czyli obca strona moze wyslac upload
 * w imieniu zalogowanego admina. Zadania bez naglowka Origin (curl, skrypty
 * serwerowe, integracje) przepuszczamy - przegladarka zawsze go ustawia
 * przy zadaniach mutujacych, a te nie sa wektorem CSRF.
 */
function requireTrustedOrigin() {
  const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!mutatingMethods.has(request.method)) return;

    const origin = request.headers.origin;
    if (!origin || isAllowedOrigin(origin)) return;

    request.log.warn({ origin, url: request.url }, 'Odrzucone zadanie z niedozwolonego origin');
    return reply.status(403).send({
      error: 'Forbidden',
      message: 'Żądanie z niedozwolonego źródła',
    });
  };
}

export async function adminRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', requireTrustedOrigin());
  fastify.addHook('preHandler', requireAdminApiCompatibility());
  // Apply auth middleware to all admin routes
  fastify.addHook('preHandler', authMiddleware(fastify));
  fastify.addHook('preHandler', requireAdminPathAccess());
  fastify.addHook('preHandler', requireTenantFeatureAccess());
  fastify.addHook('onResponse', writeAdminAuditLog);

  // Register admin sub-routes
  fastify.register(statsRoutes, { prefix: '/stats' });
  fastify.register(casesRoutes, { prefix: '/cases' });
  fastify.register(emailRoutes, { prefix: '/email' });
  fastify.register(syncLogsRoutes, { prefix: '/sync-logs' });
  fastify.register(shopsRoutes, { prefix: '/shops' });
  fastify.register(ordersRoutes, { prefix: '/orders' });
  fastify.register(orderReturnsRoutes, { prefix: '/order-returns' });
  fastify.register(customerReturnRequestsRoutes, { prefix: '/customer-return-requests' });
  fastify.register(invoicesRoutes, { prefix: '/invoices' });
  fastify.register(personalizedProductsRoutes, { prefix: '/personalized-products' });
  fastify.register(shopMappingsRoutes, { prefix: '/shop-mappings' });
  fastify.register(templatesRoutes, { prefix: '/templates' });
  fastify.register(emailSettingsRoutes, { prefix: '/email-settings' });
  fastify.register(aiSettingsRoutes, { prefix: '/ai-settings' });
  fastify.register(printSettingsRoutes, { prefix: '/print-settings' });
  fastify.register(automationsRoutes, { prefix: '/automations' });
  fastify.register(renderJobsRoutes, { prefix: '/render-jobs' });
  fastify.register(printJobsRoutes, { prefix: '/print-jobs' });
  fastify.register(printAgentsRoutes, { prefix: '/print-agents' });
  fastify.register(tenantsRoutes, { prefix: '/tenants' });
  fastify.register(usersRoutes, { prefix: '/users' });
  fastify.register(storageRoutes, { prefix: '/storage' });
  fastify.register(queueRoutes, { prefix: '/queues' });
  fastify.register(fontsRoutes, { prefix: '/fonts' });
  fastify.register(decorationsRoutes, { prefix: '/decorations' });
  fastify.register(templateBlocksRoutes, { prefix: '/template-blocks' });
  fastify.register(warehouseCatalogsRoutes, { prefix: '/warehouse/catalogs' });
  fastify.register(warehouseRoutes, { prefix: '/warehouse' });
  fastify.register(wholesaleRoutes, { prefix: '/wholesale' });
  fastify.register(competitorAnalyticsRoutes, { prefix: '/competitor-analytics' });
}
