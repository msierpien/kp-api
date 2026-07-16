import assert from 'node:assert/strict';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { validateAutomaticPriceChange } from '../src/services/price/price-sync.service';

test('allows an automatic price change within the configured threshold', () => {
  const result = validateAutomaticPriceChange({
    triggeredBy: 'PRODUCT_PRICE_UPDATE',
    currentPrice: new Prisma.Decimal(100),
    targetPrice: 115,
    maxChangePercent: 20,
  });
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, false);
});

test('blocks a large automatic price change', () => {
  const result = validateAutomaticPriceChange({
    triggeredBy: 'COMPETITOR_AUTO',
    currentPrice: new Prisma.Decimal(100),
    targetPrice: 70,
    maxChangePercent: 20,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /30.00%/);
});

test('manual price changes bypass the percentage guard', () => {
  const result = validateAutomaticPriceChange({
    triggeredBy: 'MANUAL',
    currentPrice: new Prisma.Decimal(100),
    targetPrice: 40,
    maxChangePercent: 20,
  });
  assert.equal(result.ok, true);
});

test('identical price is skipped before reaching PrestaShop', () => {
  const result = validateAutomaticPriceChange({
    triggeredBy: 'COMPETITOR_AUTO',
    currentPrice: new Prisma.Decimal('99.99'),
    targetPrice: 99.99,
    maxChangePercent: 20,
  });
  assert.equal(result.ok, true);
  assert.equal(result.unchanged, true);
});
