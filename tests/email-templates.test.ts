import './helpers/test-env';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  EMAIL_TEMPLATE_VARIABLES,
  applyVariables,
  listEmailTemplateVariables,
  renderEmailTemplatePreview,
} from '../src/services/admin/email-templates.service';

const ROOT = process.cwd();
const AUTOMATION_SERVICE = readFileSync(
  join(ROOT, 'src/services/admin/automation.service.ts'),
  'utf8',
);
const TENANT_MIDDLEWARE = readFileSync(
  join(ROOT, 'src/lib/prisma-tenant-middleware.ts'),
  'utf8',
);

test('podstawianie zmiennych radzi sobie ze spacjami i brakami', () => {
  assert.equal(applyVariables('Cześć {{customerName}}', { customerName: 'Anna' }), 'Cześć Anna');
  assert.equal(applyVariables('Nr {{ orderReference }}', { orderReference: 'KP-1' }), 'Nr KP-1');
  // Brak wartości zostawia puste miejsce, a nie surowy znacznik w mailu.
  assert.equal(applyVariables('Punkt: {{pickupPoint}}', { pickupPoint: null }), 'Punkt: ');
  // Nieznanej zmiennej nie ruszamy — autor zobaczy ją w podglądzie i poprawi.
  assert.equal(applyVariables('{{czegoNieMa}}', { customerName: 'Anna' }), '{{czegoNieMa}}');
});

test('podgląd renderuje się na przykładowych danych, bez zamówienia', () => {
  const preview = renderEmailTemplatePreview({
    subject: 'Paczka — {{orderReference}}',
    bodyText: 'Punkt {{pickupPoint}}, śledzenie: {{trackingUrl}}',
    scope: 'ORDER',
  });

  assert.match(preview.subject, /KP-2903/);
  assert.match(preview.body, /KRA01M/);
  assert.doesNotMatch(preview.body, /\{\{/);
});

test('zakres szablonu decyduje o dostępnych zmiennych', () => {
  const order = listEmailTemplateVariables('ORDER').map((variable) => variable.name);
  const kase = listEmailTemplateVariables('CASE').map((variable) => variable.name);

  assert.ok(order.includes('trackingNumber'));
  assert.ok(order.includes('pickupPoint'));
  // Link do personalizacji istnieje tylko w kontekscie sprawy.
  assert.ok(!order.includes('personalizationUrl'));
  assert.ok(kase.includes('personalizationUrl'));

  for (const scope of ['ORDER', 'CASE'] as const) {
    for (const variable of EMAIL_TEMPLATE_VARIABLES[scope]) {
      assert.ok(variable.sample.trim(), `${scope}.${variable.name} bez przykładu`);
      assert.ok(variable.description.trim(), `${scope}.${variable.name} bez opisu`);
    }
  }
});

test('szablon wygrywa nad treścią wklejoną w regule, ale reguły bez niego działają jak dotąd', () => {
  const action = AUTOMATION_SERVICE.slice(
    AUTOMATION_SERVICE.indexOf('async function executeSendOrderEmail'),
    AUTOMATION_SERVICE.indexOf('async function executeChangeStatus'),
  );

  assert.match(action, /findEmailTemplateForAction/);
  assert.match(action, /template\?\.subject \|\| config\.subject/);
  assert.match(action, /template\?\.bodyText \|\| config\.body/);
});

test('brakujący szablon mówi wprost, co jest nie tak', () => {
  // Cicha wysylka pustego maila byłaby gorsza niz blad w historii regul.
  assert.match(AUTOMATION_SERVICE, /Szablon wskazany w regule nie istnieje/);
});

test('szablony są odcięte per tenant', () => {
  assert.match(TENANT_MIDDLEWARE, /'EmailTemplate'/);
});
