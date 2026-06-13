import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { roundPrice } from '../src/services/admin/warehouse-pricing.service';

test('END_99 rounding leaves full prices and prices ending with .99 unchanged', () => {
  assert.equal(roundPrice(new Prisma.Decimal('10.00'), 'END_99').toFixed(2), '10.00');
  assert.equal(roundPrice(new Prisma.Decimal('10.99'), 'END_99').toFixed(2), '10.99');
});

test('END_99 rounding raises other prices to the current .99 boundary', () => {
  assert.equal(roundPrice(new Prisma.Decimal('10.20'), 'END_99').toFixed(2), '10.99');
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
