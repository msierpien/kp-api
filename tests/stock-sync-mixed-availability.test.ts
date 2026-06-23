import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { resolvePublicationDecision } from '../src/services/stock/stock-sync.service';

function product(currentStock: number) {
  return {
    id: 'p1',
    tenantId: 't1',
    currentStock: new Prisma.Decimal(currentStock),
    isStockTracked: true,
    leadTimeDaysOverride: null,
    leadTimeGroup: null,
  };
}

function mapping(stock: number | null, leadTimeDays: number | null = 7) {
  return {
    id: 'map-1',
    lastKnownStock: stock === null ? null : new Prisma.Decimal(stock),
    warehouseAvailableAt: null,
    provider: { name: 'Godan', leadTimeDays },
  };
}

test('local stock + wholesale stock publishes combined cap as IN_STOCK_WITH_BACKORDER', () => {
  const decision = resolvePublicationDecision(product(5), { wholesaleWithStock: mapping(50) });

  assert.equal(decision.availabilityPolicy, 'IN_STOCK_WITH_BACKORDER');
  assert.equal(decision.publishedQuantity.toString(), '55');
  assert.equal(decision.inStockQuantity?.toString(), '5');
  assert.equal(decision.outOfStockBehavior, 0);
  assert.equal(decision.leadTimeDays, 7);
  assert.equal(decision.wholesaleProviderName, 'Godan');
});

test('product lead time override wins over wholesale provider lead for the backorder part', () => {
  const decision = resolvePublicationDecision(
    { ...product(5), leadTimeDaysOverride: 3 },
    { wholesaleWithStock: mapping(50, 7) },
  );

  assert.equal(decision.availabilityPolicy, 'IN_STOCK_WITH_BACKORDER');
  assert.equal(decision.leadTimeDays, 3);
  assert.equal(decision.leadTimeSource, 'PRODUCT_OVERRIDE');
});

test('local stock without wholesale stock stays IN_STOCK and capped at local quantity', () => {
  const decision = resolvePublicationDecision(product(5), {});

  assert.equal(decision.availabilityPolicy, 'IN_STOCK');
  assert.equal(decision.publishedQuantity.toString(), '5');
  assert.equal(decision.inStockQuantity, undefined);
  assert.equal(decision.outOfStockBehavior, 0);
  assert.equal(decision.leadTimeDays, 0);
});

test('no local stock with wholesale stock stays pure BACKORDER_FROM_WHOLESALE', () => {
  const decision = resolvePublicationDecision(product(0), { wholesaleWithStock: mapping(20) });

  assert.equal(decision.availabilityPolicy, 'BACKORDER_FROM_WHOLESALE');
  assert.equal(decision.publishedQuantity.toString(), '0');
  assert.equal(decision.inStockQuantity, undefined);
  assert.equal(decision.outOfStockBehavior, 1);
});

test('no stock anywhere is OUT_OF_STOCK', () => {
  const decision = resolvePublicationDecision(product(0), {});

  assert.equal(decision.availabilityPolicy, 'OUT_OF_STOCK');
  assert.equal(decision.outOfStockBehavior, 0);
  assert.equal(decision.leadTimeDays, null);
});
