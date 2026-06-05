import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeBulkStockBatchSize,
  replaceProductOrderAvailabilityXml,
} from '../src/services/shops/prestashop-stock-client';

const PRODUCT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop>
  <product>
    <id>123</id>
    <manufacturer_name>Readonly</manufacturer_name>
    <quantity>0</quantity>
    <position_in_category>0</position_in_category>
    <available_for_order>0</available_for_order>
    <show_price>0</show_price>
    <available_later>
      <language id="1"></language>
      <language id="2"></language>
    </available_later>
    <visibility>both</visibility>
  </product>
</prestashop>`;

test('PrestaShop product update enables orders and publishes wholesale lead time', () => {
  const xml = replaceProductOrderAvailabilityXml(PRODUCT_XML, {
    availabilityPolicy: 'BACKORDER_FROM_WHOLESALE',
    leadTimeDays: 3,
  });

  assert.match(xml, /<available_for_order>1<\/available_for_order>/);
  assert.match(xml, /<show_price>1<\/show_price>/);
  assert.match(xml, /<language id="1"><!\[CDATA\[Wysyłka w 3 dni\]\]><\/language>/);
  assert.match(xml, /<language id="2"><!\[CDATA\[Wysyłka w 3 dni\]\]><\/language>/);
  assert.doesNotMatch(xml, /<manufacturer_name>/);
  assert.doesNotMatch(xml, /<quantity>/);
  assert.doesNotMatch(xml, /<position_in_category>/);
});

test('PrestaShop product update disables ordering when product is out of stock everywhere', () => {
  const xml = replaceProductOrderAvailabilityXml(PRODUCT_XML, {
    availabilityPolicy: 'OUT_OF_STOCK',
    leadTimeDays: 2,
  });

  assert.match(xml, /<available_for_order>0<\/available_for_order>/);
  assert.match(xml, /<show_price>1<\/show_price>/);
  assert.match(xml, /<language id="1"><!\[CDATA\[\]\]><\/language>/);
});

test('bulk stock client defaults invalid batch sizes to 500', () => {
  assert.equal(normalizeBulkStockBatchSize(undefined), 500);
  assert.equal(normalizeBulkStockBatchSize(250), 250);
  assert.equal(normalizeBulkStockBatchSize(0), 500);
  assert.equal(normalizeBulkStockBatchSize(501), 500);
});
