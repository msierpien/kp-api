import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as pricingService from '../../../services/admin/warehouse-pricing.service';
import * as competitorAnalytics from '../../../services/admin/competitor-analytics.service';
import { refreshCompetitorPriceAutomationSchedule } from '../../../services/scheduler/scheduler.service';
import { getTenantId } from '../../../lib/tenant-context';

export async function registerWarehousePricingRoutes(fastify: FastifyInstance) {
  fastify.get('/pricing-rules', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Lista reguł cennika',
      querystring: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['GLOBAL', 'SHOP', 'CATALOG', 'GROUP', 'PRODUCT'] },
          priceGroupId: { type: 'string' },
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

  fastify.get('/pricing/settings', {
    schema: { tags: ['warehouse-pricing'], summary: 'Ustawienia domyślne cennika' },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.getPricingSettings());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania ustawień cennika';
      return reply.status(message.includes('Brak kontekstu') ? 400 : 500).send({ error: 'Error', message });
    }
  });

  fastify.patch('/pricing/settings', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Edytuj ustawienia domyślne cennika',
      body: pricingSettingsBodySchema(),
    },
  }, async (request: FastifyRequest<{ Body: pricingService.PricingSettingsInput }>, reply: FastifyReply) => {
    try {
      const result = await pricingService.updatePricingSettings(request.body);
      const tenantId = getTenantId();
      if (
        tenantId
        && (
          request.body.competitorAutoPricingEnabled !== undefined
          || request.body.competitorAutoPricingShopId !== undefined
          || request.body.competitorAutoPricingIntervalMinutes !== undefined
        )
      ) {
        await refreshCompetitorPriceAutomationSchedule(tenantId);
      }
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji ustawień cennika';
      return reply.status(400).send({ error: 'Bad Request', message });
    }
  });

  fastify.get('/pricing/products', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Product-first lista efektywnych cen',
      querystring: {
        type: 'object',
        required: ['shopId'],
        properties: {
          shopId: { type: 'string' },
          search: { type: 'string' },
          priceGroupId: { type: 'string' },
          categoryId: { type: 'string' },
          categoryIds: { type: 'string' },
          expandedFamilyKeys: { type: 'string' },
          groupVariants: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
          source: { type: 'string', enum: ['ALL', 'CLEARANCE', 'PRODUCT', 'GROUP', 'CATALOG', 'SHOP', 'DEFAULT', 'CEILING_FALLBACK'] },
          status: { type: 'string', enum: ['ALL', 'READY', 'MISSING_PRICE', 'WARNING', 'ALERT', 'NO_GROUP', 'OVERRIDES_GROUP', 'BELOW_COST'] },
          ruleOrigin: { type: 'string', enum: ['ALL', 'MANUAL', 'COMPETITOR_AUTO', 'COMPETITOR_MANUAL', 'SYSTEM', 'FIXED_MANUAL', 'FIXED_COMPETITOR_AUTO', 'FIXED_ANY'] },
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: pricingService.PricingProductsQuery }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.getPricingProducts(request.query));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania produktów cennika';
      return reply.status(message.includes('nie istnieje') ? 404 : message.includes('Wybierz') ? 400 : 500).send({ error: 'Error', message });
    }
  });

  fastify.get('/pricing/groups', {
    schema: { tags: ['warehouse-pricing'], summary: 'Lista grup cenowych' },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.listPriceGroups());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania grup cenowych';
      return reply.status(message.includes('Brak kontekstu') ? 400 : 500).send({ error: 'Error', message });
    }
  });

  fastify.post('/pricing/groups', {
    schema: { tags: ['warehouse-pricing'], summary: 'Utwórz grupę cenową', body: priceGroupBodySchema() },
  }, async (request: FastifyRequest<{ Body: pricingService.PriceGroupInput }>, reply: FastifyReply) => {
    try {
      return reply.status(201).send(await pricingService.createPriceGroup(request.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia grupy cenowej';
      return reply.status(400).send({ error: 'Bad Request', message });
    }
  });

  fastify.patch('/pricing/groups/:id', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Edytuj grupę cenową',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: priceGroupBodySchema(false),
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: Partial<pricingService.PriceGroupInput> }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.updatePriceGroup(request.params.id, request.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji grupy cenowej';
      return reply.status(message.includes('nie znaleziona') ? 404 : 400).send({ error: 'Error', message });
    }
  });

  fastify.get('/pricing/groups/:id/members', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Lista produktów w grupie cenowej',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
          search: { type: 'string' },
          shopId: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Querystring: pricingService.PriceGroupMembersQuery }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.listPriceGroupMembers(request.params.id, request.query));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania produktów grupy';
      return reply.status(message.includes('nie znaleziona') ? 404 : 400).send({ error: 'Error', message });
    }
  });

  fastify.post('/pricing/groups/:id/members', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Dodaj produkty do grupy cenowej',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', required: ['productIds'], properties: { productIds: { type: 'array', maxItems: 500, items: { type: 'string' } } } },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: pricingService.PriceGroupMembersInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.addPriceGroupMembers(request.params.id, request.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd dodawania produktów do grupy';
      return reply.status(message.includes('nie znaleziona') ? 404 : 400).send({ error: 'Error', message });
    }
  });

  fastify.delete('/pricing/groups/:id/members/:productId', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Usuń produkt z grupy cenowej',
      params: {
        type: 'object',
        required: ['id', 'productId'],
        properties: { id: { type: 'string' }, productId: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string; productId: string } }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.removePriceGroupMember(request.params.id, request.params.productId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania produktu z grupy';
      return reply.status(400).send({ error: 'Error', message });
    }
  });

  fastify.put('/pricing/groups/:id/price', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Ustaw cenę grupy',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: groupPriceBodySchema(),
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: pricingService.PriceGroupPriceInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.setPriceGroupPrice(request.params.id, request.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd ustawiania ceny grupy';
      return reply.status(message.includes('nie znaleziona') ? 404 : 400).send({ error: 'Error', message });
    }
  });

  fastify.get('/pricing/clearances', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Lista wyprzedaży cennika',
      querystring: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['PRODUCT', 'GROUP'] },
          warehouseProductId: { type: 'string' },
          priceGroupId: { type: 'string' },
          shopId: { type: 'string' },
          isActive: { anyOf: [{ type: 'boolean' }, { type: 'string' }] },
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: pricingService.ClearanceQuery }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.listClearances(request.query));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania wyprzedaży';
      return reply.status(400).send({ error: 'Error', message });
    }
  });

  fastify.post('/pricing/clearances', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Utwórz wyprzedaż produktu albo grupy',
      body: clearanceBodySchema(),
    },
  }, async (request: FastifyRequest<{ Body: pricingService.ClearanceInput }>, reply: FastifyReply) => {
    try {
      return reply.status(201).send(await pricingService.createClearance(request.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia wyprzedaży';
      return reply.status(400).send({ error: 'Bad Request', message });
    }
  });

  fastify.patch('/pricing/clearances/:id', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Edytuj wyprzedaż',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: clearanceBodySchema(false),
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: Partial<pricingService.ClearanceInput> }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.updateClearance(request.params.id, request.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji wyprzedaży';
      return reply.status(message.includes('nie znaleziona') ? 404 : 400).send({ error: 'Error', message });
    }
  });

  fastify.delete('/pricing/clearances/:id', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Dezaktywuj wyprzedaż',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.deactivateClearance(request.params.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd dezaktywacji wyprzedaży';
      return reply.status(message.includes('nie znaleziona') ? 404 : 400).send({ error: 'Error', message });
    }
  });

  fastify.post('/pricing/products/:productId/revert-to-group', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Cofnij nadpisanie produktu do ceny grupy',
      params: { type: 'object', required: ['productId'], properties: { productId: { type: 'string' } } },
      body: { type: 'object', required: ['shopId'], properties: { shopId: { type: 'string' } } },
    },
  }, async (request: FastifyRequest<{ Params: { productId: string }; Body: pricingService.RevertProductToGroupInput }>, reply: FastifyReply) => {
    try {
      return reply.send(await pricingService.revertProductToGroup(request.params.productId, request.body));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd cofania nadpisania produktu';
      return reply.status(message.includes('nie znalezion') ? 404 : 400).send({ error: 'Error', message });
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

  fastify.get('/pricing/competitor-auto/runs', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Historia automatycznych uruchomień cen konkurencji',
      querystring: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
          limit: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: { shopId?: string; limit?: number | string } }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.listCompetitorPriceAutomationRuns(request.query));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania historii automatu cen konkurencji';
      return reply.status(message.includes('Brak kontekstu') ? 400 : 500).send({ error: 'Error', message });
    }
  });

  fastify.post('/pricing/competitor-auto/run-now', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Uruchom automatyczne ceny konkurencji teraz',
      body: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: { shopId?: string } }>, reply: FastifyReply) => {
    try {
      return reply.send(await competitorAnalytics.runCompetitorPriceAutomation(request.body ?? {}));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd uruchamiania automatu cen konkurencji';
      return reply.status(message.includes('Wybierz') || message.includes('już uruchomiona') ? 400 : 500).send({ error: 'Error', message });
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
      priceGroupId: { type: 'string' },
      scope: { type: 'string', enum: ['SELECTED', 'FILTERED', 'GROUP', 'CATEGORY', 'SHOP'] },
      filters: { type: 'object', additionalProperties: true },
      allowBelowCostSync: { type: 'boolean' },
    },
  };
}

