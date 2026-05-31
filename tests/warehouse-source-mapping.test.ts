import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEanMatchCandidates } from '../src/services/admin/warehouse-product-source-mapping.service';

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
