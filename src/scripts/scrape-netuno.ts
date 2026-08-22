/**
 * Odswieza feed hurtowni Netuno: scrapuje kategorie, zapisuje CSV na dysk
 * i (opcjonalnie) wyzwala sync providera, ktory ten plik czyta.
 *
 * Netuno nie ma feedu ani API - dane pochodza z kart produktow, dlatego CSV
 * musi powstac ZANIM ruszy sync. Uruchamiany cyklicznie (raz na kilka dni).
 *
 * Uzycie:
 *   npx tsx src/scripts/scrape-netuno.ts
 *   npx tsx src/scripts/scrape-netuno.ts --category https://netuno.pl/koperty-11 --sync
 *   npx tsx src/scripts/scrape-netuno.ts --provider <id> --sync
 *   npx tsx src/scripts/scrape-netuno.ts --limit 20 --out /tmp/test.csv   # szybki test
 *
 * Na produkcji (w kontenerze nie ma tsx): node dist/scripts/scrape-netuno.js
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import prisma from '../lib/prisma';
import { config } from '../config';
import { buildNetunoCsv, scrapeNetunoCategory } from '../services/admin/wholesale/netuno-scraper';
import { syncWholesaleProviderForTenant } from '../services/admin/wholesale.service';

const DEFAULT_CATEGORY = 'https://netuno.pl/koperty-11';
const DEFAULT_FILENAME = 'netuno-koperty.csv';

/** Minimalny udzial poprawnych pozycji - ponizej tego nie nadpisujemy feedu. */
const MIN_SUCCESS_RATIO = 0.9;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function resolveOutputPath() {
  const explicit = argValue('--out');
  if (explicit) return path.resolve(explicit);

  const storageRoot = path.isAbsolute(config.storage.path)
    ? config.storage.path
    : path.join(process.cwd(), config.storage.path);

  return path.join(storageRoot, 'wholesale', DEFAULT_FILENAME);
}

async function resolveProvider() {
  const providerId = argValue('--provider');
  if (providerId) {
    const provider = await prisma.wholesaleProvider.findUnique({ where: { id: providerId } });
    if (!provider) throw new Error(`Provider ${providerId} nie istnieje`);
    return provider;
  }

  const candidates = await prisma.wholesaleProvider.findMany({
    where: { name: { contains: 'netuno', mode: 'insensitive' } },
  });

  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `Znaleziono ${candidates.length} providerów pasujących do "netuno" - wskaż konkretny przez --provider <id>`,
    );
  }
  return candidates[0];
}

async function main() {
  const categoryUrl = argValue('--category') ?? DEFAULT_CATEGORY;
  const limit = argValue('--limit') ? Number(argValue('--limit')) : undefined;
  const delayMs = argValue('--delay') ? Number(argValue('--delay')) : undefined;
  const outputPath = resolveOutputPath();
  const shouldSync = hasFlag('--sync');

  console.log(`Kategoria: ${categoryUrl}`);
  console.log(`Plik wyjściowy: ${outputPath}`);

  const result = await scrapeNetunoCategory(categoryUrl, {
    limit,
    delayMs,
    onProgress: (done, total) => {
      if (done % 100 === 0 || done === total) console.log(`  ${done}/${total}`);
    },
  });

  const successRatio = result.visited > 0 ? result.products.length / result.visited : 0;
  console.log('');
  console.log(`Pobrane karty:      ${result.visited}${result.declared ? ` (kategoria deklaruje ${result.declared})` : ''}`);
  console.log(`Poprawne pozycje:   ${result.products.length}`);
  console.log(`Nieudane:           ${result.failed.length}`);
  console.log(`Duplikaty indeksów: ${result.duplicates.length}`);

  if (result.failed.length) {
    console.log('\nPrzykładowe błędy:');
    result.failed.slice(0, 5).forEach((item) => console.log(`  ${item.url} -> ${item.error}`));
  }

  if (result.duplicates.length) {
    console.log('\nTen sam indeks na kilku produktach (błąd danych Netuno, zostaje pierwszy):');
    result.duplicates.slice(0, 5).forEach((item) => {
      console.log(`  ${item.reference}`);
      item.urls.forEach((url) => console.log(`    ${url}`));
    });
  }

  // Nadpisanie feedu ubogim wynikiem wyzerowaloby stany w magazynie, wiec
  // przy masowych bledach przerywamy przed zapisem - stary plik zostaje.
  if (successRatio < MIN_SUCCESS_RATIO) {
    throw new Error(
      `Za duzo nieudanych pozycji (${Math.round(successRatio * 100)}% poprawnych, wymagane ${MIN_SUCCESS_RATIO * 100}%) - feed NIE zostal nadpisany`,
    );
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, buildNetunoCsv(result.products), 'utf8');
  console.log(`\nZapisano feed: ${outputPath}`);

  if (!shouldSync) {
    console.log('\nPominięto sync (dodaj --sync, żeby od razu zaciągnąć feed do magazynu).');
    return;
  }

  const provider = await resolveProvider();
  if (!provider) {
    console.log('\nNie znalazłem providera Netuno - sync pominięty.');
    console.log('Utwórz go skryptem: npx tsx src/scripts/setup-netuno-provider.ts');
    return;
  }

  console.log(`\nWyzwalam sync providera: ${provider.name} (${provider.id})`);
  const log = await syncWholesaleProviderForTenant(provider.id, provider.tenantId);
  console.log(`Sync zakolejkowany, status: ${log.status}, log: ${log.id}`);
}

main()
  .catch((error) => {
    console.error('\nBŁĄD:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
