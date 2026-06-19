import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { __pricingTest, roundPrice } from '../src/services/admin/warehouse-pricing.service';

const shop = { id: 'shop-1', name: 'Kreatywne-party' };

function settings(overrides: Record<string, unknown> = {}) {
  return {
    defaultMarginPercent: 49,
    defaultMinProfit: 1,
    defaultVatRate: 23,
    defaultRoundingMode: 'END_99',
    defaultSyncMode: 'CONFIRM',
    costCeilingEnabledDefault: true,
    abnormalProfitThreshold: 200,
    ...overrides,
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'product-1',
    sku: 'BAL-1',
    name: 'Balon testowy',
    catalogId: 'catalog-1',
    catalog: { id: 'catalog-1', name: 'Balony' },
    purchasePrice: new Prisma.Decimal('4.10'),
    averagePurchaseCost: null,
    barcodes: [],
    shopProductMappings: [],
    ...overrides,
  };
}

function rule(overrides: Record<string, unknown>) {
  return {
    id: `rule-${Math.random()}`,
    level: 'GROUP',
    shopId: null,
    catalogId: null,
    priceGroupId: 'group-1',
    warehouseProductId: null,
    marginPercent: null,
    minProfit: null,
    fixedNetPrice: null,
    priceMode: 'MARGIN',
    costCeilingEnabled: null,
    vatRate: null,
    roundingMode: null,
    syncMode: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    priceGroup: { id: 'group-1', name: 'Grupa testowa', priority: 100 },
    ...overrides,
  };
}

function state(overrides: { rules?: unknown[]; groups?: Array<{ id: string; name: string; priority: number }>; settings?: Record<string, unknown> } = {}) {
  return {
    settings: settings(overrides.settings),
    rules: overrides.rules ?? [],
    clearances: [],
    groupsByProduct: new Map([
      ['product-1', overrides.groups ?? [{ id: 'group-1', name: 'Grupa testowa', priority: 100 }]],
    ]),
  };
}

function clearance(overrides: Record<string, unknown> = {}) {
  return {
    id: 'clearance-1',
    tenantId: 'tenant-1',
    scope: 'PRODUCT',
    warehouseProductId: 'product-1',
    priceGroupId: null,
    shopId: null,
    clearanceNetPrice: new Prisma.Decimal('4.50'),
    reason: 'Wyprzedaz testowa',
    validFrom: null,
    validTo: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-04T00:00:00Z'),
    priceGroup: null,
    warehouseProduct: { id: 'product-1', sku: 'BAL-1', name: 'Balon testowy' },
    shop: null,
    ...overrides,
  };
}

test('END_99 rounding leaves full prices and prices ending with .99 unchanged', () => {
  assert.equal(roundPrice(new Prisma.Decimal('10.00'), 'END_99').toFixed(2), '10.00');
  assert.equal(roundPrice(new Prisma.Decimal('10.99'), 'END_99').toFixed(2), '10.99');
});

test('END_99 rounding raises other prices to the current .99 boundary', () => {
  assert.equal(roundPrice(new Prisma.Decimal('10.20'), 'END_99').toFixed(2), '10.99');
});

test('FIXED group price is not rounded by END_99', () => {
  const item = __pricingTest.calculatePrice(
    product(),
    shop,
    state({
      rules: [rule({ fixedNetPrice: new Prisma.Decimal('7.50'), priceMode: 'FIXED' })],
    }),
  );

  assert.equal(item.priceSource, 'GROUP');
  assert.equal(item.priceMode, 'FIXED');
  assert.equal(item.netPrice, 7.5);
});

test('GROUP rule beats CATALOG rule and group priority breaks ties', () => {
  const item = __pricingTest.calculatePrice(
    product(),
    shop,
    state({
      groups: [
        { id: 'group-low', name: 'Niski priorytet', priority: 10 },
        { id: 'group-high', name: 'Wysoki priorytet', priority: 200 },
      ],
      rules: [
        rule({
          id: 'catalog-rule',
          level: 'CATALOG',
          catalogId: 'catalog-1',
          priceGroupId: null,
          fixedNetPrice: new Prisma.Decimal('5.00'),
          priceMode: 'FIXED',
        }),
        rule({
          id: 'group-low-rule',
          priceGroupId: 'group-low',
          priceGroup: { id: 'group-low', name: 'Niski priorytet', priority: 10 },
          fixedNetPrice: new Prisma.Decimal('6.00'),
          priceMode: 'FIXED',
          updatedAt: new Date('2026-01-03T00:00:00Z'),
        }),
        rule({
          id: 'group-high-rule',
          priceGroupId: 'group-high',
          priceGroup: { id: 'group-high', name: 'Wysoki priorytet', priority: 200 },
          fixedNetPrice: new Prisma.Decimal('8.00'),
          priceMode: 'FIXED',
          updatedAt: new Date('2026-01-02T00:00:00Z'),
        }),
      ],
    }),
  );

  assert.equal(item.priceSource, 'GROUP');
  assert.equal(item.priceGroupId, 'group-high');
  assert.equal(item.netPrice, 8);
});

