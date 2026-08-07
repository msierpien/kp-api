/**
 * Jednorazowo: import produktow ze sklepu Kreatywne-papierki i utworzenie
 * produktu magazynowego z mapowania 'zap-g' (zaproszenie z golebica, PS id 517)
 * w katalogu "Kreatywne Papierki", bez sledzenia stanow.
 *
 * Kontekst tenanta jest podstawiany przez monkeypatch getTenantId (skrypt
 * dziala poza HTTP). Uruchomienie w kontenerze API:
 *   node /app/scripts/import-kp-shop-and-map-zapg.js            # dry-run (tylko podglad stanu)
 *   node /app/scripts/import-kp-shop-and-map-zapg.js --apply    # import + utworzenie produktu
 * Po --apply proces ubic recznie, jesli nie zakonczy sie sam (BullMQ).
 */
const prisma = require('/app/dist/lib/prisma').default;
const tenantContext = require('/app/dist/lib/tenant-context');

const TENANT_ID = 'cmp8b8pmu0009dwstiercwc6b';
const SHOP_ID = 'cmscv7k7l0001h4khpd8arr5i';
const CATALOG_ID = 'cmscxcz2t00018rctjgbte5su';
const PARENT_SKU = 'zap-g';
const APPLY = process.argv.includes('--apply');

tenantContext.getTenantId = () => TENANT_ID;
tenantContext.getTenantContext = () => ({ tenantId: TENANT_ID, userId: 'script', role: 'ADMIN' });

async function main() {
  const importService = require('/app/dist/services/admin/shop-product-import.service');

  if (!APPLY) {
    const existing = await prisma.shopProductMapping.findFirst({
      where: { shopId: SHOP_ID, externalSku: PARENT_SKU },
    });
    console.log(`DRY-RUN. Mapowanie ${PARENT_SKU}: ${existing ? existing.id : 'brak — import je utworzy'}`);
    await prisma.$disconnect();
    return;
  }

  console.log('Import produktow ze sklepu...');
  const result = await importService.importProductsFromShop(SHOP_ID, { activeOnly: true });
  console.log(`  pobrano=${result.fetched} utworzono=${result.created} zaktualizowano=${result.updated} pominieto_bez_sku=${result.skippedNoSku}`);

  const mapping = await prisma.shopProductMapping.findFirst({
    where: { shopId: SHOP_ID, externalSku: PARENT_SKU },
  });
  if (!mapping) throw new Error(`Brak mapowania ${PARENT_SKU} po imporcie`);
  console.log(`Mapowanie ${PARENT_SKU}: ${mapping.id} (external_product_id=${mapping.externalProductId}, warehouse=${mapping.warehouseProductId ?? 'brak'})`);

  if (!mapping.warehouseProductId) {
    const created = await importService.createWarehouseProductFromMapping(mapping.id, { catalogId: CATALOG_ID });
    const productId = created.warehouseProductId ?? created.warehouseProduct?.id;
    if (!productId) throw new Error('Mapowanie po utworzeniu nie ma warehouseProductId');
    console.log(`Utworzono/powiazano produkt magazynowy: ${productId}`);
    await prisma.warehouseProduct.update({
      where: { id: productId },
      data: { isStockTracked: false },
    });
    console.log('Ustawiono isStockTracked=false (produkt personalizowany na zamowienie)');
  } else {
    console.log('Mapowanie juz powiazane z produktem magazynowym');
  }

  const finalState = await prisma.shopProductMapping.findUnique({
    where: { id: mapping.id },
    include: { warehouseProduct: { select: { sku: true, name: true, catalogId: true, isStockTracked: true } } },
  });
  console.log('Stan koncowy:', JSON.stringify({
    externalSku: finalState.externalSku,
    externalName: finalState.externalName,
    product: finalState.warehouseProduct,
  }, null, 2));

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
