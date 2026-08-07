/**
 * Jednorazowe scalenie katalogow magazynowych o tej samej nazwie w ramach
 * jednego tenanta (np. kilka "Katalog glowny"). Keeper = katalog isDefault,
 * a gdy zaden nie jest domyslny — najstarszy (createdAt).
 *
 * Dla kazdego duplikatu: produkty i reguly cenowe przepinane na keepera
 * (delete katalogu kaskadowalby reguly, a produkty blokuja Restrictem),
 * potem pusty duplikat jest usuwany.
 *
 * Uruchomienie w kontenerze API (wczesniej pg_dump do /root/db-backups/):
 *   node /app/scripts/merge-duplicate-catalogs.js            # dry-run
 *   node /app/scripts/merge-duplicate-catalogs.js --apply    # zapis
 * Po --apply proces ubic recznie (BullMQ trzyma polaczenie).
 */
const prisma = require('/app/dist/lib/prisma').default;

const APPLY = process.argv.includes('--apply');

async function main() {
  const catalogs = await prisma.warehouseCatalog.findMany({
    include: { _count: { select: { products: true, pricingRules: true } } },
    orderBy: { createdAt: 'asc' },
  });

  const groups = new Map();
  for (const catalog of catalogs) {
    const key = `${catalog.tenantId}::${catalog.name.trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(catalog);
  }

  console.log(`Tryb: ${APPLY ? 'ZAPIS' : 'DRY-RUN'}\n`);

  let merged = 0;
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const keeper = group.find((c) => c.isDefault) ?? group[0];
    const duplicates = group.filter((c) => c.id !== keeper.id);

    console.log(`Grupa ${key}:`);
    console.log(`  KEEPER  ${keeper.id}  (default=${keeper.isDefault}, produkty=${keeper._count.products})`);

    for (const duplicate of duplicates) {
      console.log(`  SCALANY ${duplicate.id}  (produkty=${duplicate._count.products}, reguly=${duplicate._count.pricingRules})`);
      if (!APPLY) continue;
      await prisma.$transaction([
        prisma.warehouseProduct.updateMany({
          where: { catalogId: duplicate.id },
          data: { catalogId: keeper.id },
        }),
        prisma.warehousePricingRule.updateMany({
          where: { catalogId: duplicate.id },
          data: { catalogId: keeper.id },
        }),
        prisma.warehouseCatalog.delete({ where: { id: duplicate.id } }),
      ]);
      merged += 1;
    }
    console.log('');
  }

  console.log(`${APPLY ? 'Scalono' : 'Do scalenia'}: ${merged || [...groups.values()].filter((g) => g.length > 1).reduce((n, g) => n + g.length - 1, 0)} katalogow.`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