function pricingRuleBodySchema(requireLevel = true) {
  return {
    type: 'object',
    ...(requireLevel ? { required: ['level'] } : {}),
    properties: {
      level: { type: 'string', enum: ['GLOBAL', 'SHOP', 'CATALOG', 'GROUP', 'PRODUCT'] },
      shopId: { type: ['string', 'null'] },
      catalogId: { type: ['string', 'null'] },
      priceGroupId: { type: ['string', 'null'] },
      warehouseProductId: { type: ['string', 'null'] },
      marginPercent: { type: ['number', 'null'], minimum: 0 },
      minProfit: { type: ['number', 'null'], minimum: 0 },
      fixedNetPrice: { type: ['number', 'null'], minimum: 0 },
      priceMode: { type: 'string', enum: ['MARGIN', 'FIXED'] },
      costCeilingEnabled: { type: ['boolean', 'null'] },
      vatRate: { type: ['number', 'null'], minimum: 0 },
      roundingMode: { type: 'string', enum: ['END_99', 'TENTH', 'CENT'] },
      syncMode: { type: 'string', enum: ['AUTO', 'CONFIRM', 'MANUAL'] },
      origin: { type: 'string', enum: ['MANUAL', 'COMPETITOR_AUTO', 'COMPETITOR_MANUAL', 'SYSTEM'] },
      isActive: { type: 'boolean' },
    },
  };
}

