import { FastifyInstance } from 'fastify';
import { authMiddleware, requireAdminPathAccess, requireTenantFeatureAccess } from '../../middleware/auth.middleware';
import { statsRoutes } from './stats.routes';
import { casesRoutes } from './cases.routes';
import { emailRoutes } from './email.routes';
import { syncLogsRoutes } from './sync-logs.routes';
import { shopsRoutes } from './shops.routes';
import { ordersRoutes } from './orders.routes';
import { personalizedProductsRoutes } from './personalized-products.routes';
import { shopMappingsRoutes } from './shop-mappings.routes';
import { templatesRoutes } from './templates.routes';
import { emailSettingsRoutes } from './email-settings.routes';
import { automationsRoutes } from './automations.routes';
import { renderJobsRoutes } from './render-jobs.routes';
import { tenantsRoutes } from './tenants.routes';
import { usersRoutes } from './users.routes';
import { storageRoutes } from './storage.routes';
import { queueRoutes } from './queue.routes';
import { fontsRoutes } from './fonts.routes';
import { warehouseCatalogsRoutes } from './warehouse-catalogs.routes';
import { warehouseRoutes } from './warehouse.routes';
import { wholesaleRoutes } from './wholesale.routes';
import { writeAdminAuditLog } from '../../services/audit/audit-log.service';

export async function adminRoutes(fastify: FastifyInstance) {
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
  fastify.register(personalizedProductsRoutes, { prefix: '/personalized-products' });
  fastify.register(shopMappingsRoutes, { prefix: '/shop-mappings' });
  fastify.register(templatesRoutes, { prefix: '/templates' });
  fastify.register(emailSettingsRoutes, { prefix: '/email-settings' });
  fastify.register(automationsRoutes, { prefix: '/automations' });
  fastify.register(renderJobsRoutes, { prefix: '/render-jobs' });
  fastify.register(tenantsRoutes, { prefix: '/tenants' });
  fastify.register(usersRoutes, { prefix: '/users' });
  fastify.register(storageRoutes, { prefix: '/storage' });
  fastify.register(queueRoutes, { prefix: '/queues' });
  fastify.register(fontsRoutes, { prefix: '/fonts' });
  fastify.register(warehouseCatalogsRoutes, { prefix: '/warehouse/catalogs' });
  fastify.register(warehouseRoutes, { prefix: '/warehouse' });
  fastify.register(wholesaleRoutes, { prefix: '/wholesale' });
}