test('PRODUCT rule exposes overridesGroup when product belongs to a group', () => {
  const item = __pricingTest.calculatePrice(
    product(),
    shop,
    state({
      rules: [
        rule({ fixedNetPrice: new Prisma.Decimal('7.50'), priceMode: 'FIXED' }),
        rule({
          id: 'product-rule',
          level: 'PRODUCT',
          priceGroupId: null,
          warehouseProductId: 'product-1',
          fixedNetPrice: new Prisma.Decimal('9.00'),
          priceMode: 'FIXED',
        }),
      ],
    }),
  );

  assert.equal(item.priceSource, 'PRODUCT');
  assert.equal(item.overridesGroup, true);
  assert.equal(item.netPrice, 9);
});

test('cost ceiling falls back from fixed price to margin and can raise price', () => {
  const item = __pricingTest.calculatePrice(
    product({ averagePurchaseCost: new Prisma.Decimal('8.20') }),
    shop,
    state({
      rules: [
        rule({
          fixedNetPrice: new Prisma.Decimal('7.50'),
          priceMode: 'FIXED',
          marginPercent: new Prisma.Decimal('49'),
          minProfit: new Prisma.Decimal('1'),
          costCeilingEnabled: true,
        }),
      ],
    }),
  );

  assert.equal(item.priceSource, 'CEILING_FALLBACK');
  assert.equal(item.netPrice, 12.99);
});

test('fixed price with cheap purchase cost raises abnormal profit info without changing price', () => {
  const item = __pricingTest.calculatePrice(
    product({ averagePurchaseCost: new Prisma.Decimal('3.10') }),
    shop,
    state({
      rules: [rule({ fixedNetPrice: new Prisma.Decimal('7.50'), priceMode: 'FIXED' })],
    }),
  );

  assert.equal(item.netPrice, 7.5);
  assert.equal(item.infoCode, 'ABNORMAL_PROFIT');
});

test('active clearance wins before rules and keeps exact price below cost', () => {
  const item = __pricingTest.calculatePrice(
    product({ averagePurchaseCost: new Prisma.Decimal('5.00') }),
    shop,
    {
      ...state({
        rules: [rule({ fixedNetPrice: new Prisma.Decimal('7.50'), priceMode: 'FIXED' })],
      }),
      clearances: [clearance()],
    },
  );

  assert.equal(item.priceSource, 'CLEARANCE');
  assert.equal(item.priceMode, 'FIXED');
  assert.equal(item.netPrice, 4.5);
  assert.equal(item.warningCode, 'BELOW_COST');
});

test('sync pricing has explicit below-cost confirmation guard', () => {
  const source = readFileSync(join(process.cwd(), 'src/services/admin/warehouse-pricing.service.ts'), 'utf8');
  const start = source.indexOf('export async function syncPricing');
  const end = source.indexOf('function numericValues', start);
  const body = source.slice(start, end);

  assert.match(body, /warningCode === 'BELOW_COST'/);
  assert.match(body, /allowBelowCostSync/);
  assert.match(body, /Potwierdź synchronizację poniżej kosztu/);
});

test('bulk price update updates existing active product rules instead of blindly creating duplicates', () => {
  const source = readFileSync(join(process.cwd(), 'src/services/admin/warehouse-pricing.service.ts'), 'utf8');
  const start = source.indexOf('export async function bulkUpdateProductPrices');
  const end = source.indexOf('export async function syncPricing', start);
  const body = source.slice(start, end);

  assert.match(body, /warehousePricingRule\.findMany/);
  assert.match(body, /warehousePricingRule\.update\(/);
  assert.match(body, /warehousePricingRule\.updateMany/);
  assert.doesNotMatch(body, /createPricingRule\(/);
});
