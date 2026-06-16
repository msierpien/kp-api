import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCategoryXml, buildPrestaShopOrdersQuery } from '../src/services/prestashop/prestashop-client';

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

  it('builds category XML with parent, localized fields, and slug fallback', () => {
    const xml = buildCategoryXml({
      name: 'Balony foliowe różowe',
      parentId: '12',
      active: true,
      description: 'Opis <strong>SEO</strong>',
      metaTitle: 'Balony i dekoracje',
      metaDescription: 'Krótki opis kategorii',
      languageId: 1,
    });

    assert.match(xml, /<id_parent>12<\/id_parent>/);
    assert.match(xml, /<active>1<\/active>/);
    assert.match(xml, /<language id="1"><!\[CDATA\[Balony foliowe różowe\]\]><\/language>/);
    assert.match(xml, /<language id="1"><!\[CDATA\[balony-foliowe-rozowe\]\]><\/language>/);
    assert.match(xml, /<!\[CDATA\[Opis <strong>SEO<\/strong>\]\]>/);
  });

  it('uses explicit category link rewrite when provided', () => {
    const xml = buildCategoryXml({
      name: 'Kategoria testowa',
      parentId: 2,
      active: false,
      linkRewrite: 'wlasny-adres',
      languageId: '2',
    });

    assert.match(xml, /<id_parent>2<\/id_parent>/);
    assert.match(xml, /<active>0<\/active>/);
    assert.match(xml, /<language id="2"><!\[CDATA\[wlasny-adres\]\]><\/language>/);
  });
});
