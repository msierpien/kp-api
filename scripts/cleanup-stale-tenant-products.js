/**
 * Jednorazowe usuniecie zdublowanych produktow magazynowych starego tenanta
 * `default-tenant-id`. Duplikat = produkt, ktorego SKU istnieje tez pod
 * tenantem docelowym (KEEP_TENANT). Tenant, zamowienia i szablony zostaja.
 *
 * Produkt jest tylko dezaktywowany (nie usuwany), gdy cokolwiek go blokuje:
 *  - warehouse_reservations (onDelete: Restrict)
 *  - warehouse_document_items (relacja wymagana, domyslny Restrict)
 *  - order_items (SetNull odpialby historie zamowien — polityka: nie ruszac)
 * Pozostale dzieci (barcodes, mapowania, ceny, logi sync) kasuja sie kaskada
 * albo SetNull-em zgodnie ze schematem.
 *
 * Produkty starego tenanta BEZ duplikatu SKU sa tylko raportowane (LEFTOVER).
 *
 * Uruchomienie w kontenerze API (wczesniej pg_dump do /root/db-backups/):
 *   node /app/scripts/cleanup-stale-tenant-products.js            # dry-run
 *   node /app/scripts/cleanup-stale-tenant-products.js --apply    # zapis
 * Po --apply proces ubic recznie (BullMQ trzyma polaczenie).
 */
const prisma = require('/app/dist/lib/prisma').default;

const APPLY = process.argv.includes('--apply');
const STALE_TENANT = 'default-tenant-id';
const KEEP_TENANT = 'cmp8b8pmu0009dwstiercwc6b';

async function main() {
  const [staleProducts, keepSkus] = await Promise.all([
    prisma.warehouseProduct.findMany({
      where: { tenantId: STALE_TENANT },
      select: {
        id: true,
        sku: true,
        name: true,
        isActive: true,
        _count: {
          select: {
            warehouseReservations: true,
            items: true,
            orderItems: true,
          },
        },
      },
      orderBy: { sku: 'asc' },
    }),
    prisma.warehouseProduct.findMany({
      where: { tenantId: KEEP_TENANT },
      select: { sku: true },
    }),
  ]);

  const keepSkuSet = new Set(keepSkus.map((p) => p.sku));
  const duplicates = staleProducts.filter((p) => keepSkuSet.has(p.sku));
  const leftovers = staleProducts.filter((p) => !keepSkuSet.has(p.sku));

  console.log(`Tryb: ${APPLY ? 'ZAPIS' : 'DRY-RUN'}`);
  console.log(`Produkty starego tenanta: ${staleProducts.length}; duplikaty SKU: ${duplicates.length}; bez duplikatu (LEFTOVER): ${leftovers.length}\n`);

  let deleted = 0;
  let deactivated = 0;
  let failed = 0;

  for (const product of duplicates) {
    const blockers = [];
    if (product._count.warehouseReservations > 0) blockers.push(`rezerwacje=${product._count.warehouseReservations}`);
    if (product._count.items > 0) blockers.push(`pozycje_dok=${product._count.items}`);
    if (product._count.orderItems > 0) blockers.push(`pozycje_zam=${product._count.orderItems}`);

    if (blockers.length > 0) {
      if (APPLY) {
        await prisma.warehouseProduct.update({
          where: { id: product.id },
          data: { isActive: false, isStockTracked: false },
        });
      }
      deactivated += 1;
      console.log(`${APPLY ? 'DEZAKTYWOWANY' : 'DO DEZAKTYWACJI'}  ${product.sku}  (${blockers.join(', ')})`);
      continue;
    }

    if (!APPLY) {
      deleted += 1;
      continue;
    }
    try {
      await prisma.warehouseProduct.delete({ where: { id: product.id } });
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.log(`BLAD USUWANIA  ${product.sku}  ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }

  console.log(`\n${APPLY ? 'Usunieto' : 'Do usuniecia'}: ${deleted}; ${APPLY ? 'dezaktywowano' : 'do dezaktywacji'}: ${deactivated}; bledy: ${failed}`);

  if (leftovers.length > 0) {
    console.log(`\nLEFTOVER (bez duplikatu pod ${KEEP_TENANT} — decyzja osobno, nic nie robiono):`);
    for (const product of leftovers) {
      console.log(`  ${product.sku}  ${product.name}${product.isActive ? '' : '  [nieaktywny]'}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
