import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const SCHEMA = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
const MIGRATION = readFileSync(
  join(ROOT, 'prisma/migrations/20260613153000_add_product_card_content_models/migration.sql'),
  'utf8',
);
const ROUTES = readFileSync(join(ROOT, 'src/routes/admin/warehouse/products.routes.ts'), 'utf8');
const SERVICE = readFileSync(join(ROOT, 'src/services/admin/product-card.service.ts'), 'utf8');
const ADAPTER = readFileSync(join(ROOT, 'src/services/shops/prestashop-product-content-adapter.ts'), 'utf8');

describe('product card content contract', () => {
  it('persists tenant-scoped snapshots, sync config and operation logs', () => {
    for (const model of ['ProductChannelSnapshot', 'ProductChannelSyncConfig', 'ProductCardOperationLog']) {
      const modelBlock = SCHEMA.match(new RegExp(`model ${model} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? '';
      assert.match(modelBlock, /\btenantId\s+String\b/);
      assert.match(modelBlock, /tenant\s+Tenant\s+@relation/);
    }

    assert.match(MIGRATION, /CREATE TABLE "product_channel_snapshots"/);
    assert.match(MIGRATION, /CREATE TABLE "product_channel_sync_configs"/);
    assert.match(MIGRATION, /CREATE TABLE "product_card_operation_logs"/);
    assert.match(MIGRATION, /product_channel_snapshots_warehouse_product_id_shop_id_key/);
    assert.match(MIGRATION, /product_channel_sync_configs_warehouse_product_id_shop_id_key/);
  });

  it('registers the card snapshot, section mutation, media and sync endpoints', () => {
    for (const route of [
      "fastify.get('/products/:id/card'",
      "fastify.post('/products/:id/card/refresh'",
      "fastify.patch('/products/:id/card/content'",
      "fastify.patch('/products/:id/card/parameters'",
      "fastify.post('/products/:id/card/media'",
      "fastify.patch('/products/:id/card/media'",
      "fastify.put('/products/:id/card/media/order'",
      "fastify.delete('/products/:id/card/media'",
      "fastify.patch('/products/:id/card/channel-config'",
      "fastify.post('/products/:id/card/sync'",
    ]) {
      assert.ok(ROUTES.includes(route), `missing route ${route}`);
    }
  });

  it('keeps product content writes behind expectedHash and operation logs', () => {
    assert.match(SERVICE, /expectedHash\?: string/);
    assert.match(SERVICE, /adapter\.patch\(mapping\.externalProductId, payload\)/);
    assert.match(SERVICE, /ProductContentConflictError/);
    assert.match(SERVICE, /productCardOperationLog\.create/);
  });

  it('uses kp_adminconnector over HTTP and does not connect to the PrestaShop database', () => {
    assert.match(ADAPTER, /adminConnectorUrl/);
    assert.match(ADAPTER, /'X-Api-Key': this\.apiKey/);
    assert.doesNotMatch(ADAPTER, /module=kp_productcontent/);
    assert.doesNotMatch(ADAPTER, /mysql|postgres|DATABASE_URL|createConnection|PrismaClient/i);
  });
});
