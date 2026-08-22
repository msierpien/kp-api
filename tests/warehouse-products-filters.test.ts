import './helpers/test-env';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildProductsOrderBy, buildProductsWhere } from '../src/services/admin/warehouse-products.service';

/**
 * Filtry listy produktow decyduja o tym, co wpada do masowek i do kreatora
 * czyszczenia - zbyt szeroki zbior to skasowane produkty. Testy pilnuja regul,
 * ktore latwo po cichu zepsuc przy dokladaniu kolejnego wymiaru.
 */

const TENANT = 'tenant-1';

function conditions(where: any): any[] {
  return where.AND ?? [];
}

function findCondition(where: any, predicate: (item: any) => boolean) {
  return conditions(where).find(predicate);
}

describe('buildProductsWhere — archiwum', () => {
  it('domyślnie ukrywa zarchiwizowane', () => {
    assert.deepEqual(buildProductsWhere({}, TENANT).archivedAt, null);
  });

  it('pokazuje wyłącznie archiwum na żądanie', () => {
    assert.deepEqual(buildProductsWhere({ archiveStatus: 'archived' }, TENANT).archivedAt, { not: null });
  });

  it('nie filtruje po archiwum przy archiveStatus=all', () => {
    assert.equal('archivedAt' in buildProductsWhere({ archiveStatus: 'all' }, TENANT), false);
  });
});

describe('buildProductsWhere — kontekst sklepu', () => {
  it('sam shopId zawęża listę do produktów tego sklepu', () => {
    const where = buildProductsWhere({ shopId: 'shop-1' }, TENANT);
    const mapping = findCondition(where, (item) => item.shopProductMappings?.some);
    assert.deepEqual(mapping.shopProductMappings.some, { isActive: true, shopId: 'shop-1' });
  });

  it('shopScope=all zdejmuje zawężenie, zostawiając kontekst', () => {
    const where = buildProductsWhere({ shopId: 'shop-1', shopScope: 'all' }, TENANT);
    assert.equal(findCondition(where, (item) => item.shopProductMappings), undefined);
  });

  it('hasShopMapping=false znaczy „bez mapowania do tego sklepu”', () => {
    const where = buildProductsWhere({ shopId: 'shop-1', hasShopMapping: false }, TENANT);
    const mapping = findCondition(where, (item) => item.shopProductMappings?.none);
    assert.deepEqual(mapping.shopProductMappings.none, { isActive: true, shopId: 'shop-1' });
  });
});

describe('buildProductsWhere — hurtownie', () => {
  it('lista wielokrotna ma pierwszeństwo przed pojedynczą hurtownią', () => {
    const where = buildProductsWhere(
      { wholesaleProviderId: 'godan', wholesaleProviderIds: ['party-deco', 'belbal'] },
      TENANT,
    );
    const offer = findCondition(where, (item) => item.wholesaleMappings?.some);
    assert.deepEqual(offer.wholesaleMappings.some.providerId, { in: ['party-deco', 'belbal'] });
  });

  it('„stan 0” przy wybranej hurtowni dotyczy tylko jej oferty', () => {
    const where = buildProductsWhere(
      { wholesaleProviderId: 'godan', wholesaleStockStatus: 'unavailable' },
      TENANT,
    );
    const hasOffer = findCondition(where, (item) => item.wholesaleMappings?.some);
    const noStock = findCondition(where, (item) => item.wholesaleMappings?.none);
    assert.deepEqual(hasOffer.wholesaleMappings.some.providerId, { in: ['godan'] });
    assert.deepEqual(noStock.wholesaleMappings.none.providerId, { in: ['godan'] });
    assert.deepEqual(noStock.wholesaleMappings.none.lastKnownStock, { gt: 0 });
  });
});

describe('buildProductsWhere — zakresy', () => {
  it('przekłada widełki ceny zakupu na gte/lte', () => {
    const where = buildProductsWhere({ purchasePriceMin: 5, purchasePriceMax: 20 }, TENANT);
    const range = findCondition(where, (item) => item.purchasePrice);
    assert.deepEqual(range.purchasePrice, { gte: 5, lte: 20 });
  });

  it('sama górna granica nie dokłada dolnej', () => {
    const where = buildProductsWhere({ retailPriceMax: 99 }, TENANT);
    const range = findCondition(where, (item) => item.retailPrice);
    assert.deepEqual(range.retailPrice, { lte: 99 });
  });

  it('pusty zakres nie tworzy warunku', () => {
    const where = buildProductsWhere({}, TENANT);
    assert.equal(findCondition(where, (item) => item.purchasePrice), undefined);
  });
});

describe('buildProductsWhere — filtry łączą się przez AND', () => {
  it('hurtownia, stan w sklepie i brak sprzedaży nie nadpisują się nawzajem', () => {
    const where = buildProductsWhere(
      {
        wholesaleProviderId: 'godan',
        wholesaleStockStatus: 'unavailable',
        shopStatus: 'inactive',
        noSalesSinceMonths: 6,
      },
      TENANT,
    );
    const all = conditions(where);
    assert.ok(all.some((item) => item.wholesaleMappings?.some));
    assert.ok(all.some((item) => item.wholesaleMappings?.none));
    assert.ok(all.some((item) => item.shopProductMappings?.some?.externalActive === false));
    assert.ok(all.some((item) => item.orderItems?.none));
  });
});

describe('buildProductsOrderBy', () => {
  it('bez wyboru sortuje po nazwie rosnąco', () => {
    assert.deepEqual(buildProductsOrderBy(undefined, undefined), { name: 'asc' });
  });

  it('puste ceny lądują na końcu niezależnie od kierunku', () => {
    assert.deepEqual(buildProductsOrderBy('purchasePrice', 'desc'), {
      purchasePrice: { sort: 'desc', nulls: 'last' },
    });
    assert.deepEqual(buildProductsOrderBy('retailPrice', 'asc'), {
      retailPrice: { sort: 'asc', nulls: 'last' },
    });
  });

  it('liczba sklepów i hurtowni sortuje się po liczności relacji', () => {
    assert.deepEqual(buildProductsOrderBy('shopCount', 'desc'), { shopProductMappings: { _count: 'desc' } });
    assert.deepEqual(buildProductsOrderBy('wholesaleCount', 'asc'), { wholesaleMappings: { _count: 'asc' } });
  });

  it('nieznany kierunek traktuje jak rosnąco', () => {
    assert.deepEqual(buildProductsOrderBy('sku', undefined), { sku: 'asc' });
  });
});
