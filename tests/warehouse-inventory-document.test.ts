import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const SCHEMA = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
const MIGRATION = readFileSync(
  join(ROOT, 'prisma/migrations/20260525100000_add_inventory_document/migration.sql'),
  'utf8',
);
const DOCS_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/warehouse-documents.service.ts'),
  'utf8',
);
const PRODUCTS_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/warehouse-products.service.ts'),
  'utf8',
);
const DOCS_ROUTES = readFileSync(
  join(ROOT, 'src/routes/admin/warehouse/documents.routes.ts'),
  'utf8',
);
const PRODUCTS_ROUTES = readFileSync(
  join(ROOT, 'src/routes/admin/warehouse/products.routes.ts'),
  'utf8',
);

describe('warehouse inventory document (INW): schema i migracja', () => {
  it('enum WarehouseDocumentType zawiera INW', () => {
    const enumBlock = SCHEMA.match(/enum WarehouseDocumentType \{[\s\S]*?\}/)?.[0] ?? '';
    assert.match(enumBlock, /\bINW\b/);
  });

  it('WarehouseDocumentItem ma pole systemQuantity (Decimal nullable)', () => {
    const modelBlock = SCHEMA.match(/model WarehouseDocumentItem \{[\s\S]*?\}/)?.[0] ?? '';
    assert.match(modelBlock, /systemQuantity\s+Decimal\?\s+@map\("system_quantity"\)/);
  });

  it('migracja dodaje wartość INW do enum i kolumnę system_quantity', () => {
    assert.match(MIGRATION, /ALTER TYPE "WarehouseDocumentType" ADD VALUE 'INW'/);
    assert.match(MIGRATION, /ADD COLUMN "system_quantity" DECIMAL\(10, 3\)/);
  });

  it('migracja tworzy częściowy unique index pilnujący unique productId per dokument INW', () => {
    assert.match(MIGRATION, /CREATE UNIQUE INDEX "warehouse_document_items_inw_product_uidx"/);
    assert.match(MIGRATION, /WHERE "system_quantity" IS NOT NULL/);
  });
});

describe('warehouse inventory document (INW): logika serwisu', () => {
  it('DocumentType zawiera INW', () => {
    assert.match(DOCS_SERVICE, /export type DocumentType = 'PZ' \| 'PW' \| 'WZ' \| 'RW' \| 'INW'/);
  });

  it('prepareDocumentItems waliduje unique productId dla INW', () => {
    assert.match(DOCS_SERVICE, /W dokumencie INW każdy produkt może wystąpić tylko raz/);
  });

  it('prepareDocumentItems robi snapshot currentStock gdy systemQuantity nie podano', () => {
    assert.match(DOCS_SERVICE, /isInventory[\s\S]{0,400}currentStock/);
  });

  it('applyStockDeltas dla INW liczy delta = counted - system', () => {
    assert.match(
      DOCS_SERVICE,
      /type === 'INW'[\s\S]{0,400}counted\.minus\(system\)/,
    );
  });

  it('cofnięcie INW odwraca korektę (reverse: system - counted)', () => {
    assert.match(
      DOCS_SERVICE,
      /type === 'INW'[\s\S]{0,400}reverse \? system\.minus\(counted\) : counted\.minus\(system\)/,
    );
  });

  it('calculateProductStock uwzględnia INW jako wkład delta', () => {
    assert.match(
      DOCS_SERVICE,
      /item\.document\.type === 'INW'[\s\S]{0,200}quantity - systemQuantity/,
    );
  });

  it('assertCanConfirmWithoutNegativeStock blokuje ujemny stan policzony w INW', () => {
    assert.match(
      DOCS_SERVICE,
      /type === 'INW'[\s\S]{0,200}Stan policzony produktu[\s\S]{0,80}nie może być ujemny/,
    );
  });
});

describe('warehouse inventory document (INW): routes i snapshot', () => {
  it('enum body dla POST /documents akceptuje INW', () => {
    assert.match(DOCS_ROUTES, /enum: \['PZ', 'PW', 'WZ', 'RW', 'INW'\]/);
  });

  it('POST /documents items akceptują systemQuantity', () => {
    assert.match(DOCS_ROUTES, /systemQuantity:\s*\{\s*type:\s*\['number', 'null'\]/);
  });

  it('PATCH /documents/:id/items/:itemId akceptuje systemQuantity', () => {
    const patchBlock = DOCS_ROUTES.match(/patch\('\/documents\/:id\/items\/:itemId'[\s\S]*?async/)?.[0] ?? '';
    assert.match(patchBlock, /systemQuantity:\s*\{\s*type:\s*\['number', 'null'\]/);
  });

  it('serwis warehouse-products eksportuje getInventorySnapshot', () => {
    assert.match(PRODUCTS_SERVICE, /export async function getInventorySnapshot\(/);
  });

  it('snapshot zwraca currentStock, totalReserved, availableStock i aktywne rezerwacje', () => {
    assert.match(PRODUCTS_SERVICE, /currentStock: Number\(currentStock\)/);
    assert.match(PRODUCTS_SERVICE, /totalReserved: Number\(totalReserved\)/);
    assert.match(PRODUCTS_SERVICE, /availableStock: Number\(availableStock\)/);
    assert.match(PRODUCTS_SERVICE, /activeReservations: activeReservations\.map/);
  });

  it('GET /products/:id/inventory-snapshot jest zarejestrowany', () => {
    assert.match(PRODUCTS_ROUTES, /fastify\.get\('\/products\/:id\/inventory-snapshot'/);
  });
});
