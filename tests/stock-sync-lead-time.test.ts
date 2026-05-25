import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInventoryPublishedLeadTime } from '../src/services/stock/stock-sync.service';

test('local stock lead time stays zero even when shop has a default lead time', () => {
  const result = resolveInventoryPublishedLeadTime(
    {
      availabilityPolicy: 'IN_STOCK',
      leadTimeDays: 0,
      leadTimeSource: 'LOCAL_STOCK',
    },
    { defaultLeadTimeDays: 1 },
  );

  assert.deepEqual(result, { leadTimeDays: 0, source: 'LOCAL_STOCK' });
});

test('wholesale lead time is published when product is backordered from wholesale', () => {
  const result = resolveInventoryPublishedLeadTime(
    {
      availabilityPolicy: 'BACKORDER_FROM_WHOLESALE',
      leadTimeDays: 3,
      leadTimeSource: 'WHOLESALE_PROVIDER',
    },
    { defaultLeadTimeDays: 1 },
  );

  assert.deepEqual(result, { leadTimeDays: 3, source: 'WHOLESALE_PROVIDER' });
});

test('out of stock product does not publish a lead time', () => {
  const result = resolveInventoryPublishedLeadTime(
    {
      availabilityPolicy: 'OUT_OF_STOCK',
      leadTimeDays: 2,
      leadTimeSource: 'PRODUCT_GROUP',
    },
    { defaultLeadTimeDays: 1 },
  );

  assert.deepEqual(result, { leadTimeDays: null, source: 'NONE' });
});
