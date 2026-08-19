import './helpers/test-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  classifyCoverage,
  isBlockingCoverageStatus,
} from '../src/services/orders/order-stock-coverage.service';

const ROOT = process.cwd();
const SHIPMENT_INVOICE_SERVICE = readFileSync(
  join(ROOT, 'src/services/orders/order-shipment-invoice.service.ts'),
  'utf8',
);
const SHIPMENTS_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/order-shipments.service.ts'),
  'utf8',
);
// Silnik automatyzacji ciagnie kolejki i polaczenia, wiec czytamy go jako
// zrodlo — test ma sprawdzac kontrakt, nie startowac aplikacji.
const AUTOMATION_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/automation.service.ts'),
  'utf8',
);
const AUTOMATION_ROUTES = readFileSync(
  join(ROOT, 'src/routes/admin/automations.routes.ts'),
  'utf8',
);

test('brak pokrycia na stanie blokuje skutki magazynowe', () => {
  const base = { requiredQuantity: 2, hasMapping: true, isStockTracked: true, hasBackorder: false };

  assert.equal(classifyCoverage({ ...base, coveredQuantity: 2 }), 'COVERED');
  assert.equal(classifyCoverage({ ...base, coveredQuantity: 3 }), 'COVERED');
  assert.equal(classifyCoverage({ ...base, coveredQuantity: 1 }), 'SHORTAGE');
  assert.equal(classifyCoverage({ ...base, coveredQuantity: 0 }), 'SHORTAGE');
  assert.equal(classifyCoverage({ ...base, coveredQuantity: 0, hasBackorder: true }), 'BACKORDER');

  assert.equal(isBlockingCoverageStatus('SHORTAGE'), true);
  assert.equal(isBlockingCoverageStatus('BACKORDER'), true);
  assert.equal(isBlockingCoverageStatus('MISSING_MAPPING'), true);
  assert.equal(isBlockingCoverageStatus('COVERED'), false);
});

test('produkt wykluczony z magazynu nie wstrzymuje faktury', () => {
  const status = classifyCoverage({
    requiredQuantity: 1,
    coveredQuantity: 0,
    hasMapping: true,
    isStockTracked: false,
    hasBackorder: false,
  });

  assert.equal(status, 'NOT_TRACKED');
  assert.equal(isBlockingCoverageStatus(status), false);
});

test('brak mapowania magazynowego jest traktowany jak brak towaru', () => {
  const status = classifyCoverage({
    requiredQuantity: 1,
    coveredQuantity: 5,
    hasMapping: false,
    isStockTracked: true,
    hasBackorder: false,
  });

  assert.equal(status, 'MISSING_MAPPING');
  assert.equal(isBlockingCoverageStatus(status), true);
});

test('wyzwalacz i akcja listu przewozowego istnieją w silniku automatyzacji', () => {
  assert.match(AUTOMATION_SERVICE, /ORDER_SHIPMENT_CREATED = 'ORDER_SHIPMENT_CREATED'/);
  assert.match(AUTOMATION_SERVICE, /ISSUE_INVOICE_AFTER_SHIPMENT = 'ISSUE_INVOICE_AFTER_SHIPMENT'/);
  assert.match(AUTOMATION_SERVICE, /case AutomationActionType\.ISSUE_INVOICE_AFTER_SHIPMENT:/);
  // Bez wpisu w schemacie trasy panel nie zapisze reguly z nowym wyzwalaczem.
  assert.equal(AUTOMATION_ROUTES.match(/'ORDER_SHIPMENT_CREATED'/g)?.length, 2);
});

test('brak towaru przerywa akcję przed fakturą i przed WZ', () => {
  // Kolejnosc w pliku jest kontraktem: ocena pokrycia i wyjscie ze STOCK_MISSING
  // musza wypasc PRZED wystawieniem faktury i przed ensureOrderWz.
  const coverageIndex = SHIPMENT_INVOICE_SERVICE.indexOf('evaluateOrderStockCoverage(orderId)');
  const stockMissingIndex = SHIPMENT_INVOICE_SERVICE.indexOf("status: 'STOCK_MISSING'");
  const invoiceIndex = SHIPMENT_INVOICE_SERVICE.indexOf('issueOrderInvoice(orderId)');
  const wzIndex = SHIPMENT_INVOICE_SERVICE.indexOf('ensureOrderWz(orderId');

  assert.ok(coverageIndex > 0);
  assert.ok(stockMissingIndex > coverageIndex);
  assert.ok(invoiceIndex > stockMissingIndex);
  assert.ok(wzIndex > invoiceIndex);
});

test('nieudana faktura nie wywołuje skutków magazynowych', () => {
  assert.match(
    SHIPMENT_INVOICE_SERVICE,
    /status: 'FAILED',[\s\S]{0,200}warehouseDocument: \{ status: 'NONE', reason: 'Faktura nie została wystawiona' \}/,
  );
});

test('nadanie listu uruchamia automatyzacje, ale ich błąd nie psuje przesyłki', () => {
  assert.match(SHIPMENTS_SERVICE, /triggerShipmentCreatedAutomations\(\{[\s\S]{0,120}\}\)\.catch\(\(\) => null\)/);
});

test('akcje sprawy są odrzucane przy wyzwalaczach zamówienia', () => {
  // Bez tej bariery CHANGE_STATUS przy wyzwalaczu zamowienia probowalby
  // zaktualizowac sprawe o ID zamowienia i padal na "record not found".
  assert.match(AUTOMATION_SERVICE, /ORDER_SCOPED_TRIGGERS: string\[\] = \[[\s\S]{0,200}ORDER_SHIPMENT_CREATED,/);
  assert.match(AUTOMATION_SERVICE, /assertActionMatchesTriggerScope\(action\.type, context\.trigger\);/);
  for (const actionType of ['SEND_EMAIL', 'CHANGE_STATUS', 'ADD_NOTE']) {
    assert.match(
      AUTOMATION_SERVICE,
      new RegExp(`\\[AutomationActionType\\.${actionType}\\]: 'Akcja`),
      `brak komunikatu odrzucenia dla ${actionType}`,
    );
  }
});

test('zmiana statusu zamówienia idzie tą samą ścieżką co panel', () => {
  // Wlasny prisma.order.update pominalby mapowanie na status PrestaShop
  // i skutki magazynowe (rezerwacje, WZ).
  assert.match(AUTOMATION_SERVICE, /CHANGE_ORDER_STATUS = 'CHANGE_ORDER_STATUS'/);
  assert.match(AUTOMATION_SERVICE, /assertOrderOperationalStatus\(String\(config\.status \|\| ''\)\)/);
  assert.match(AUTOMATION_SERVICE, /updateOrderStatus\(orderId, \{ operationalStatus: status \}\)/);
});
