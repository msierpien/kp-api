import { Prisma } from '@prisma/client';

// Models that have tenantId field
const TENANT_MODELS = new Set([
  'User',
  'Shop',
  'PersonalizationTemplate',
  'EmailSettings',
]);

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
    const tenantId = getTenantId();

    // If no tenantId in context, pass through (e.g., public routes)
    if (!tenantId) {
      return next(params);
    }

    const model = params.model;
    if (!model) {
      return next(params);
    }

    // Handle models with direct tenantId
    if (TENANT_MODELS.has(model)) {
      // READ operations: add tenantId filter
      if (params.action === 'findUnique' || params.action === 'findFirst' || params.action === 'findMany') {
        params.args = params.args || {};
        params.args.where = params.args.where || {};
        
        // Add tenantId to where clause
        params.args.where.tenantId = tenantId;
      }

      // UPDATE operations: ensure tenantId filter
      if (params.action === 'update' || params.action === 'updateMany') {
        params.args = params.args || {};
        params.args.where = params.args.where || {};
        params.args.where.tenantId = tenantId;
      }

      // DELETE operations: ensure tenantId filter
      if (params.action === 'delete' || params.action === 'deleteMany') {
        params.args = params.args || {};
        params.args.where = params.args.where || {};
        params.args.where.tenantId = tenantId;
      }

      // CREATE operations: automatically add tenantId
      if (params.action === 'create') {
        params.args = params.args || {};
        params.args.data = params.args.data || {};
        params.args.data.tenantId = tenantId;
      }

      // CREATE MANY operations: add tenantId to all records
      if (params.action === 'createMany') {
        params.args = params.args || {};
        if (Array.isArray(params.args.data)) {
          params.args.data = params.args.data.map((item: any) => ({
            ...item,
            tenantId,
          }));
        }
      }
    }

    // For inherited models, we rely on proper relations
    // (e.g., Order has shopId, Shop has tenantId, so filtering by shop.tenantId works)
    // No automatic filtering here to avoid complexity

    return next(params);
  };

  return middleware;
}
