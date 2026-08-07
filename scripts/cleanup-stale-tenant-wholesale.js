/**
 * Jednorazowa dezaktywacja hurtowni starego tenanta `default-tenant-id`
 * (Godan, PartyDeco sprzed migracji multi-tenant). Zywe odpowiedniki istnieja
 * pod tenantem Kreatywne Papierki i synchronizuja sie na biezaco.
 *
 * Dla kazdego providera starego tenanta: syncEnabled=false + isActive=false
 * (scheduler przestaje go planowac), usuniecie jego wholesale_product_mappings
 * i wpisow staging/sync-log. Providerow tenanta glownego nie dotyka.
 *
 * Uruchomienie w kontenerze API (wczesniej pg_dump do /root/db-backups/):
 *   node /app/scripts/cleanup-stale-tenant-wholesale.js            # dry-run
 *   node /app/scripts/cleanup-stale-tenant-wholesale.js --apply    # zapis
 * Po --apply proces ubic recznie (BullMQ trzyma polaczenie).
 */
const prisma = require('/app/dist/lib/prisma').default;

const APPLY = process.argv.includes('--apply');
const STALE_TENANT = 'default-tenant-id';

async function main() {
  const providers = await prisma.wholesaleProvider.findMany({
    where: { tenantId: STALE_TENANT },
    include: {
      _count: { select: { mappings: true, syncLogs: true } },
    },
  });

  console.log(`Tryb: ${APPLY ? 'ZAPIS' : 'DRY-RUN'}; hurtownie starego tenanta: ${providers.length}\n`);

  for (const provider of providers) {
    console.log(`${APPLY ? 'DEZAKTYWACJA' : 'DO DEZAKTYWACJI'}  ${provider.name} (${provider.id})  mapowania=${provider._count.mappings}, logi=${provider._count.syncLogs}, aktywny=${provider.isActive}`);
    if (!APPLY) continue;

    const [mappings, logs] = await prisma.$transaction([
      prisma.wholesaleProductMapping.deleteMany({ where: { providerId: provider.id } }),
      prisma.wholesaleSyncLog.deleteMany({ where: { providerId: provider.id } }),
      prisma.wholesaleProvider.update({
        where: { id: provider.id },
        data: { isActive: false, syncEnabled: false },
      }),
    ]);
    console.log(`  usunieto mapowan=${mappings.count}, logow=${logs.count}`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
