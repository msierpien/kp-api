import { readFileSync } from 'fs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SERVICE = readFileSync('src/services/admin/shop-order-statuses.service.ts', 'utf8');
const REPOSITORY = readFileSync('src/services/shop-order-statuses.repository.ts', 'utf8');

describe('shop order status mapping persistence', () => {
  it('saves manual operational mappings without Prisma model-field updates', () => {
    assert.doesNotMatch(SERVICE, /shopOrderStatus\.updateMany/);
    assert.match(REPOSITORY, /UPDATE shop_order_statuses/);
    assert.match(REPOSITORY, /operational_status/);
  });

  it('does not overwrite manual operational mappings during status sync', () => {
    assert.match(REPOSITORY, /ON CONFLICT \(shop_id, external_status_id\)/);
    assert.doesNotMatch(REPOSITORY, /operational_status = EXCLUDED\.operational_status/);
  });
});