function pricingSettingsBodySchema() {
  return {
    type: 'object',
    properties: {
      defaultMarginPercent: { type: 'number', minimum: 0 },
      defaultMinProfit: { type: 'number', minimum: 0 },
      defaultVatRate: { type: 'number', minimum: 0 },
      defaultRoundingMode: { type: 'string', enum: ['END_99', 'TENTH', 'CENT'] },
      defaultSyncMode: { type: 'string', enum: ['AUTO', 'CONFIRM', 'MANUAL'] },
      costCeilingEnabledDefault: { type: 'boolean' },
      abnormalProfitThreshold: { type: 'number', minimum: 0 },
      variantGroupingEnabled: { type: 'boolean' },
      competitorAutoPricingEnabled: { type: 'boolean' },
      competitorAutoPricingShopId: { type: ['string', 'null'] },
      competitorAutoPricingIntervalMinutes: { type: 'integer', minimum: 60, maximum: 10080 },
      competitorAutoPricingMinMarkupPercent: { type: 'number', minimum: 0 },
      competitorAutoPricingBelowMarketTolerancePercent: { type: 'number', minimum: 0 },
      competitorAutoPricingAboveMarketTolerancePercent: { type: 'number', minimum: 0 },
    },
  };
}

function priceGroupBodySchema(requireName = true) {
  return {
    type: 'object',
    ...(requireName ? { required: ['name'] } : {}),
    properties: {
      name: { type: 'string' },
      description: { type: ['string', 'null'] },
      priority: { type: 'integer' },
      isActive: { type: 'boolean' },
    },
  };
}

function groupPriceBodySchema() {
  return {
    type: 'object',
    properties: {
      shopId: { type: ['string', 'null'] },
      marginPercent: { type: ['number', 'null'], minimum: 0 },
      minProfit: { type: ['number', 'null'], minimum: 0 },
      fixedNetPrice: { type: ['number', 'null'], minimum: 0 },
      priceMode: { type: 'string', enum: ['MARGIN', 'FIXED'] },
      costCeilingEnabled: { type: ['boolean', 'null'] },
      vatRate: { type: ['number', 'null'], minimum: 0 },
      roundingMode: { type: ['string', 'null'], enum: ['END_99', 'TENTH', 'CENT'] },
      syncMode: { type: ['string', 'null'], enum: ['AUTO', 'CONFIRM', 'MANUAL'] },
    },
  };
}

function clearanceBodySchema(requireScope = true) {
  return {
    type: 'object',
    ...(requireScope ? { required: ['scope', 'clearanceNetPrice'] } : {}),
    properties: {
      scope: { type: 'string', enum: ['PRODUCT', 'GROUP'] },
      warehouseProductId: { type: ['string', 'null'] },
      priceGroupId: { type: ['string', 'null'] },
      shopId: { type: ['string', 'null'] },
      clearanceNetPrice: { type: 'number', minimum: 0 },
      reason: { type: ['string', 'null'] },
      validFrom: { type: ['string', 'null'] },
      validTo: { type: ['string', 'null'] },
      isActive: { type: 'boolean' },
    },
  };
}
