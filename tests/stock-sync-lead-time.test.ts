import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getProductActivationMode,
  resolveInventoryPublishedLeadTime,
  resolvePublishedWarehouseAvailableAt,
  resolvePublishedProductActive,
} from '../src/services/stock/stock-sync.service';

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

test('backorder warehouse availability date includes wholesale lead time', () => {
  const result = resolvePublishedWarehouseAvailableAt(
    {
      availabilityPolicy: 'BACKORDER_FROM_WHOLESALE',
      warehouseAvailableAt: new Date(Date.UTC(2026, 5, 30)),
    },
    3,
  );

  assert.equal(result?.toISOString().slice(0, 10), '2026-07-03');
});

test('backorder warehouse availability date skips weekends when lead time crosses them', () => {
  const result = resolvePublishedWarehouseAvailableAt(
    {
      availabilityPolicy: 'BACKORDER_FROM_WHOLESALE',
      warehouseAvailableAt: new Date(Date.UTC(2026, 9, 28)),
    },
    3,
  );

  assert.equal(result?.toISOString().slice(0, 10), '2026-11-02');
});

test('non-backorder warehouse availability date is not shifted by lead time', () => {
  const result = resolvePublishedWarehouseAvailableAt(
    {
      availabilityPolicy: 'IN_STOCK',
      warehouseAvailableAt: new Date(Date.UTC(2026, 5, 30)),
    },
    3,
  );

  assert.equal(result?.toISOString().slice(0, 10), '2026-06-30');
});

test('product activation sync follows availability only when enabled for shop', () => {
  assert.equal(getProductActivationMode({ productActivationMode: 'SYNC_WITH_AVAILABILITY' }), 'SYNC_WITH_AVAILABILITY');
  assert.equal(resolvePublishedProductActive({ availabilityPolicy: 'IN_STOCK' }, { productActivationMode: 'UNCHANGED' }), undefined);
  assert.equal(resolvePublishedProductActive({ availabilityPolicy: 'BACKORDER_FROM_WHOLESALE' }, { productActivationMode: 'SYNC_WITH_AVAILABILITY' }), true);
  assert.equal(resolvePublishedProductActive({ availabilityPolicy: 'OUT_OF_STOCK' }, { productActivationMode: 'SYNC_WITH_AVAILABILITY' }), false);
});
