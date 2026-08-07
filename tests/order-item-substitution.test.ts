import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const SERVICE = readFileSync(join(ROOT, 'src/services/admin/order-item-substitution.service.ts'), 'utf8');
const ROUTES = readFileSync(join(ROOT, 'src/routes/admin/orders.routes.ts'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'src/schemas/admin.schema.ts'), 'utf8');
const PRISMA = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
const PS_CLIENT = readFileSync(join(ROOT, 'src/services/prestashop/prestashop-client.ts'), 'utf8');

describe('order item substitution', () => {
  it('exposes preview and execute endpoints for a single order item', () => {
    assert.match(ROUTES, /'\/:id\/items\/:itemId\/substitute\/preview'/);
    assert.match(ROUTES, /'\/:id\/items\/:itemId\/substitute'/);
    assert.match(ROUTES, /substitutionService\.previewOrderItemSubstitution\(/);
    assert.match(ROUTES, /substitutionService\.substituteOrderItem\(/);
  });

  it('accepts only the target product, reason and shop-note flag - price and quantity stay untouched', () => {
    assert.match(SCHEMA, /export const substituteOrderItemSchema = z\.object\(\{[\s\S]*?warehouseProductId: z\.string\(\)\.min\(1\)/);
    assert.match(SCHEMA, /notifyShop: z\.boolean\(\)\.default\(true\)/);
    assert.doesNotMatch(SCHEMA, /export const substituteOrderItemSchema = z\.object\(\{[\s\S]*?quantity/);
    assert.doesNotMatch(SERVICE, /unitPriceTaxIncl:/);
    assert.doesNotMatch(SERVICE, /totalPriceTaxIncl:/);
  });

  it('blocks substitution once the goods left the warehouse or were invoiced', () => {
    assert.match(SERVICE, /BLOCKED_ORDER_STATUSES = new Set\(\['SHIPPED', 'DELIVERED', 'CANCELLED', 'PARTIALLY_RETURNED', 'RETURNED'\]\)/);
    assert.match(SERVICE, /code: 'CONFIRMED_WZ'/);
    assert.match(SERVICE, /code: 'ISSUED_INVOICE'/);
    assert.match(SERVICE, /code: 'RETURNED_ITEM'/);
    assert.match(SERVICE, /code: 'BUNDLE_COMPONENT'/);
    assert.match(SERVICE, /if \(blockers\.length > 0\) \{\s*throw new Error/);
  });

  it('re-issues a draft WZ and recalculates reservations after the swap', () => {
    assert.match(SERVICE, /await cancelDocument\(draftWz\.id/);
    assert.match(SERVICE, /const reservation = await reserveOrder\(item\.orderId\)/);
    assert.match(SERVICE, /createWzForOrder\(item\.orderId, hadWz \? \{ saveAsDraft: true \} : \{\}\)/);
  });

  it('keeps the original snapshot across repeated substitutions', () => {
    assert.match(SERVICE, /substitutedFromSku: item\.isSubstituted \? item\.substitutedFromSku : previousSku/);
    assert.match(SERVICE, /substitutedFromName: item\.isSubstituted \? item\.substitutedFromName : previousName/);
  });

  it('records the substitution on the order item', () => {
    assert.match(PRISMA, /isSubstituted\s+Boolean\s+@default\(false\) @map\("is_substituted"\)/);
    assert.match(PRISMA, /substitutedFromSku\s+String\?\s+@map\("substituted_from_sku"\)/);
    assert.match(PRISMA, /substitutionReason\s+String\?\s+@map\("substitution_reason"\)/);
  });

  it('writes a private note to the shop without failing the substitution', () => {
    assert.match(PS_CLIENT, /async addOrderNote\(input: \{/);
    assert.match(PS_CLIENT, /private: true,/);
    assert.match(SERVICE, /catch \(error\) \{\s*return \{\s*status: 'FAILED'/);
  });
});
