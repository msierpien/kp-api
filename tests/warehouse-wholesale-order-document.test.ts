import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const SCHEMA = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
const MIGRATION = readFileSync(
  join(ROOT, 'prisma/migrations/20260615120000_add_wholesale_order_document/migration.sql'),
  'utf8',
);
const DOCS_SERVICE = readFileSync(join(ROOT, 'src/services/admin/warehouse-documents.service.ts'), 'utf8');
const DOCS_ROUTES = readFileSync(join(ROOT, 'src/routes/admin/warehouse/documents.routes.ts'), 'utf8');
const REPLENISHMENT_SERVICE = readFileSync(join(ROOT, 'src/services/admin/warehouse-replenishment.service.ts'), 'utf8');
const REPLENISHMENT_ROUTES = readFileSync(join(ROOT, 'src/routes/admin/warehouse/replenishment.routes.ts'), 'utf8');
const RESERVATIONS_SERVICE = readFileSync(join(ROOT, 'src/services/admin/warehouse-reservations.service.ts'), 'utf8');

describe('warehouse wholesale order document (ZH)', () => {
  it('schema i migracja dodają typ ZH', () => {
    const enumBlock = SCHEMA.match(/enum WarehouseDocumentType \{[\s\S]*?\}/)?.[0] ?? '';
    assert.match(enumBlock, /\bZH\b/);
    assert.match(MIGRATION, /ALTER TYPE "WarehouseDocumentType" ADD VALUE 'ZH'/);
  });

  it('ZH jest dokumentem neutralnym magazynowo', () => {
    assert.match(DOCS_SERVICE, /export type DocumentType = 'PZ' \| 'ZH' \| 'PW' \| 'WZ' \| 'ZW' \| 'RW' \| 'INW'/);
    assert.match(DOCS_SERVICE, /STOCK_INCOMING_TYPES: DocumentType\[\] = \['PZ', 'PW', 'ZW'\]/);
    assert.match(DOCS_SERVICE, /STOCK_OUTGOING_TYPES: DocumentType\[\] = \['WZ', 'RW'\]/);
  });

  it('replenishment tworzy ZH i odejmuje aktywne zamówienia od głównej listy', () => {
    assert.match(REPLENISHMENT_SERVICE, /createWholesaleOrderFromReplenishment/);
    assert.match(REPLENISHMENT_SERVICE, /type: 'ZH'/);
    assert.match(REPLENISHMENT_SERVICE, /ordered: ReplenishmentOrderedProviderGroup\[\]/);
    assert.match(REPLENISHMENT_SERVICE, /subtractOrderedQuantities\(providers, orderedQuantityByProviderProduct\(ordered\)\)/);
  });

  it('API ma endpointy tworzenia ZH i PZ z ZH', () => {
    assert.match(REPLENISHMENT_ROUTES, /\/replenishment\/providers\/:providerId\/order/);
    assert.match(DOCS_ROUTES, /\/documents\/:id\/create-pz/);
    assert.match(DOCS_SERVICE, /createPzFromWholesaleOrder/);
  });

  it('eksport CSV ZH zatwierdza robocze zamówienie hurtowe', () => {
    assert.match(DOCS_ROUTES, /\/documents\/:id\/export-csv/);
    assert.match(DOCS_ROUTES, /\/documents\/zh\/providers\/:providerId\/export-csv/);
    assert.match(DOCS_SERVICE, /exportWholesaleOrderCsv/);
    assert.match(DOCS_SERVICE, /exportWholesaleOrdersForProviderCsv/);
    assert.match(DOCS_SERVICE, /if \(document\.status === 'DRAFT'\)[\s\S]{0,80}await confirmDocument\(document\.id\)/);
    assert.match(DOCS_SERVICE, /await confirmDocument\(documentId\)/);
  });

  it('CSV ZH ma formaty koszyka GoDan i PartyDeco', () => {
    assert.match(DOCS_SERVICE, /Kod produktu\/Ean', 'Ilość', 'Jednostka miary/);
    assert.match(DOCS_SERVICE, /'code', 'count'/);
    assert.match(DOCS_SERVICE, /template === 'GODAN' \? ',' : ';'/);
  });

  it('zatwierdzenie PZ przelicza aktywne rezerwacje hurtowe', () => {
    assert.match(DOCS_SERVICE, /if \(doc\.type === 'PZ'\)[\s\S]{0,120}reallocateWholesaleBackordersForProducts/);
    assert.match(DOCS_SERVICE, /source: 'WHOLESALE_BACKORDER'/);
    assert.match(DOCS_SERVICE, /await reserveOrder\(orderId\)/);
  });

  it('replenishment pozwala ręcznie przeliczyć aktywne rezerwacje hurtowe', () => {
    assert.match(REPLENISHMENT_ROUTES, /\/replenishment\/recalculate/);
    assert.match(REPLENISHMENT_SERVICE, /recalculateWholesaleBackorderReservations/);
    assert.match(REPLENISHMENT_SERVICE, /source: 'WHOLESALE_BACKORDER'/);
    assert.match(REPLENISHMENT_SERVICE, /await reserveOrder\(order\.orderId\)/);
  });

  it('reserveOrder potrafi przenieść rezerwację hurtową na stan lokalny', () => {
    assert.match(RESERVATIONS_SERVICE, /existingReservation\.source === 'WHOLESALE_BACKORDER'/);
    assert.match(RESERVATIONS_SERVICE, /source: 'LOCAL_STOCK'/);
    assert.match(RESERVATIONS_SERVICE, /Rezerwacja hurtowa została przeniesiona na stan lokalny/);
  });
});
