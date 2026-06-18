import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isAppError } from '../../lib/errors';
import * as competitorAnalytics from '../../services/admin/competitor-analytics.service';

function sendError(reply: FastifyReply, error: unknown, fallback = 'Nie udało się wykonać operacji') {
  if (isAppError(error)) {
    return reply.status(error.statusCode).send({ error: error.error, message: error.message, details: error.details });
  }
  const message = error instanceof Error ? error.message : fallback;
  const status = message.includes('ANALYTICS_MONGO_URI') ? 503 : 500;
  return reply.status(status).send({ error: status === 503 ? 'Service Unavailable' : 'Error', message });
}

export async function competitorAnalyticsRoutes(fastify: FastifyInstance) {
  fastify.get('/overview', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Podsumowanie analityki konkurencji',
      querystring: {
        type: 'object',
        properties: { shopId: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: { shopId?: string } }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.getOverview(request.query));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.get('/products', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Lista produktów z analizą konkurencji',
      querystring: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
          q: { type: 'string' },
          issue: { type: 'string', enum: ['ALL', 'NO_MATCH', 'MISSING_CATEGORY', 'BAD_CATEGORY', 'PRICE_OUTLIER', 'MISSING_DESCRIPTION'] },
          source: { type: 'string' },
          categoryId: { type: 'string' },
          shopPresence: { type: 'string', enum: ['IN_SHOP', 'MISSING_IN_SHOP', 'ALL_WAREHOUSE'] },
          wholesaleAvailable: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
          page: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
          limit: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: competitorAnalytics.ProductListQuery }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.listProducts(request.query));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.get('/match-diagnostics', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Diagnostyka dopasowania produktów do konkurencji',
      querystring: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
          q: { type: 'string' },
          source: { type: 'string' },
          categoryId: { type: 'string' },
          shopPresence: { type: 'string', enum: ['IN_SHOP', 'MISSING_IN_SHOP', 'ALL_WAREHOUSE'] },
          limit: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: competitorAnalytics.MatchDiagnosticsQuery }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.getMatchDiagnostics(request.query));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.get('/products/:warehouseProductId', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Szczegóły produktu z ofertami konkurencji',
      params: {
        type: 'object',
        required: ['warehouseProductId'],
        properties: { warehouseProductId: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: { shopId: { type: 'string' }, source: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { warehouseProductId: string };
    Querystring: { shopId?: string; source?: string };
  }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.getProductDetail(request.params.warehouseProductId, request.query));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.get('/categories', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Drzewo kategorii konkurencji',
      querystring: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          shopId: { type: 'string' },
          includeCounts: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: { source?: string; shopId?: string; includeCounts?: boolean | string } }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.getCategoryTree(request.query));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.get('/category-mappings', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Mapowania kategorii konkurencji do PrestaShop',
      querystring: {
        type: 'object',
        required: ['shopId'],
        properties: { shopId: { type: 'string' }, source: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: competitorAnalytics.CategoryMappingsQuery }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.getCategoryMappings(request.query));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.post('/category-mappings', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Zapisz mapowania kategorii konkurencji',
      body: {
        type: 'object',
        required: ['shopId', 'mappings'],
        properties: {
          shopId: { type: 'string' },
          mappings: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: competitorAnalytics.CategoryMappingInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.saveCategoryMappings(request.body));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.post('/categories/preview', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Podgląd masowej zmiany kategorii',
      body: {
        type: 'object',
        required: ['shopId', 'productIds'],
        properties: {
          shopId: { type: 'string' },
          productIds: { type: 'array', maxItems: 200, items: { type: 'string' } },
          mode: { type: 'string', enum: ['ADD', 'REPLACE'] },
          source: { type: 'string' },
          sourceCategoryId: { type: 'string' },
          targetCategoryId: { type: 'string' },
          targetCategoryName: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: competitorAnalytics.CategoryPreviewInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.previewCategories(request.body));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.post('/categories/apply', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Zastosuj masowa zmiane kategorii',
      body: {
        type: 'object',
        required: ['shopId', 'productIds'],
        properties: {
          shopId: { type: 'string' },
          productIds: { type: 'array', maxItems: 200, items: { type: 'string' } },
          mode: { type: 'string', enum: ['ADD', 'REPLACE'] },
          source: { type: 'string' },
          sourceCategoryId: { type: 'string' },
          targetCategoryId: { type: 'string' },
          targetCategoryName: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: competitorAnalytics.CategoryPreviewInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.applyCategories(request.body));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.post('/prices/preview', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Podgląd masowych sugestii cen',
      body: {
        type: 'object',
        required: ['shopId', 'productIds'],
        properties: {
          shopId: { type: 'string' },
          productIds: { type: 'array', maxItems: 200, items: { type: 'string' } },
          items: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: competitorAnalytics.PricePreviewInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.previewPrices(request.body));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.post('/prices/apply', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Zastosuj masowe sugestie cen',
      body: {
        type: 'object',
        required: ['shopId', 'productIds'],
        properties: {
          shopId: { type: 'string' },
          productIds: { type: 'array', maxItems: 200, items: { type: 'string' } },
          items: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: true } },
          sync: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: competitorAnalytics.PriceApplyInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.applyPrices(request.body));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });

  fastify.post('/descriptions/ai-proposals', {
    schema: {
      tags: ['competitor-analytics'],
      summary: 'Utworz propozycje AI opisow na podstawie konkurencji',
      body: {
        type: 'object',
        required: ['shopId', 'productIds'],
        properties: {
          shopId: { type: 'string' },
          productIds: { type: 'array', maxItems: 200, items: { type: 'string' } },
          action: { type: 'string', enum: ['GENERATE', 'IMPROVE', 'SHORTEN', 'SEO'] },
          templateId: { type: ['string', 'null'] },
          includeImages: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: competitorAnalytics.DescriptionAiInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.createDescriptionAiProposals(request.body));
    } catch (error) {
      fastify.log.error(error);
      return sendError(reply, error);
    }
  });
}
