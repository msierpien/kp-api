import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const SCHEMA = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
const MIGRATION = readFileSync(
  join(ROOT, 'prisma/migrations/20260617120000_add_product_replenishment_settings/migration.sql'),
  'utf8',
);
const PRODUCTS_ROUTES = readFileSync(join(ROOT, 'src/routes/admin/warehouse/products.routes.ts'), 'utf8');
const PRODUCTS_SERVICE = readFileSync(join(ROOT, 'src/services/admin/warehouse-products.service.ts'), 'utf8');
const REPLENISHMENT_SERVICE = readFileSync(join(ROOT, 'src/services/admin/warehouse-replenishment.service.ts'), 'utf8');

describe('warehouse product replenishment settings', () => {
  it('schema i migracja dodają próg oraz partię zamawiania', () => {
    assert.match(SCHEMA, /reorderPoint\s+Decimal\?\s+@map\("reorder_point"\)/);
    assert.match(SCHEMA, /reorderQuantity\s+Decimal\?\s+@map\("reorder_quantity"\)/);
    assert.match(MIGRATION, /ADD COLUMN "reorder_point" DECIMAL\(10, 3\)/);
    assert.match(MIGRATION, /ADD COLUMN "reorder_quantity" DECIMAL\(10, 3\)/);
    assert.match(MIGRATION, /warehouse_products_reorder_point_check/);
    assert.match(MIGRATION, /warehouse_products_reorder_quantity_check/);
  });

  it('API produktu pozwala zapisać ustawienia pojedynczo i masowo', () => {
    assert.match(PRODUCTS_ROUTES, /reorderPoint: \{ type: \['number', 'null'\], minimum: 0 \}/);
    assert.match(PRODUCTS_ROUTES, /reorderQuantity: \{ type: \['number', 'null'\], exclusiveMinimum: 0 \}/);
    assert.match(PRODUCTS_SERVICE, /reorderPoint\?: number \| null/);
    assert.match(PRODUCTS_SERVICE, /reorderQuantity\?: number \| null/);
    assert.match(PRODUCTS_SERVICE, /normalizeOptionalQuantity\(input\.reorderPoint, 'Minimalny stan'\)/);
    assert.match(PRODUCTS_SERVICE, /normalizeOptionalPositiveQuantity\(input\.reorderQuantity, 'Partia zamawiania'\)/);
  });

  it('niski stan używa progu produktu i zaokrągla ilość do partii albo wielopaku', () => {
    assert.match(REPLENISHMENT_SERVICE, /COALESCE\("reorder_point", \$\{effectiveDefaultThreshold\}\)/);
    assert.match(REPLENISHMENT_SERVICE, /"reorder_quantity" AS "reorderQuantity"/);
    assert.match(REPLENISHMENT_SERVICE, /quantityMultiplier: \{ gt: 1 \}/);
    assert.match(REPLENISHMENT_SERVICE, /roundUpToMultiple\(shortage, orderMultiple\.quantity\)/);
    assert.match(REPLENISHMENT_SERVICE, /orderMultipleSource\?: 'PRODUCT' \| 'BARCODE' \| 'NONE'/);
  });
});
