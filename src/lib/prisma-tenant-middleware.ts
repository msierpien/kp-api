import { Prisma } from '@prisma/client';
import { createLogger } from './logger';

// Models that have tenantId field
export const TENANT_MODELS = new Set([
  'User',
  'AuthSession',
  'Shop',
  'PersonalizationTemplate',
  'EmailSettings',
  'WarehouseProduct',
  'WarehouseCatalog',
  'WarehouseLeadTimeGroup',
  'ShopProductMapping',
  'ShopProductImportLog',
  'WarehouseProductBarcode',
  'WarehouseReservation',
  'WarehouseDocument',
  'StockSyncLog',
  'PriceSyncLog',
  'WholesaleProvider',
  'WholesaleProductMapping',
  'WholesaleSyncLog',
]);

const DEBUG_TENANT_CONTEXT = process.env.DEBUG_TENANT_CONTEXT === 'true';
const logger = createLogger('prisma-tenant-middleware');

type TenantScopedData = Record<string, unknown>;

function addTenantWhere(args: Prisma.MiddlewareParams['args'], tenantId: string) {
  args.where = args.where || {};
  args.where.tenantId = tenantId;
}

function addTenantToCreateData(data: unknown, tenantId: string): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => addTenantToCreateData(item, tenantId));
  }

  if (data && typeof data === 'object') {
    return {
      ...(data as TenantScopedData),
      tenantId,
    };
  }

  return data;
}

function stripTenantFromUpdateData(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return data;
  }

  const sanitized = { ...(data as TenantScopedData) };
  delete sanitized.tenantId;
  delete sanitized.tenant;
  return sanitized;
}

// Models that inherit tenantId through relations (read-only access)
// Currently not used but kept for future reference
// const INHERITED_TENANT_MODELS = new Set([
//   'Order', // via shop
//   'OrderItem', // via order
//   'PersonalizationCase', // via order
// ]);

/**
 * Creates Prisma middleware for automatic tenant isolation.
 * 
 * How it works:
 * - For models with direct tenantId: adds `where: { tenantId }` filter to findMany/findFirst/findUnique
 * - For create/update: automatically adds tenantId
 * - For models without tenantId: passes through unchanged
 * - SUPER_ADMIN can optionally bypass filters (future enhancement)
 * 
 * @param getTenantId - Function that returns current tenantId from request context
 */
export function createTenantMiddleware(getTenantId: () => string | null) {
  const middleware: Prisma.Middleware = async (params, next) => {
    const model = params.model;
    const action = params.action;

    if (DEBUG_TENANT_CONTEXT) {
      logger.debug({ model, action }, 'Tenant middleware called');
    }

    const tenantId = getTenantId();

    if (DEBUG_TENANT_CONTEXT && model && TENANT_MODELS.has(model)) {
      logger.debug({ model, action, tenantId }, 'Tenant scoped Prisma operation');
    }

    // If no tenantId in context, pass through (e.g., public routes)
    if (!tenantId) {
      return next(params);
    }

    if (!model) {
      return next(params);
    }

    // Handle models with direct tenantId
    if (TENANT_MODELS.has(model)) {
      // READ operations: add tenantId filter
      if (
        params.action === 'findUnique' ||
        params.action === 'findFirst' ||
        params.action === 'findMany' ||
        params.action === 'count' ||
        params.action === 'aggregate' ||
        params.action === 'groupBy'
      ) {
        params.args = params.args || {};
        addTenantWhere(params.args, tenantId);
      }

      // UPDATE operations: ensure tenantId filter
      if (params.action === 'update' || params.action === 'updateMany') {
        params.args = params.args || {};
        addTenantWhere(params.args, tenantId);
        params.args.data = stripTenantFromUpdateData(params.args.data);
      }

      // DELETE operations: ensure tenantId filter
      if (params.action === 'delete' || params.action === 'deleteMany') {
        params.args = params.args || {};
        addTenantWhere(params.args, tenantId);
      }

      // CREATE operations: automatically add tenantId
      if (params.action === 'create') {
        params.args = params.args || {};
        params.args.data = addTenantToCreateData(params.args.data || {}, tenantId);
      }

      // CREATE MANY operations: add tenantId to all records
      if (params.action === 'createMany') {
        params.args = params.args || {};
        params.args.data = addTenantToCreateData(params.args.data || [], tenantId);
      }

      if (params.action === 'upsert') {
        params.args = params.args || {};
        addTenantWhere(params.args, tenantId);
        params.args.create = params.args.create || {};
        params.args.create = addTenantToCreateData(params.args.create, tenantId);
        params.args.update = stripTenantFromUpdateData(params.args.update);
      }
    }

    // For inherited models, we rely on proper relations
    // (e.g., Order has shopId, Shop has tenantId, so filtering by shop.tenantId works)
    // No automatic filtering here to avoid complexity

    return next(params);
  };

  return middleware;
}
