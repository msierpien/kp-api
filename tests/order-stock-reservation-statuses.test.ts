import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES,
  isStockReservationOrderOperationalStatus,
} from '../src/lib/order-statuses';
import { resolveWarehouseActionForStatus } from '../src/services/orders/order-status-warehouse-effects.service';

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

test('order sync applies shared warehouse effects on refreshed status', () => {
  assert.match(SYNC_SERVICE, /applyOrderStatusWarehouseEffects\(existingOrder\.id,\s*currentStatus\.operationalStatus\)/);
});

test('PrestaShop webhook applies shared warehouse effects on status update', () => {
  assert.match(WEBHOOK_SERVICE, /applyOrderStatusWarehouseEffects\(order\.id,\s*statusUpdate\.operationalStatus/);
});

test('status warehouse action decision table', () => {
  // Wysylka domyka WZ zamiast zwalniac rezerwacje.
  assert.equal(resolveWarehouseActionForStatus('SHIPPED'), 'FINALIZE_SHIPMENT');
  assert.equal(resolveWarehouseActionForStatus('DELIVERED'), 'FINALIZE_SHIPMENT');
  // Statusy rezerwacyjne.
  assert.equal(resolveWarehouseActionForStatus('PAID'), 'RESERVE');
  assert.equal(resolveWarehouseActionForStatus('PROCESSING'), 'RESERVE');
  assert.equal(resolveWarehouseActionForStatus('PACKED'), 'RESERVE');
  // Zwolnienie tylko dla jawnych statusow zamykajacych.
  assert.equal(resolveWarehouseActionForStatus('CANCELLED'), 'RELEASE');
  assert.equal(resolveWarehouseActionForStatus('RETURNED'), 'RELEASE');
  assert.equal(resolveWarehouseActionForStatus('PARTIALLY_RETURNED'), 'RELEASE');
  // NEW i status niezmapowany (fallback) NIE moga zwalniac rezerwacji.
  assert.equal(resolveWarehouseActionForStatus('NEW'), 'NONE');
  assert.equal(resolveWarehouseActionForStatus('COMPLETELY_UNKNOWN'), 'NONE');
  assert.equal(resolveWarehouseActionForStatus(null), 'NONE');
  // Jawna konfiguracja releaseStatusIds wymusza zwolnienie.
  assert.equal(resolveWarehouseActionForStatus('NEW', { forceRelease: true }), 'RELEASE');
  // ...ale nie przebija wysylki.
  assert.equal(resolveWarehouseActionForStatus('SHIPPED', { forceRelease: true }), 'FINALIZE_SHIPMENT');
});
