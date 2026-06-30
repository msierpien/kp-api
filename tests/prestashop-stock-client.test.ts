import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAdminConnectorControllerUrl,
  buildBulkStockSnapshotUrl,
  buildBulkStockUrl,
  normalizeBulkStockBatchSize,
  replaceProductOrderAvailabilityXml,
  replaceProductPriceXml,
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
    <price>1.23</price>
    <wholesale_price>0.00</wholesale_price>
    <available_later>
      <language id="1"></language>
      <language id="2"></language>
    </available_later>
    <visibility>both</visibility>
  </product>
</prestashop>`;

test('PrestaShop price update writes retail price and purchase cost', () => {
  const xml = replaceProductPriceXml(PRODUCT_XML, 13.99, 8.77);

  assert.match(xml, /<price>13\.99<\/price>/);
  assert.match(xml, /<wholesale_price>8\.77<\/wholesale_price>/);
  assert.doesNotMatch(xml, /<manufacturer_name>/);
  assert.doesNotMatch(xml, /<quantity>/);
  assert.doesNotMatch(xml, /<position_in_category>/);
});

test('PrestaShop product update enables orders and publishes wholesale lead time', () => {
  const xml = replaceProductOrderAvailabilityXml(PRODUCT_XML, {
    availabilityPolicy: 'BACKORDER_FROM_WHOLESALE',
    leadTimeDays: 3,
  });
  const expectedMessage = `Wysyłka do ${formatExpectedLeadTimeDate(3)}`;

  assert.match(xml, /<available_for_order>1<\/available_for_order>/);
  assert.match(xml, /<show_price>1<\/show_price>/);
  assert.match(xml, new RegExp(`<language id="1"><!\\[CDATA\\[${escapeRegex(expectedMessage)}\\]\\]><\\/language>`));
  assert.match(xml, new RegExp(`<language id="2"><!\\[CDATA\\[${escapeRegex(expectedMessage)}\\]\\]><\\/language>`));
  assert.doesNotMatch(xml, /<manufacturer_name>/);
  assert.doesNotMatch(xml, /<quantity>/);
  assert.doesNotMatch(xml, /<position_in_category>/);
});

test('PrestaShop product update disables ordering when product is out of stock everywhere', () => {
  const xml = replaceProductOrderAvailabilityXml(PRODUCT_XML, {
    availabilityPolicy: 'OUT_OF_STOCK',
    leadTimeDays: 2,
    active: false,
  });

  assert.match(xml, /<active>0<\/active>/);
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

test('module URL helpers replace existing connector controllers', () => {
  assert.equal(
    buildAdminConnectorControllerUrl('https://shop.test/module/kp_adminconnector/capabilities', 'bulkupdate'),
    'https://shop.test/module/kp_adminconnector/bulkupdate',
  );
  assert.equal(
    buildAdminConnectorControllerUrl(
      'https://shop.test/index.php?fc=module&module=kp_adminconnector&controller=capabilities',
      'stocksnapshot',
      { productId: 123, idShop: 2 },
    ),
    'https://shop.test/index.php?fc=module&module=kp_adminconnector&controller=stocksnapshot&productId=123&idShop=2',
  );
});

test('bulk stock URLs carry multistore shop context', () => {
  assert.equal(
    buildBulkStockUrl('https://shop.test', '2'),
    'https://shop.test/index.php?fc=module&module=kp_bulkstock&controller=bulkupdate&idShop=2',
  );
  assert.equal(
    buildBulkStockSnapshotUrl('https://shop.test', 123, '2'),
    'https://shop.test/index.php?fc=module&module=kp_bulkstock&controller=snapshot&productId=123&idShop=2',
  );
});

function formatExpectedLeadTimeDate(days: number) {
  let next = todayDateOnly();
  let remaining = days;
  while (remaining > 0) {
    next = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate() + 1));
    const day = next.getUTCDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return new Intl.DateTimeFormat('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(next);
}

function todayDateOnly() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
