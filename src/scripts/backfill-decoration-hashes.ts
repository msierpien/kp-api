/**
 * Odciski tresci dla ozdobnikow wgranych przed 2026-08-18.
 *
 * Upload rozpoznaje duplikaty po SHA-256 zapisanej tresci, ale pliki sprzed
 * tej zmiany maja `contentHash = null` - bez przeliczenia wstecz ochrona
 * zaczynalaby dzialac dopiero od nowych wgran.
 *
 * Idempotentny: rusza wylacznie wpisy bez odcisku, wiec mozna go puscic
 * ponownie po nieudanym przebiegu. Pliku, ktorego nie ma juz na dysku, nie
 * kasuje - tylko raportuje, bo decyzja o usunieciu wpisu nalezy do czlowieka.
 *
 * Uruchomienie (na serwerze, po deployu):
 *   docker compose exec api node dist/scripts/backfill-decoration-hashes.js
 * Lokalnie:
 *   pnpm tsx src/scripts/backfill-decoration-hashes.ts
 */
import fs from 'fs/promises';
import path from 'path';
import prisma from '../lib/prisma';
import { config } from '../config';
import { contentHashOf } from '../services/admin/decorations.service';

async function main() {
  const rows = await prisma.decorationAsset.findMany({
    where: { contentHash: null },
    select: { id: true, name: true, filePath: true },
  });

  console.log(`Do przeliczenia: ${rows.length}`);

  let done = 0;
  const missing: string[] = [];

  for (const row of rows) {
    try {
      const payload = await fs.readFile(path.join(config.storage.path, row.filePath));
      await prisma.decorationAsset.update({
        where: { id: row.id },
        data: { contentHash: contentHashOf(payload) },
      });
      done += 1;
    } catch {
      missing.push(`${row.name} (${row.filePath})`);
    }
  }

  console.log(`Policzono: ${done}`);

  if (missing.length > 0) {
    console.log(`\nBrak pliku na dysku dla ${missing.length} wpisow - zostaly bez odcisku:`);
    for (const item of missing) console.log('  -', item);
  }

  // Powtorzenia, ktore juz siedza w bibliotece: upload ich nie doda ponownie,
  // ale te wgrane wczesniej trzeba usunac recznie - stad zestawienie.
  const duplicates = await prisma.decorationAsset.groupBy({
    by: ['tenantId', 'contentHash'],
    where: { contentHash: { not: null } },
    _count: { _all: true },
    having: { contentHash: { _count: { gt: 1 } } },
  });

  if (duplicates.length > 0) {
    const total = duplicates.reduce((sum, group) => sum + group._count._all - 1, 0);
    console.log(`\nW bibliotece siedzi juz ${total} powtorzen w ${duplicates.length} grupach.`);
    console.log('Do wysprzatania w panelu: Personalizacja -> Ozdobniki.');
  }
}

main()
  .catch((error) => {
    console.error('BACKFILL FAILED:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
