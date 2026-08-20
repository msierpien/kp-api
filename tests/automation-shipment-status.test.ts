import './helpers/test-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { AUTOMATION_SCENARIOS, getAutomationScenario } from '../src/services/admin/automation-scenarios';
import { shipmentStageFromStatus } from '../src/lib/inpost-statuses';

const ROOT = process.cwd();
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
const SHIPMENTS_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/order-shipments.service.ts'),
  'utf8',
);
const RETENTION_SERVICE = readFileSync(
  join(ROOT, 'src/services/maintenance/job-retention.service.ts'),
  'utf8',
);

test('wyzwalacz statusu przesylki jest znany silnikowi i API', () => {
  assert.match(AUTOMATION_SERVICE, /ORDER_SHIPMENT_STATUS_CHANGED = 'ORDER_SHIPMENT_STATUS_CHANGED'/);
  assert.match(AUTOMATION_ROUTES, /'ORDER_SHIPMENT_STATUS_CHANGED'/);
});

test('wyzwalacz statusu przesylki dziala na zamowieniu, nie na sprawie', () => {
  // Akcje piszace po sprawie personalizacji nie maja tu czego znalezc —
  // ORDER_SCOPED_TRIGGERS odrzuca je z czytelnym komunikatem.
  const scoped = AUTOMATION_SERVICE.slice(
    AUTOMATION_SERVICE.indexOf('const ORDER_SCOPED_TRIGGERS'),
    AUTOMATION_SERVICE.indexOf('export function isOrderScopedTrigger'),
  );
  assert.match(scoped, /ORDER_SHIPMENT_STATUS_CHANGED/);
});

test('ta sama zmiana statusu nie wysle drugiego maila', () => {
  // Klucz idempotencji sklada sie z przesylki i statusu, wiec ponowny
  // przebieg synchronizacji trafia na kolizje i pomija regule.
  assert.match(AUTOMATION_SERVICE, /contextKey: `shipment:\$\{input\.shipmentId\}:\$\{status \|\| 'unknown'\}`/);

  const reserve = AUTOMATION_SERVICE.slice(
    AUTOMATION_SERVICE.indexOf('async function reserveAutomationRun'),
    AUTOMATION_SERVICE.indexOf('async function recordAutomationRun'),
  );
  assert.match(reserve, /error\.code === 'P2002'/);
  assert.match(reserve, /return null/);
});

test('rezerwacja historii wyprzedza wykonanie akcji', () => {
  const runner = AUTOMATION_SERVICE.slice(
    AUTOMATION_SERVICE.indexOf('async function runAutomationsForTrigger'),
    AUTOMATION_SERVICE.indexOf('async function reserveAutomationRun'),
  );
  const reserveAt = runner.indexOf('await reserveAutomationRun');
  const executeAt = runner.indexOf('await executeActions');
  assert.ok(reserveAt > -1 && executeAt > -1);
  // Odwrotna kolejnosc znaczylaby, ze mail wychodzi, zanim powstanie blokada.
  assert.ok(reserveAt < executeAt, 'run musi powstac przed wykonaniem akcji');
  assert.match(runner, /if \(!run\) continue;/);
});

test('pominiete uruchomienie nie blokuje pozniejszego wykonania', () => {
  const runner = AUTOMATION_SERVICE.slice(
    AUTOMATION_SERVICE.indexOf('async function runAutomationsForTrigger'),
    AUTOMATION_SERVICE.indexOf('async function reserveAutomationRun'),
  );
  const skipped = runner.slice(runner.indexOf("status: 'SKIPPED'"), runner.indexOf('const run = await reserveAutomationRun'));
  assert.match(skipped, /contextKey: null/);
});

