// MUSI byc pierwszy - ustawia env, zanim zaladuje sie config.
import './helpers/test-env';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertCaseWritable, assertTokenUsable, isCaseWritable } from '../src/lib/case-access';
import { parseLayoutOverrides } from '../src/schemas/personalization.schema';
import { getTokenExpiryDate } from '../src/lib/token';

/** Atrapa `reply` - interesuje nas kod odpowiedzi i to, czy w ogole padla. */
function fakeReply() {
  const sent: Array<{ statusCode: number; body: any }> = [];
  let statusCode = 200;
  const reply: any = {
    status(code: number) {
      statusCode = code;
      return reply;
    },
    send(body: any) {
      sent.push({ statusCode, body });
      return reply;
    },
  };
  return { reply, sent };
}

// --- Status sprawy ---

test('sprawa zatwierdzona nie przyjmuje zmian', () => {
  for (const status of ['SUBMITTED', 'RENDERED', 'READY_FOR_PRINT', 'ARCHIVED']) {
    assert.equal(isCaseWritable(status), false, status);
  }
});

test('sprawa w toku przyjmuje zmiany', () => {
  for (const status of ['NEW', 'WAITING_FOR_CUSTOMER', 'DRAFT', 'PREVIEW_READY', 'FAILED_RENDER']) {
    assert.equal(isCaseWritable(status), true, status);
  }
});

test('assertCaseWritable odpowiada 409 na sprawie zatwierdzonej', () => {
  const { reply, sent } = fakeReply();
  const result = assertCaseWritable({ status: 'SUBMITTED' }, reply);

  assert.equal(result, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].statusCode, 409);
});

test('assertCaseWritable przepuszcza sprawe w toku bez odpowiedzi', () => {
  const { reply, sent } = fakeReply();
  assert.equal(assertCaseWritable({ status: 'WAITING_FOR_CUSTOMER' }, reply), true);
  assert.equal(sent.length, 0);
});

// --- Token ---

test('nieaktywny token to 403', () => {
  const { reply, sent } = fakeReply();
  assert.equal(assertTokenUsable({ tokenActive: false }, reply), false);
  assert.equal(sent[0].statusCode, 403);
});

test('token po terminie to 410 (portal ma dla tego osobny komunikat)', () => {
  const { reply, sent } = fakeReply();
  const expired = new Date(Date.now() - 1000);

  assert.equal(assertTokenUsable({ tokenActive: true, customerTokenExpiresAt: expired }, reply), false);
  assert.equal(sent[0].statusCode, 410);
});

test('sprawa bez terminu zyje dalej - stare linki nie moga paść przy wdrozeniu', () => {
  const { reply, sent } = fakeReply();
  assert.equal(assertTokenUsable({ tokenActive: true, customerTokenExpiresAt: null }, reply), true);
  assert.equal(sent.length, 0);
});

test('termin waznosci nowego tokenu bierze sie z konfiguracji', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const expiry = getTokenExpiryDate(now);

  // Domyslnie 90 dni; test ma przezyc zmiane wartosci w .env, wiec
  // sprawdzamy kierunek, nie konkretna date.
  assert.ok(expiry === null || expiry.getTime() > now.getTime());
});

// --- Nadpisania layoutu ---

const validImageLayer = {
  id: 'client_1',
  pageId: 'page-1',
  layer: {
    id: 'client_1',
    type: 'image',
    x: 100,
    y: 100,
    width: 300,
    height: 300,
    properties: { type: 'image', imageUrl: 'orders/abc/v1/ozdobnik-x1y2.svg', fit: 'contain' },
  },
};

test('poprawne nadpisania przechodza', () => {
  const result = parseLayoutOverrides({
    layers: { 'layer-1': { x: 10, y: 20, fontSize: 18, fill: '#112233' } },
    items: { '0': { layers: { 'layer-1': { fontSize: 14 } } } },
    addedLayers: [validImageLayer],
    customFields: [{ key: 'custom_numer_stolu', label: 'Numer stołu', scope: 'INDIVIDUAL' }],
  });

  assert.equal(result.ok, true);
  assert.ok(result.ok && result.data?.addedLayers?.length === 1);
});

test('imageUrl z adresem http jest odrzucany (SSRF)', () => {
  const result = parseLayoutOverrides({
    addedLayers: [
      {
        ...validImageLayer,
        layer: {
          ...validImageLayer.layer,
          properties: { type: 'image', imageUrl: 'http://169.254.169.254/latest/meta-data/' },
        },
      },
    ],
  });

  assert.equal(result.ok, false);
});

test('imageUrl wychodzacy poza magazyn jest odrzucany (path traversal)', () => {
  for (const imageUrl of ['../../etc/passwd', '/etc/passwd', 'orders/../../secret.png']) {
    const result = parseLayoutOverrides({
      addedLayers: [
        {
          ...validImageLayer,
          layer: { ...validImageLayer.layer, properties: { type: 'image', imageUrl } },
        },
      ],
    });
    assert.equal(result.ok, false, imageUrl);
  }
});

test('pola spoza schematu nie trafiaja do bazy', () => {
  const result = parseLayoutOverrides({
    layers: { 'layer-1': { x: 5, __proto__: { evil: true }, cokolwiek: 'nie moja sprawa' } },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.data?.layers?.['layer-1'], { x: 5 });
});

test('limity elementow i kolumn dzialaja', () => {
  const tooManyLayers = parseLayoutOverrides({
    addedLayers: Array.from({ length: 41 }, (_, index) => ({
      ...validImageLayer,
      id: `client_${index}`,
      layer: { ...validImageLayer.layer, id: `client_${index}` },
    })),
  });
  assert.equal(tooManyLayers.ok, false);

  const tooManyFields = parseLayoutOverrides({
    customFields: Array.from({ length: 11 }, (_, index) => ({
      key: `custom_${index}`,
      label: `Kolumna ${index}`,
      scope: 'INDIVIDUAL',
    })),
  });
  assert.equal(tooManyFields.ok, false);
});

test('za dlugi tekst dodanego elementu jest odrzucany', () => {
  const result = parseLayoutOverrides({
    addedLayers: [
      {
        id: 'client_text',
        pageId: 'page-1',
        layer: {
          id: 'client_text',
          type: 'textbox',
          x: 0,
          y: 0,
          width: 100,
          height: 50,
          properties: { type: 'textbox', text: 'a'.repeat(2001) },
        },
      },
    ],
  });

  assert.equal(result.ok, false);
});

test('brak nadpisan to poprawny przypadek (klient zapisuje same odpowiedzi)', () => {
  const result = parseLayoutOverrides(undefined);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.data, undefined);
});
