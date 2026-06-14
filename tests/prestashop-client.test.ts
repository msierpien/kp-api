import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildPrestaShopOrdersQuery } from '../src/services/prestashop/prestashop-client';

describe('PrestaShop client', () => {
  it('builds Webservice filters for order sync', () => {
    const query = buildPrestaShopOrdersQuery({
      limit: 25,
      dateFrom: '2026-06-01',
      dateField: 'date_upd',
      idFrom: '1291',
      currentState: 2,
    });
    const params = new URLSearchParams(query);

    assert.equal(params.get('display'), 'full');
    assert.equal(params.get('limit'), '25');
    assert.equal(params.get('sort'), '[id_ASC]');
    assert.equal(params.get('filter[date_upd]'), '>[2026-06-01]');
    assert.equal(params.get('date'), '1');
    assert.equal(params.get('filter[id]'), '[1291,]');
    assert.equal(params.get('filter[current_state]'), '[2]');
  });
});