test('synchronizacja przesylek uruchamia automatyzacje przy kazdej zmianie', () => {
  assert.match(SHIPMENTS_SERVICE, /triggerShipmentStatusAutomations\(\{/);
  assert.match(SHIPMENTS_SERVICE, /previousStatus: change\.previousStatus/);
  // Blad reguly nie moze zatrzymac synchronizacji pozostalych przesylek.
  const call = SHIPMENTS_SERVICE.slice(
    SHIPMENTS_SERVICE.indexOf('await triggerShipmentStatusAutomations'),
    SHIPMENTS_SERVICE.indexOf('} catch (error) {', SHIPMENTS_SERVICE.indexOf('await triggerShipmentStatusAutomations')),
  );
  assert.match(call, /\.catch\(/);
});

test('akcja mailowa dla zamowienia nie dotyka sprawy personalizacji', () => {
  const action = AUTOMATION_SERVICE.slice(
    AUTOMATION_SERVICE.indexOf('async function executeSendOrderEmail'),
    AUTOMATION_SERVICE.indexOf('async function executeChangeStatus'),
  );
  assert.doesNotMatch(action, /personalizationCase|issueCaseToken|personalizationUrl/);
  // Nadawca zalezy od sklepu — inaczej SPF i DKIM nie zgadzaja sie z adresem.
  assert.match(action, /createShopEmailService\(order\.shop\.id\)/);
  assert.match(action, /trackingUrl/);
});

test('scenariusze maja komplet pol i sensowne wyzwalacze', () => {
  const triggers = new Set([
    'CASE_CREATED',
    'CASE_STATUS_CHANGED',
    'CASE_SUBMITTED',
    'CASE_TIME_ELAPSED',
    'ORDER_INVOICE_ISSUED',
    'ORDER_SHIPMENT_CREATED',
    'ORDER_SHIPMENT_STATUS_CHANGED',
  ]);

  const ids = new Set<string>();
  for (const scenario of AUTOMATION_SCENARIOS) {
    assert.ok(scenario.name.trim(), `scenariusz ${scenario.id} bez nazwy`);
    assert.ok(scenario.summary.trim(), `scenariusz ${scenario.id} bez opisu`);
    assert.ok(triggers.has(scenario.trigger), `scenariusz ${scenario.id} ma nieznany wyzwalacz`);
    assert.ok(scenario.actions.length > 0, `scenariusz ${scenario.id} bez akcji`);
    assert.ok(!ids.has(scenario.id), `duplikat id scenariusza: ${scenario.id}`);
    ids.add(scenario.id);
  }
});

test('scenariusze przesylkowe pisza do klienta dopiero po wlaczeniu', () => {
  const shipmentScenarios = AUTOMATION_SCENARIOS.filter(
    (scenario) => scenario.trigger === 'ORDER_SHIPMENT_STATUS_CHANGED',
  );
  assert.ok(shipmentScenarios.length >= 3);

  for (const scenario of shipmentScenarios) {
    // InPost sam wysyla powiadomienia; nasze maja ruszyc dopiero, gdy ktos
    // przeczyta tresc i swiadomie wlaczy regule.
    assert.equal(scenario.startsDisabled, true, `${scenario.id} startuje włączony`);

    const stageCondition = scenario.conditions.find((condition) => condition.field === 'shipment.stage');
    assert.ok(stageCondition, `${scenario.id} bez warunku na etapie doręczenia`);
    assert.equal(
      shipmentStageFromStatus(String(stageCondition.value).toLowerCase()) !== undefined,
      true,
    );
  }
});

test('scenariusz paczkomatowy lapie dokladnie oczekiwanie na odbior', () => {
  const scenario = getAutomationScenario('parcel-waiting-in-locker');
  assert.ok(scenario);
  assert.equal(scenario.conditions[0].value, 'READY_TO_PICKUP');
  assert.equal(shipmentStageFromStatus('ready_to_pickup'), 'READY_TO_PICKUP');
  assert.equal(scenario.actions[0].type, 'SEND_ORDER_EMAIL');
});

test('historia z kluczem idempotencji przezywa dluzej niz zwykle wpisy', () => {
  // Skasowany klucz pozwolilby wyslac klientowi drugiego maila o tym samym.
  assert.match(RETENTION_SERVICE, /contextKey: null, createdAt: \{ lt: completedBefore \}/);
  assert.match(RETENTION_SERVICE, /contextKey: \{ not: null \}, createdAt: \{ lt: failedBefore \}/);
});

test('panel dostaje historie, kolejnosc, duplikat i biblioteke scenariuszy', () => {
  assert.match(AUTOMATION_ROUTES, /'\/:id\/runs'/);
  assert.match(AUTOMATION_ROUTES, /'\/reorder'/);
  assert.match(AUTOMATION_ROUTES, /'\/:id\/duplicate'/);
  assert.match(AUTOMATION_ROUTES, /'\/scenarios'/);
  // Trasy statyczne musza byc zadeklarowane przed parametrem :id, inaczej
  // `scenarios` wpadloby pod `/:id`.
  assert.ok(AUTOMATION_ROUTES.indexOf("'/scenarios'") < AUTOMATION_ROUTES.indexOf("  // GET /admin/automations/:id"));
});
