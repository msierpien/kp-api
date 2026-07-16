import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  normalizeEanMatchCandidates,
  normalizeSkuMatchCandidates,
  productNameSkuCandidates,
} from '../src/services/admin/warehouse-product-source-mapping.service';

test('EAN matching normalizes separators and numeric CSV decimal suffixes', () => {
  assert.deepEqual(normalizeEanMatchCandidates('590-123 456 7890'), ['5901234567890']);
  assert.deepEqual(normalizeEanMatchCandidates('5901234567890.0'), ['5901234567890']);
});

test('EAN matching accepts UPC/EAN leading-zero variants', () => {
  assert.deepEqual(normalizeEanMatchCandidates('012345678905'), ['012345678905', '0012345678905']);
  assert.deepEqual(normalizeEanMatchCandidates('0012345678905'), ['0012345678905', '012345678905']);
});

test('EAN matching extracts multiple candidate codes from one supplier field', () => {
  assert.deepEqual(
    normalizeEanMatchCandidates('5901234567890 / 5909876543210'),
    ['5901234567890', '5909876543210'],
  );
});

test('SKU matching accepts supplier hash-code variants', () => {
  assert.deepEqual(normalizeSkuMatchCandidates('#ZKU'), ['#zku', 'zku']);
  assert.deepEqual(productNameSkuCandidates('#ZKU Kubeczki papierowe'), ['zku']);
});

test('SKU matching does not extract ordinary first words from product names', () => {
  assert.deepEqual(productNameSkuCandidates('Album na 24 zdjęcia'), []);
});

test('wholesale sync keeps mapped offers missing from feed as zero-stock mappings', () => {
  const source = readFileSync(join(process.cwd(), 'src/services/admin/wholesale-sync.service.ts'), 'utf8');
  const start = source.indexOf('async function applyWholesaleFeed');
  const end = source.indexOf('async function enqueueWholesaleAvailabilityStockSync', start);
  const body = source.slice(start, end);
  const mappedUpdate = body.slice(
    body.indexOf('for (let offset = 0; offset < missingMappedIds.length'),
    body.indexOf('for (let offset = 0; offset < missingUnmappedIds.length'),
  );
  const unmappedUpdate = body.slice(body.indexOf('for (let offset = 0; offset < missingUnmappedIds.length'));

  assert.match(body, /const missingMappedIds = missing/);
  assert.match(body, /const missingUnmappedIds = missing/);
  assert.match(mappedUpdate, /lastKnownStock: ZERO/);
  assert.doesNotMatch(mappedUpdate, /isActive: false/);
  assert.match(unmappedUpdate, /isActive: false/);
  assert.match(body, /missingHandled: missingMappedIds\.length \+ missingUnmappedIds\.length/);
});
