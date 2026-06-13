import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { publishedQuantityForQueue } from '../src/services/stock/stock-sync.service';

test('allowNegativeStock returns the full requested local reservation quantity', () => {
  const source = readFileSync(join(process.cwd(), 'src/services/admin/warehouse-reservations.service.ts'), 'utf8');
  const start = source.indexOf('async function reserveQuantityForProduct');
  const end = source.indexOf('async function createActiveReservationInTx', start);
  const body = source.slice(start, end);

  assert.match(body, /if \(allowNegativeStock\)/);
  assert.match(body, /quantity: requestedQuantity/);
  assert.match(body, /source: 'LOCAL_STOCK'/);
});

test('stock sync keeps fractional quantities to three decimal places', () => {
  assert.equal(publishedQuantityForQueue(new Prisma.Decimal('2.75')), 2.75);
  assert.equal(publishedQuantityForQueue(new Prisma.Decimal('2.7554')), 2.755);
  assert.equal(publishedQuantityForQueue(new Prisma.Decimal('-4.2')), 0);
});
