import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildNetunoCsv, parseNetunoProduct } from '../src/services/admin/wholesale/netuno-scraper';
import { buildProviderConfig, fetchFeed, mapCsvRecord, parseCsv } from '../src/services/admin/wholesale/shared';

const PRODUCT_URL = 'https://netuno.pl/koperta-testowa-18240.html';

/** Buduje odpowiedz `?ajax=1&action=refresh` tak, jak sklada ja Netuno. */
function buildAjaxPayload(product: Record<string, unknown>, extraDetailsHtml = '') {
  const encoded = JSON.stringify(product)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');

  return {
    product_details: `<div class="js-product-details" data-product="${encoded}">${extraDetailsHtml}</div>`,
  };
}

const BASE_PRODUCT = {
  id_product: 18240,
  reference: 'NE120KKG22/K153-DE',
  name: 'Koperta ozdobna kwadratowa K4',
  description: 'Koperty ozdobne Keaykolour.',
  quantity: 11171,
  price_tax_exc: 0.77,
  price_amount: 0.95,
  minimal_quantity: 1,
  category_name: 'Keaykolour',
  manufacturer_name: 'Keaykolour',
  features: [
    { name: 'Opakowanie zbiorcze', value: '500' },
    { name: 'Kolor', value: 'zielony' },
  ],
  images: [{ bySize: { large_default: { url: 'https://netuno.pl/1-large_default/a.jpg' } } }],
};

test('próg wyrażony stałą ceną trafia do wyniku bez zmian', () => {
  const payload = buildAjaxPayload({
    ...BASE_PRODUCT,
    quantity_discounts: [{ from_quantity: '500', price: '0.649000', reduction: '0.000000', reduction_type: 'amount' }],
  });

  const product = parseNetunoProduct(payload, PRODUCT_URL);

  assert.equal(product.reference, 'NE120KKG22/K153-DE');
  assert.equal(product.stock, 11171);
  assert.equal(product.priceNet, 0.77);
  assert.deepEqual(product.tiers, [{ fromQuantity: 500, priceNet: 0.649 }]);
});

test('próg wyrażony rabatem procentowym (price = -1) jest przeliczany, nie brany dosłownie', () => {
  // PrestaShop zapisuje `price: -1` gdy progiem jest rabat. Wziete doslownie
  // dawaloby ujemna cene zakupu - i tak wlasnie bylo, zanim to poprawiono.
  const payload = buildAjaxPayload({
    ...BASE_PRODUCT,
    price_tax_exc: 0.528,
    quantity_discounts: [
      { from_quantity: '100', price: '-1.000000', reduction: '0.070000', reduction_type: 'percentage' },
      { from_quantity: '500', price: '-1.000000', reduction: '0.200000', reduction_type: 'percentage' },
      { from_quantity: '5000', price: '-1.000000', reduction: '0.300000', reduction_type: 'percentage' },
    ],
  });

  const product = parseNetunoProduct(payload, PRODUCT_URL);

  assert.deepEqual(product.tiers, [
    { fromQuantity: 100, priceNet: 0.491 },
    { fromQuantity: 500, priceNet: 0.4224 },
    { fromQuantity: 5000, priceNet: 0.3696 },
  ]);
  assert.ok(product.tiers.every((tier) => tier.priceNet > 0), 'żaden próg nie może być ujemny');
});

test('próg bez możliwej do ustalenia ceny jest pomijany zamiast trafiać do feedu', () => {
  const payload = buildAjaxPayload({
    ...BASE_PRODUCT,
    quantity_discounts: [{ from_quantity: '100', price: '-1.000000', reduction: '0', reduction_type: 'nieznany' }],
  });

  assert.deepEqual(parseNetunoProduct(payload, PRODUCT_URL).tiers, []);
});

test('EAN jest czytany z tabeli cech, bo nie ma go w data-product', () => {
  const payload = buildAjaxPayload(BASE_PRODUCT, '<dl><dt>EAN</dt><dd>5902767853590</dd></dl>');

  assert.equal(parseNetunoProduct(payload, PRODUCT_URL).ean, '5902767853590');
});

test('brak atrybutu data-product jest błędem, a nie po cichu pustym produktem', () => {
  assert.throws(
    () => parseNetunoProduct({ product_details: '<div>bez danych</div>' }, PRODUCT_URL),
    /data-product/,
  );
});

test('CSV ze scrapera przechodzi przez pipeline CSV_FEED presetem NETUNO', () => {
  const product = parseNetunoProduct(
    buildAjaxPayload(BASE_PRODUCT, '<dl><dt>EAN</dt><dd>5902767853590</dd></dl>'),
    PRODUCT_URL,
  );

  const config = buildProviderConfig({ name: 'Netuno', feedUrl: 'file:///tmp/netuno.csv' });
  assert.equal(config.preset, 'NETUNO');
  assert.equal(config.availabilityRule, 'STOCK_ONLY');

  const records = parseCsv(buildNetunoCsv([product]), config.delimiter ?? ';');
  const mapped = mapCsvRecord(records[0], config.fieldMapping);

  assert.equal(mapped.externalSku, 'NE120KKG22/K153-DE');
  assert.equal(mapped.externalEan, '5902767853590');
  assert.equal(String(mapped.lastKnownStock), '11171');
  assert.equal(String(mapped.lastKnownPrice), '0.77');
  assert.equal(mapped.externalCategory, 'Keaykolour');

  // Kolumna zdjec musi nazywac sie `photos` - tylko wtedy parseImageUrls
  // przy publikacji do sklepu rozdzieli wartosc po przecinku.
  assert.equal(config.fieldMapping.image, 'photos');
  assert.ok('photos' in records[0]);
});

test('fetchFeed czyta feed z pliku lokalnego (file://)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'netuno-feed-'));
  const file = path.join(dir, 'feed.csv');
  await writeFile(file, 'reference;name\nABC;Koperta\n', 'utf8');

  const content = await fetchFeed(pathToFileURL(file).href);

  assert.match(content, /ABC;Koperta/);
});

test('fetchFeed zgłasza czytelny błąd, gdy pliku feedu nie ma', async () => {
  await assert.rejects(
    fetchFeed(pathToFileURL(path.join(tmpdir(), 'nie-ma-takiego-feedu.csv')).href),
    /Błąd odczytu feedu hurtowni z pliku/,
  );
});
