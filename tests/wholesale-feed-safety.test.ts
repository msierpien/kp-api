import assert from 'node:assert/strict';
import test from 'node:test';
import { validateWholesaleFeed } from '../src/services/admin/wholesale-sync.service';

const safety = { minItems: 100, maxDropPercent: 40, maxInvalidPercent: 5 };

test('accepts a complete wholesale feed within configured thresholds', () => {
  const result = validateWholesaleFeed({
    totalItems: 950,
    uniqueItems: 945,
    invalidItems: 5,
    baselineItems: 1000,
    safety,
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(Math.round(result.dropPercent ?? 0), 5);
});

test('blocks a feed whose item count drops beyond the configured threshold', () => {
  const result = validateWholesaleFeed({
    totalItems: 500,
    uniqueItems: 500,
    invalidItems: 0,
    baselineItems: 1000,
    safety,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join(' '), /spadła o 50/);
});

test('blocks empty and overly invalid feeds', () => {
  const empty = validateWholesaleFeed({
    totalItems: 0,
    uniqueItems: 0,
    invalidItems: 0,
    baselineItems: null,
    safety,
  });
  const invalid = validateWholesaleFeed({
    totalItems: 1000,
    uniqueItems: 900,
    invalidItems: 100,
    baselineItems: 1000,
    safety,
  });

  assert.equal(empty.ok, false);
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(' '), /błędne rekordy 10.00%/);
});

test('limited manual sync bypasses size guards but still requires a valid SKU', () => {
  const result = validateWholesaleFeed({
    totalItems: 1,
    uniqueItems: 1,
    invalidItems: 0,
    baselineItems: 1000,
    safety,
    partial: true,
  });

  assert.equal(result.ok, true);
});
