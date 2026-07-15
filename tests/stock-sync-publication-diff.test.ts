import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { isSamePublishedInventoryState, type PublishedInventoryState } from '../src/services/stock/stock-sync.service';

function state(overrides: Partial<PublishedInventoryState> = {}): PublishedInventoryState {
  return {
    publishedQuantity: new Prisma.Decimal(10),
    inStockQuantity: new Prisma.Decimal(3),
    publishedLeadTimeDays: 4,
    publishedWarehouseAvailableAt: new Date('2026-07-16T00:00:00.000Z'),
    availabilityPolicy: 'IN_STOCK_WITH_BACKORDER',
    outOfStockBehavior: 0,
    publishedProductActive: true,
    ...overrides,
  };
}

test('does not republish an identical inventory decision', () => {
  assert.equal(isSamePublishedInventoryState(state(), state()), true);
});

test('republishes when wholesale stock changes the combined published quantity', () => {
  assert.equal(
    isSamePublishedInventoryState(state(), state({ publishedQuantity: new Prisma.Decimal(11) })),
    false,
  );
});

test('republishes when the selling policy, ETA, or activation changes', () => {
  assert.equal(
    isSamePublishedInventoryState(state(), state({ availabilityPolicy: 'BACKORDER_FROM_WHOLESALE' })),
    false,
  );
  assert.equal(
    isSamePublishedInventoryState(state(), state({ publishedWarehouseAvailableAt: new Date('2026-07-17T00:00:00.000Z') })),
    false,
  );
  assert.equal(
    isSamePublishedInventoryState(state(), state({ publishedProductActive: false })),
    false,
  );
});

test('treats a missing previous publication as requiring publication', () => {
  assert.equal(isSamePublishedInventoryState(undefined, state()), false);
});
