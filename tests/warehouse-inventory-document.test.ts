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
const STOCK_TRACKING_MIGRATION = readFileSync(
  join(ROOT, 'prisma/migrations/20260621133000_add_warehouse_product_stock_tracking/migration.sql'),
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
const STOCK_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/warehouse-stock.service.ts'),
  'utf8',
);
const DIAGNOSTICS_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/warehouse-diagnostics.service.ts'),
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

  it('WarehouseProduct ma osobną flagę śledzenia magazynowego', () => {
    const modelBlock = SCHEMA.match(/model WarehouseProduct \{[\s\S]*?\}/)?.[0] ?? '';
    assert.match(modelBlock, /isStockTracked\s+Boolean\s+@default\(true\)\s+@map\("is_stock_tracked"\)/);
    assert.match(modelBlock, /@@index\(\[tenantId, isActive, isStockTracked\]\)/);
  });

  it('migracja dodaje wartość INW do enum i kolumnę system_quantity', () => {
    assert.match(MIGRATION, /ALTER TYPE "WarehouseDocumentType" ADD VALUE 'INW'/);
    assert.match(MIGRATION, /ADD COLUMN "system_quantity" DECIMAL\(10, 3\)/);
  });

  it('migracja tworzy częściowy unique index pilnujący unique productId per dokument INW', () => {
    assert.match(MIGRATION, /CREATE UNIQUE INDEX "warehouse_document_items_inw_product_uidx"/);
    assert.match(MIGRATION, /WHERE "system_quantity" IS NOT NULL/);
  });

  it('migracja śledzenia magazynu dodaje is_stock_tracked z domyślnym true', () => {
    assert.match(STOCK_TRACKING_MIGRATION, /ADD COLUMN "is_stock_tracked" BOOLEAN NOT NULL DEFAULT true/);
    assert.match(STOCK_TRACKING_MIGRATION, /warehouse_products_tenant_active_stock_tracked_idx/);
  });
});

