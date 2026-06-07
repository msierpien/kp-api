import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeOrderSyncDate,
  resolveOrderSyncFromDate,
} from '../src/services/sync/order-sync-date';

test('normalizes date-only and ISO order sync dates', () => {
  assert.equal(normalizeOrderSyncDate('2026-06-07'), '2026-06-07');
  assert.equal(normalizeOrderSyncDate('2026-06-07T14:20:00.000Z'), '2026-06-07');
  assert.equal(normalizeOrderSyncDate('2026-02-31'), null);
});

test('uses configured order sync fromDate for first sync', () => {
  const fromDate = resolveOrderSyncFromDate({
    config: { orderSync: { fromDate: '2026-05-20' } },
    now: new Date('2026-06-07T10:00:00.000Z'),
  });

  assert.equal(fromDate, '2026-05-20');
});

test('does not allow manual sync earlier than configured fromDate', () => {
  const fromDate = resolveOrderSyncFromDate({
    requestedFromDate: '2026-05-01',
    config: { orderSync: { fromDate: '2026-05-20' } },
    now: new Date('2026-06-07T10:00:00.000Z'),
  });

  assert.equal(fromDate, '2026-05-20');
});

test('allows manual sync later than configured fromDate', () => {
  const fromDate = resolveOrderSyncFromDate({
    requestedFromDate: '2026-06-01',
    config: { orderSync: { fromDate: '2026-05-20' } },
  });

  assert.equal(fromDate, '2026-06-01');
});

test('uses last sync date when it is later than configured fromDate', () => {
  const fromDate = resolveOrderSyncFromDate({
    lastSyncAt: new Date('2026-06-03T12:00:00.000Z'),
    config: { orderSync: { fromDate: '2026-05-20' } },
  });

  assert.equal(fromDate, '2026-06-03');
});

test('falls back to seven days when no sync date is available', () => {
  const fromDate = resolveOrderSyncFromDate({
    now: new Date('2026-06-07T10:00:00.000Z'),
  });

  assert.equal(fromDate, '2026-05-31');
});

test('explicit null fromDate ignores legacy configured aliases', () => {
  const fromDate = resolveOrderSyncFromDate({
    config: { orderSync: { fromDate: null, dateFrom: '2026-05-20' } },
    now: new Date('2026-06-07T10:00:00.000Z'),
  });

  assert.equal(fromDate, '2026-05-31');
});

test('rejects invalid manual fromDate', () => {
  assert.throws(
    () => resolveOrderSyncFromDate({ requestedFromDate: '07.06.2026' }),
    /YYYY-MM-DD/,
  );
});
