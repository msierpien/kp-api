import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES,
  isStockReservationOrderOperationalStatus,
} from '../src/lib/order-statuses';

const ROOT = process.cwd();
const REPLENISHMENT_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/warehouse-replenishment.service.ts'),
  'utf8',
);
const SYNC_SERVICE = readFileSync(
  join(ROOT, 'src/services/sync/sync-orders.service.ts'),
  'utf8',
);
const WEBHOOK_SERVICE = readFileSync(
  join(ROOT, 'src/services/webhooks/prestashop-order-webhook.service.ts'),
  'utf8',
);

test('stock reservation statuses exclude unpaid and inactive orders', () => {
  assert.deepEqual(STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES, ['PAID', 'PROCESSING', 'PACKED']);
  assert.equal(isStockReservationOrderOperationalStatus('PAID'), true);
  assert.equal(isStockReservationOrderOperationalStatus('PROCESSING'), true);
  assert.equal(isStockReservationOrderOperationalStatus('PACKED'), true);
  assert.equal(isStockReservationOrderOperationalStatus('NEW'), false);
  assert.equal(isStockReservationOrderOperationalStatus('CANCELLED'), false);
  assert.equal(isStockReservationOrderOperationalStatus('RETURNED'), false);
});

test('warehouse replenishment only reads backorders from reservable order statuses', () => {
  assert.match(REPLENISHMENT_SERVICE, /order:\s*\{\s*operationalStatus:\s*\{\s*in:\s*STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES\s*\}/);
  assert.match(REPLENISHMENT_SERVICE, /order:\s*\{\s*is:\s*\{\s*operationalStatus:\s*\{\s*in:\s*STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES\s*\}/);
});

test('order sync releases reservations when refreshed status is no longer reservable', () => {
  assert.match(SYNC_SERVICE, /releaseOrderReservations\(existingOrder\.id\)/);
  assert.match(SYNC_SERVICE, /!isStockReservationOrderOperationalStatus\(currentStatus\.operationalStatus\)/);
});

test('PrestaShop webhook releases reservations for any non-reservable status update', () => {
  assert.match(WEBHOOK_SERVICE, /shouldReleaseByConfig\s*\|\|\s*!isStockReservationOrderOperationalStatus\(statusUpdate\.operationalStatus\)/);
  assert.match(WEBHOOK_SERVICE, /releaseOrderReservations\(order\.id\)/);
});
