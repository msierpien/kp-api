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
const RESERVATION_FLOW_MIGRATION = readFileSync(
  join(ROOT, 'prisma/migrations/20260517133000_add_order_reservation_flow/migration.sql'),
  'utf8',
);
const DOCS_SERVICE = readFileSync(join(ROOT, 'src/services/admin/warehouse-documents.service.ts'), 'utf8');
const DOCS_ROUTES = readFileSync(join(ROOT, 'src/routes/admin/warehouse/documents.routes.ts'), 'utf8');
const ORDERS_ROUTES = readFileSync(join(ROOT, 'src/routes/admin/orders.routes.ts'), 'utf8');
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

  it('PZ z ZH może powstać według kontroli dostawy', () => {
    assert.match(DOCS_ROUTES, /Body: warehouseDocumentService\.CreatePzFromWholesaleOrderInput/);
    assert.match(DOCS_ROUTES, /items:[\s\S]{0,180}required: \['productId', 'quantity'\]/);
    assert.match(DOCS_SERVICE, /CreatePzFromWholesaleOrderInput/);
    assert.match(DOCS_SERVICE, /usesDeliveryCheckItems = Array\.isArray\(input\.items\)/);
    assert.match(DOCS_SERVICE, /deliveryCheckSummary/);
    assert.match(DOCS_SERVICE, /missingItems/);
    assert.match(DOCS_SERVICE, /overageItems/);
  });

  it('utworzenie PZ zamyka źródłowy ZH', () => {
    assert.match(DOCS_SERVICE, /sourceDocument\.status === 'DRAFT'/);
    assert.match(DOCS_SERVICE, /status: 'CONFIRMED'/);
    assert.match(DOCS_SERVICE, /confirmedAt: new Date\(\)/);
    assert.match(DOCS_SERVICE, /confirmedByUserId: context\?\.userId/);
  });

  it('PZ z ZH domyślnie jest zatwierdzony, chyba że zapisano roboczo', () => {
    assert.match(DOCS_ROUTES, /saveAsDraft: \{ type: 'boolean' \}/);
    assert.match(DOCS_SERVICE, /shouldConfirmPz = input\.saveAsDraft !== true/);
    assert.match(DOCS_SERVICE, /status: shouldConfirmPz \? 'CONFIRMED' : 'DRAFT'/);
    assert.match(DOCS_SERVICE, /applyStockDeltas\(tx, 'PZ', pz\.items\)/);
    assert.match(DOCS_SERVICE, /reallocateWholesaleBackordersForProducts/);
  });

  it('ręczne WZ z zamówienia domyślnie wymusza zatwierdzenie', () => {
    assert.match(ORDERS_ROUTES, /\/:id\/wz/);
    assert.match(ORDERS_ROUTES, /saveAsDraft: \{ type: 'boolean' \}/);
    assert.match(ORDERS_ROUTES, /forceConfirm: request\.body\?\.saveAsDraft !== true/);
    assert.match(DOCS_SERVICE, /input\.forceConfirm === true \|\| settings\.autoConfirmWzOnOrder/);
    assert.match(DOCS_SERVICE, /input\.saveAsDraft !== true/);
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

  it('reserveOrder rozdziela pozycję między stan lokalny i domówienie hurtowe', () => {
    assert.match(RESERVATIONS_SERVICE, /planReservationSplit/);
    assert.match(RESERVATIONS_SERVICE, /localQuantity/);
    assert.match(RESERVATIONS_SERVICE, /backorderQuantity/);
    assert.match(RESERVATIONS_SERVICE, /backorderShortfallQuantity/);
    assert.match(RESERVATION_FLOW_MIGRATION, /warehouse_reservations_active_order_item_uidx/);
    assert.match(RESERVATIONS_SERVICE, /source: 'LOCAL_STOCK'/);
    assert.match(RESERVATIONS_SERVICE, /source: 'WHOLESALE_BACKORDER'/);
    assert.match(RESERVATIONS_SERVICE, /closesBackorderBeforeLocal/);
    assert.match(RESERVATIONS_SERVICE, /Część pozycji zarezerwowana lokalnie, reszta do domówienia/);
    assert.match(RESERVATIONS_SERVICE, /Rezerwacja hurtowa została przeniesiona na stan lokalny/);
  });

  it('replenishment dolicza hurtowe braki z pozycji zamówienia', () => {
    assert.match(REPLENISHMENT_SERVICE, /shippingSource: 'WHOLESALE_BACKORDER'/);
    assert.match(REPLENISHMENT_SERVICE, /warehouseReservations/);
    assert.match(REPLENISHMENT_SERVICE, /order-item-shortfall/);
    assert.match(REPLENISHMENT_SERVICE, /Brak aktywnej oferty hurtowni dla brakującej części zamówienia/);
  });
});
