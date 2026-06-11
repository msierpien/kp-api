import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const SERVICE = readFileSync(join(ROOT, 'src/services/admin/order-returns.service.ts'), 'utf8');
const ROUTES = readFileSync(join(ROOT, 'src/routes/admin/order-returns.routes.ts'), 'utf8');

describe('order returns cancellation source rules', () => {
  it('exposes DELETE /admin/order-returns/:id for cancelling a return', () => {
    assert.match(ROUTES, /fastify\.delete<\{ Params: \{ id: string \} \}>/);
    assert.match(ROUTES, /deleteOrderReturn\(request\.params\.id\)/);
  });

  it('only allows deleting RETURN operations, not full order cancellations', () => {
    assert.match(SERVICE, /orderReturn\.type !== 'RETURN'/);
    assert.match(SERVICE, /Pełnego anulowania zamówienia nie można usunąć/);
  });

  it('blocks deletion after external iFirma or PrestaShop effects', () => {
    assert.match(SERVICE, /assertReturnHasNoExternalEffects/);
    assert.match(SERVICE, /korekta iFirma została już wystawiona/);
    assert.match(SERVICE, /refund\/order slip PrestaShop został już utworzony/);
  });

  it('undoes warehouse effects by deleting draft ZW or cancelling confirmed ZW', () => {
    assert.match(SERVICE, /deleteDocument\(orderReturn\.warehouseDocumentId\)/);
    assert.match(SERVICE, /cancelDocument\(orderReturn\.warehouseDocumentId, \{ reason \}\)/);
    assert.match(SERVICE, /keepWarehouseDocumentLink/);
  });
});