describe('warehouse inventory document (INW): logika serwisu', () => {
  it('DocumentType zawiera INW i ZW', () => {
    assert.match(DOCS_SERVICE, /export type DocumentType = 'PZ' \| 'ZH' \| 'PW' \| 'WZ' \| 'ZW' \| 'RW' \| 'INW'/);
    assert.match(DOCS_SERVICE, /STOCK_INCOMING_TYPES: DocumentType\[\] = \['PZ', 'PW', 'ZW'\]/);
  });

  it('prepareDocumentItems waliduje unique productId dla INW', () => {
    assert.match(DOCS_SERVICE, /W dokumencie INW każdy produkt może wystąpić tylko raz/);
  });

  it('prepareDocumentItems robi fizyczny snapshot currentStock + aktywne lokalne rezerwacje gdy systemQuantity nie podano', () => {
    assert.match(DOCS_SERVICE, /warehouseReservation\.groupBy\(/);
    assert.match(DOCS_SERVICE, /status:\s*'ACTIVE'/);
    assert.match(DOCS_SERVICE, /source:\s*'LOCAL_STOCK'/);
    assert.match(DOCS_SERVICE, /availableStock\.plus\(reservedQuantity\)/);
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

  it('pełna INW blokuje zatwierdzenie, jeśli brakuje aktywnych produktów', () => {
    assert.match(DOCS_SERVICE, /FULL_INVENTORY_SCOPE = 'ALL_ACTIVE_PRODUCTS'/);
    assert.match(DOCS_SERVICE, /assertFullInventoryComplete\(doc\.tenantId,\s*doc\.type,\s*doc\.metadataJson,\s*doc\.items\)/);
    assert.match(DOCS_SERVICE, /isActive: true, isStockTracked: true/);
    assert.match(DOCS_SERVICE, /Pełna inwentaryzacja wymaga policzenia wszystkich aktywnych produktów śledzonych w magazynie/);
  });

  it('WZ z reservationId nie odejmuje stanu drugi raz, a anulowanie zwalnia rezerwacje', () => {
    assert.match(DOCS_SERVICE, /if \(type === 'WZ' && item\.reservationId\) continue/);
    assert.match(DOCS_SERVICE, /consumeDocumentReservations\(tx,\s*doc\.items\)/);
    assert.match(DOCS_SERVICE, /releaseDocumentReservations\(tx,\s*doc\.items\)/);
  });

  it('recalculateStockCache uwzględnia ZW, INW i tylko lokalne aktywne rezerwacje', () => {
    assert.match(STOCK_SERVICE, /const INCOMING_TYPES = \['PZ', 'PW', 'ZW'\]/);
    assert.match(STOCK_SERVICE, /type === 'INW'[\s\S]{0,160}qty - Number\(item\.systemQuantity \?\? 0\)/);
    assert.match(STOCK_SERVICE, /where: \{ status: 'ACTIVE', source: 'LOCAL_STOCK' \}/);
  });

  it('diagnostyka rozbieżności liczy ZW i INW tak samo jak cache stanów', () => {
    assert.match(DIAGNOSTICS_SERVICE, /type DocumentType = 'PZ' \| 'ZH' \| 'PW' \| 'WZ' \| 'ZW' \| 'RW' \| 'INW'/);
    assert.match(DIAGNOSTICS_SERVICE, /\['PZ', 'PW', 'ZW'\]\.includes\(type\)/);
    assert.match(DIAGNOSTICS_SERVICE, /item\.document\.type === 'INW'[\s\S]{0,120}Number\(item\.quantity\) - Number\(item\.systemQuantity \?\? 0\)/);
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
    assert.match(DOCS_ROUTES, /enum: \['PZ', 'ZH', 'PW', 'WZ', 'ZW', 'RW', 'INW'\]/);
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

  it('snapshot produktu zwraca currentStock, physicalStock, totalReserved, availableStock i aktywne rezerwacje', () => {
    assert.match(PRODUCTS_SERVICE, /currentStock: Number\(currentStock\)/);
    assert.match(PRODUCTS_SERVICE, /physicalStock: Number\(physicalStock\)/);
    assert.match(PRODUCTS_SERVICE, /totalReserved: Number\(totalReserved\)/);
    assert.match(PRODUCTS_SERVICE, /availableStock: Number\(availableStock\)/);
    assert.match(PRODUCTS_SERVICE, /activeReservations: activeReservations\.map/);
  });

  it('bulk snapshot pełnej inwentaryzacji jest dostępny przez GET /inventory/snapshot', () => {
    assert.match(PRODUCTS_SERVICE, /export async function getInventorySnapshotList\(/);
    assert.match(PRODUCTS_SERVICE, /normalizePositiveInteger\(query\.page, 1\)/);
    assert.match(PRODUCTS_SERVICE, /isStockTracked: true/);
    assert.match(PRODUCTS_SERVICE, /totalPages: Math\.max\(1, Math\.ceil\(total \/ limit\)\)/);
    assert.match(PRODUCTS_SERVICE, /activeReservationsCount/);
    assert.match(PRODUCTS_ROUTES, /fastify\.get\('\/inventory\/snapshot'/);
    assert.match(PRODUCTS_ROUTES, /limit:\s*\{\s*type: 'integer', minimum: 1, maximum: 200/);
  });

  it('pełna INW ma endpoint tworzenia draftu i bulk upsert pozycji', () => {
    assert.match(DOCS_SERVICE, /export async function createFullInventoryDocument\(/);
    assert.match(DOCS_SERVICE, /export async function bulkUpsertInventoryItems\(/);
    assert.match(DOCS_ROUTES, /fastify\.post\('\/documents\/inventory\/full'/);
    assert.match(DOCS_ROUTES, /fastify\.post\('\/documents\/:id\/inventory\/items\/bulk-upsert'/);
  });

  it('GET /products/:id/inventory-snapshot jest zarejestrowany', () => {
    assert.match(PRODUCTS_ROUTES, /fastify\.get\('\/products\/:id\/inventory-snapshot'/);
  });
});
