import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProviderConfig, resolveWholesaleAvailabilityRule } from '../src/services/admin/wholesale/shared';

test('PartyDeco preset maps future delivery date and enables future delivery availability rule', () => {
  const config = parseProviderConfig({
    preset: 'PARTYDECO',
    delimiter: ';',
    fieldMapping: {
      sku: 'code',
      name: 'name',
      stock: 'stock',
    },
  });

  assert.equal(config.fieldMapping.warehouseAvailableAt, 'availability_date');
  assert.equal(config.availabilityRule, 'STOCK_OR_FUTURE_DELIVERY');
});

test('custom providers keep stock-only availability by default', () => {
  assert.equal(resolveWholesaleAvailabilityRule({
    preset: 'CUSTOM',
    fieldMapping: { sku: 'sku', name: 'name' },
  }), 'STOCK_ONLY');
});
