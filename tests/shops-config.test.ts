import assert from 'node:assert/strict';
import test from 'node:test';
import { preserveManagedShopConfig } from '../src/services/admin/shops.service';
import {
  normalizeBulkStockUrl,
  normalizeOptionalBulkStockBatchSize,
} from '../src/modules/shops/shops.use-cases';

test('shop update preserves bulk stock config when generic config form does not submit it', () => {
  const config = preserveManagedShopConfig(
    { orderSync: { enabled: true, intervalMinutes: 10 } },
    {
      bulkStockUrl: 'https://shop.test/index.php?fc=module&module=kp_bulkstock&controller=bulkupdate',
      bulkStockApiKey: 'encrypted-secret',
      defaultLeadTimeDays: 2,
      bulkStockBatchSize: 200,
      orderSync: { enabled: false, intervalMinutes: 30 },
    },
  );

  assert.equal(config.bulkStockUrl, 'https://shop.test/index.php?fc=module&module=kp_bulkstock&controller=bulkupdate');
  assert.equal(config.bulkStockApiKey, 'encrypted-secret');
  assert.equal(config.defaultLeadTimeDays, 2);
  assert.equal(config.bulkStockBatchSize, 200);
  assert.deepEqual(config.orderSync, { enabled: true, intervalMinutes: 10 });
});

test('shop update allows explicit bulk stock config changes', () => {
  const config = preserveManagedShopConfig(
    { bulkStockUrl: null, bulkStockApiKey: null, defaultLeadTimeDays: null },
    {
      bulkStockUrl: 'https://shop.test/index.php?fc=module&module=kp_bulkstock&controller=bulkupdate',
      bulkStockApiKey: 'encrypted-secret',
      defaultLeadTimeDays: 2,
    },
  );

  assert.equal(config.bulkStockUrl, null);
  assert.equal(config.bulkStockApiKey, null);
  assert.equal(config.defaultLeadTimeDays, null);
});

test('bulk stock config rejects non-url endpoint values before saving', () => {
  assert.throws(
    () => normalizeBulkStockUrl('sierpien.michal@gmail.com'),
    /URL endpointu kp_bulkstock/,
  );
});

test('bulk stock config validates request batch size', () => {
  assert.equal(normalizeOptionalBulkStockBatchSize(100), 100);
  assert.equal(normalizeOptionalBulkStockBatchSize('500'), 500);
  assert.equal(normalizeOptionalBulkStockBatchSize(null), null);
  assert.throws(
    () => normalizeOptionalBulkStockBatchSize(501),
    /Rozmiar paczki bulk stock/,
  );
});
