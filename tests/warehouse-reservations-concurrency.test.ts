import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SERVICE_PATH = join(process.cwd(), 'src/services/admin/warehouse-reservations.service.ts');
const SOURCE = readFileSync(SERVICE_PATH, 'utf8');

function extractFunctionBody(name: string): string {
  const start = SOURCE.indexOf(`export async function ${name}`);
  if (start === -1) throw new Error(`Nie znaleziono funkcji ${name}`);
  const openBrace = SOURCE.indexOf('{', start);
  let depth = 0;
  for (let i = openBrace; i < SOURCE.length; i++) {
    const ch = SOURCE[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return SOURCE.slice(openBrace, i + 1);
    }
  }
  throw new Error(`Nie udało się znaleźć końca funkcji ${name}`);
}

describe('warehouse-reservations.service: idempotentność współbieżnych operacji', () => {
  it('reserveOrder lockuje zamówienie na początku transakcji', () => {
    const body = extractFunctionBody('reserveOrder');
    assert.match(body, /lockOrderForReservation\(tx,\s*orderId\)/);
  });

  it('releaseOrderReservations lockuje zamówienie na początku transakcji', () => {
    const body = extractFunctionBody('releaseOrderReservations');
    assert.match(body, /lockOrderForReservation\(tx,\s*orderId\)/);
  });

  it('createReservation lockuje zamówienie na początku transakcji', () => {
    const body = extractFunctionBody('createReservation');
    assert.match(body, /lockOrderForReservation\(tx,\s*input\.orderId\)/);
  });

  it('helper lockOrderForReservation używa pg_advisory_xact_lock z hashtextextended', () => {
    assert.match(SOURCE, /pg_advisory_xact_lock\(hashtextextended\(/);
  });

  it('klucz advisory locka jest namespace`owany prefiksem order-reservation', () => {
    assert.match(SOURCE, /order-reservation:\$\{orderId\}/);
  });
});
