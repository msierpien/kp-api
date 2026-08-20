import './helpers/test-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  isFinalShipmentStage,
  shipmentServiceLabel,
  shipmentStageFromStatus,
  shipmentStageLabel,
  shipmentTrackingUrl,
} from '../src/lib/inpost-statuses';

const ROOT = process.cwd();
// Serwis ciagnie prisme i connectora, wiec czytamy go jako zrodlo — test ma
// pilnowac kontraktu z modulem sklepu, nie startowac aplikacji.
const SHIPMENTS_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/order-shipments.service.ts'),
  'utf8',
);
const SCHEDULER = readFileSync(
  join(ROOT, 'src/services/scheduler/scheduler.service.ts'),
  'utf8',
);
const ORDERS_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/orders.service.ts'),
  'utf8',
);

test('statusy przewoznika mapuja sie na etapy doreczenia', () => {
  assert.equal(shipmentStageFromStatus('confirmed'), 'CREATED');
  assert.equal(shipmentStageFromStatus('adopted_at_sorting_center'), 'IN_TRANSIT');
  assert.equal(shipmentStageFromStatus('out_for_delivery'), 'OUT_FOR_DELIVERY');
  assert.equal(shipmentStageFromStatus('out_for_delivery_to_address'), 'OUT_FOR_DELIVERY');
  assert.equal(shipmentStageFromStatus('ready_to_pickup'), 'READY_TO_PICKUP');
  assert.equal(shipmentStageFromStatus('pickup_reminder_sent'), 'PICKUP_REMINDER');
  assert.equal(shipmentStageFromStatus('pickup_time_expired'), 'PROBLEM');
  assert.equal(shipmentStageFromStatus('delivered'), 'DELIVERED');
  assert.equal(shipmentStageFromStatus('returned_to_sender'), 'RETURNED');
  assert.equal(shipmentStageFromStatus('canceled'), 'CANCELLED');
});

test('status w innym zapisie i puste wartosci nie wywracaja mapowania', () => {
  assert.equal(shipmentStageFromStatus('  READY_TO_PICKUP '), 'READY_TO_PICKUP');
  assert.equal(shipmentStageFromStatus(''), 'UNKNOWN');
  assert.equal(shipmentStageFromStatus(null), 'UNKNOWN');
  assert.equal(shipmentStageFromStatus(undefined), 'UNKNOWN');
});

test('nieznany status trafia do etapu, ktory nadal jest odpytywany', () => {
  // InPost dokłada statusy; nieznany nie moze zamknac przesylki jako koncowej,
  // bo synchronizacja przestalaby o nia pytac i paczka utknelaby w panelu.
  const stage = shipmentStageFromStatus('some_new_inpost_status');
  assert.equal(stage, 'IN_TRANSIT');
  assert.equal(isFinalShipmentStage(stage), false);

  assert.equal(shipmentStageFromStatus('ready_to_pickup_from_new_point'), 'READY_TO_PICKUP');
  assert.equal(shipmentStageFromStatus('undelivered_something'), 'PROBLEM');
});

test('etapy koncowe zamykaja odpytywanie, reszta nie', () => {
  assert.equal(isFinalShipmentStage('DELIVERED'), true);
  assert.equal(isFinalShipmentStage('RETURNED'), true);
  assert.equal(isFinalShipmentStage('CANCELLED'), true);

  assert.equal(isFinalShipmentStage('READY_TO_PICKUP'), false);
  assert.equal(isFinalShipmentStage('PICKUP_REMINDER'), false);
  assert.equal(isFinalShipmentStage('PROBLEM'), false);
  assert.equal(isFinalShipmentStage('UNKNOWN'), false);
});

test('etykiety dla panelu sa po polsku, a numer listu daje link do sledzenia', () => {
  assert.equal(shipmentStageLabel('READY_TO_PICKUP'), 'Czeka w paczkomacie');
  assert.equal(shipmentStageLabel('OUT_FOR_DELIVERY'), 'Doręczenie dziś');
  assert.equal(shipmentStageLabel('COS_NIEZNANEGO'), 'Bez statusu');

  assert.equal(shipmentServiceLabel('inpost_locker_standard'), 'Paczkomat');
  assert.equal(shipmentServiceLabel(''), null);

  assert.match(shipmentTrackingUrl('6202') ?? '', /number=6202$/);
  assert.equal(shipmentTrackingUrl(' '), null);
});

test('synchronizacja pyta connectora hurtowo i miesci sie w limicie modulu', () => {
  assert.match(SHIPMENTS_SERVICE, /'inpostshipmentsbatch'/);
  // Modul sklepu odrzuca wieksze paczki (BATCH_ORDER_LIMIT = 25).
  assert.match(SHIPMENTS_SERVICE, /SYNC_ORDER_BATCH_SIZE = 25/);
  assert.match(SHIPMENTS_SERVICE, /idOrders, refresh: true/);
});

test('synchronizacja pyta o przesylki w drodze i o swieze zamowienia bez przesylki', () => {
  assert.match(SHIPMENTS_SERVICE, /shipments: \{ some: \{ isFinal: false \} \}/);
  assert.match(SHIPMENTS_SERVICE, /shipments: \{ none: \{\} \}/);
});

test('blad jednej paczki nie zabiera pozostalych zamowien', () => {
  const batchLoop = SHIPMENTS_SERVICE.slice(
    SHIPMENTS_SERVICE.indexOf('for (let index = 0; index < orders.length'),
    SHIPMENTS_SERVICE.indexOf('/** Synchronizacja dla wszystkich'),
  );
  assert.match(batchLoop, /catch \(error\)/);
  assert.match(batchLoop, /result\.errors\.push/);
});

test('scheduler odswieza statusy cyklicznie', () => {
  assert.match(SCHEDULER, /syncShipmentsForAllShops/);
  assert.match(SCHEDULER, /'\*\/20 \* \* \* \*'/);
});

test('lista zamowien zwraca ostatnia przesylke razem z etapem', () => {
  assert.match(ORDERS_SERVICE, /shipments: \{\s*orderBy: \{ createdAt: 'desc' \},\s*take: 1,/);
  assert.match(ORDERS_SERVICE, /stageLabel: shipmentStageLabel\(shipment\.stage\)/);
  assert.match(ORDERS_SERVICE, /where\.shipments = \{ none: \{\} \}/);
});
