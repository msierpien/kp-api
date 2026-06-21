import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCategoryXml,
  buildPrestaShopOrdersQuery,
  extractProductShippingProfileFromXml,
  patchProductCarrierRestrictionsXml,
} from '../src/services/prestashop/prestashop-client';

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

  it('reads product shipping dimensions and current carrier restrictions from XML', () => {
    const profile = extractProductShippingProfileFromXml(`<?xml version="1.0"?>
<prestashop>
  <product>
    <id><![CDATA[1290]]></id>
    <reference><![CDATA[TUKST80-018]]></reference>
    <name><language id="1"><![CDATA[Tuba 80 cm]]></language></name>
    <width><![CDATA[5.000000]]></width>
    <height><![CDATA[5.000000]]></height>
    <depth><![CDATA[80.000000]]></depth>
    <weight><![CDATA[0.328200]]></weight>
    <associations>
      <carriers nodeType="carrier" api="carriers">
        <carrier><id><![CDATA[6]]></id></carrier>
      </carriers>
    </associations>
  </product>
</prestashop>`);

    assert.equal(profile.id, '1290');
    assert.equal(profile.sku, 'TUKST80-018');
    assert.equal(profile.name, 'Tuba 80 cm');
    assert.equal(profile.maxDimension, 80);
    assert.deepEqual(profile.carrierIds, ['6']);
  });

  it('patches product carrier restrictions and strips readonly product fields', () => {
    const xml = patchProductCarrierRestrictionsXml(`<?xml version="1.0"?>
<prestashop>
  <product>
    <id>1290</id>
    <manufacturer_name>Readonly</manufacturer_name>
    <quantity>0</quantity>
    <position_in_category>0</position_in_category>
    <reference>TUKST80-018</reference>
    <associations>
      <categories><category><id>595</id></category></categories>
    </associations>
  </product>
</prestashop>`, ['6']);

    assert.match(xml, /<carriers nodeType="carrier" api="carriers">/);
    assert.match(xml, /<carrier>[\s\S]*<id>6<\/id>[\s\S]*<\/carrier>/);
    assert.doesNotMatch(xml, /<manufacturer_name>/);
    assert.doesNotMatch(xml, /<quantity>/);
    assert.doesNotMatch(xml, /<position_in_category>/);
  });
});
