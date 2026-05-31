import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as pricingService from '../../../services/admin/warehouse-pricing.service';

export async function registerWarehousePricingRoutes(fastify: FastifyInstance) {
  fastify.get('/pricing-rules', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Lista reguł cennika',
      querystring: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['GLOBAL', 'SHOP', 'CATALOG', 'PRODUCT'] },
          shopId: { type: 'string' },
          catalogId: { type: 'string' },
          warehouseProductId: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: pricingService.PricingRulesQuery }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.getPricingRules(request.query));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania reguł cennika';
      return reply.status(message.includes('Brak kontekstu') ? 400 : 500).send({ error: 'Error', message });
    }
  });

  fastify.post('/pricing-rules', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Utwórz regułę cennika',
      body: pricingRuleBodySchema(),
    },
  }, async (request: FastifyRequest<{ Body: pricingService.PricingRuleInput }>, reply: FastifyReply) => {
    try {
      return reply.status(201).send(await pricingService.createPricingRule(request.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia reguły cennika';
      return reply.status(400).send({ error: 'Bad Request', message });
    }
  });

  fastify.patch('/pricing-rules/:id', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Edytuj regułę cennika',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: pricingRuleBodySchema(false),
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: Partial<pricingService.PricingRuleInput> }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.updatePricingRule(request.params.id, request.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji reguły cennika';
      return reply.status(message.includes('nie znaleziona') ? 404 : 400).send({ error: 'Error', message });
    }
  });

  fastify.delete('/pricing-rules/:id', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Usuń regułę cennika',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.deletePricingRule(request.params.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania reguły cennika';
      return reply.status(message.includes('nie znaleziona') ? 404 : 400).send({ error: 'Error', message });
    }
  });

  fastify.post('/pricing/preview', {
    schema: { tags: ['warehouse-pricing'], summary: 'Podgląd kalkulacji cennika', body: pricingProductsBodySchema() },
  }, async (request: FastifyRequest<{ Body: pricingService.PricingProductsInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.previewPricing(request.body ?? {}));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd podglądu cennika';
      return reply.status(message.includes('Brak kontekstu') ? 400 : 500).send({ error: 'Error', message });
    }
  });

  fastify.post('/pricing/recalculate', {
    schema: { tags: ['warehouse-pricing'], summary: 'Przelicz i zapisz ceny sklepowe', body: pricingProductsBodySchema() },
  }, async (request: FastifyRequest<{ Body: pricingService.PricingProductsInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.recalculatePricing(request.body ?? {}));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd przeliczania cennika';
      return reply.status(message.includes('Brak kontekstu') ? 400 : 500).send({ error: 'Error', message });
    }
  });

  fastify.post('/pricing/sync', {
    schema: { tags: ['warehouse-pricing'], summary: 'Przelicz i zsynchronizuj ceny do sklepów', body: pricingProductsBodySchema() },
  }, async (request: FastifyRequest<{ Body: pricingService.PricingProductsInput }>, reply: FastifyReply) => {
    try {
      return reply.status(202).send(await pricingService.syncPricing(request.body ?? {}));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd synchronizacji cennika';
      return reply.status(message.includes('Brak kontekstu') ? 400 : 500).send({ error: 'Error', message });
    }
  });
}

export function pricingProductsBodySchema() {
  return {
    type: 'object',
    properties: {
      productIds: { type: 'array', maxItems: 500, items: { type: 'string' } },
      shopIds: { type: 'array', items: { type: 'string' } },
      catalogId: { type: 'string' },
    },
  };
}

function pricingRuleBodySchema(requireLevel = true) {
  return {
    type: 'object',
    ...(requireLevel ? { required: ['level'] } : {}),
    properties: {
      level: { type: 'string', enum: ['GLOBAL', 'SHOP', 'CATALOG', 'PRODUCT'] },
      shopId: { type: ['string', 'null'] },
      catalogId: { type: ['string', 'null'] },
      warehouseProductId: { type: ['string', 'null'] },
      marginPercent: { type: ['number', 'null'], minimum: 0 },
      minProfit: { type: ['number', 'null'], minimum: 0 },
      fixedNetPrice: { type: ['number', 'null'], minimum: 0 },
      vatRate: { type: ['number', 'null'], minimum: 0 },
      roundingMode: { type: 'string', enum: ['END_99', 'TENTH', 'CENT'] },
      syncMode: { type: 'string', enum: ['AUTO', 'CONFIRM', 'MANUAL'] },
      isActive: { type: 'boolean' },
    },
  };
}
