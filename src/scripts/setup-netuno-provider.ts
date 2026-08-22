/**
 * Tworzy (lub aktualizuje) providera hurtowni Netuno.
 *
 * Provider jest zwyklym CSV_FEED - czyta plik, ktory zostawia scraper
 * (scripts/scrape-netuno.ts). Dlatego feedUrl wskazuje na plik lokalny
 * (file://), a nie na adres HTTP: cennik hurtowni nie ma powodu wisiec
 * publicznie pod /storage/.
 *
 * syncEnabled = false swiadomie. Scheduler dopuszcza interwal do 24 h, a feed
 * odswiezamy raz na kilka dni; sync ma ruszac PO scraperze, nie niezaleznie od
 * niego. Kolejnosc wymusza `scrape-netuno.ts --sync`.
 *
 * Uzycie:
 *   npx tsx src/scripts/setup-netuno-provider.ts                 # podglad
 *   npx tsx src/scripts/setup-netuno-provider.ts --apply
 *   npx tsx src/scripts/setup-netuno-provider.ts --apply --tenant <id>
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../config';
import { buildProviderConfig } from '../services/admin/wholesale/shared';

const PROVIDER_NAME = 'Netuno';
const DEFAULT_FILENAME = 'netuno-koperty.csv';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveFeedUrl() {
  const explicit = argValue('--feed');
  if (explicit) return explicit.startsWith('file://') ? explicit : pathToFileURL(path.resolve(explicit)).href;

  const storageRoot = path.isAbsolute(config.storage.path)
    ? config.storage.path
    : path.join(process.cwd(), config.storage.path);

  return pathToFileURL(path.join(storageRoot, 'wholesale', DEFAULT_FILENAME)).href;
}

async function resolveTenantId() {
  const explicit = argValue('--tenant');
  if (explicit) {
    const tenant = await prisma.tenant.findUnique({ where: { id: explicit } });
    if (!tenant) throw new Error(`Tenant ${explicit} nie istnieje`);
    return tenant.id;
  }

  const tenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  if (tenants.length === 0) throw new Error('Brak tenantów w bazie');
  if (tenants.length > 1) {
    const list = tenants.map((tenant) => `  ${tenant.id}  ${tenant.name}`).join('\n');
    throw new Error(`Jest ${tenants.length} tenantów - wskaż konkretny przez --tenant <id>:\n${list}`);
  }
  return tenants[0].id;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const tenantId = await resolveTenantId();
  const feedUrl = resolveFeedUrl();

  const providerConfig = buildProviderConfig({
    name: PROVIDER_NAME,
    feedUrl,
    preset: 'NETUNO',
    availabilityRule: 'STOCK_ONLY',
  });

  const existing = await prisma.wholesaleProvider.findFirst({
    where: { tenantId, name: { equals: PROVIDER_NAME, mode: 'insensitive' } },
  });

  console.log(`Tenant:   ${tenantId}`);
  console.log(`Provider: ${PROVIDER_NAME} (${existing ? `istnieje: ${existing.id}` : 'nowy'})`);
  console.log(`feedUrl:  ${feedUrl}`);
  console.log(`preset:   ${providerConfig.preset}`);
  console.log('mapowanie kolumn:');
  Object.entries(providerConfig.fieldMapping).forEach(([key, value]) => console.log(`  ${key.padEnd(22)} -> ${value}`));

  if (!apply) {
    console.log('\nPodgląd. Dodaj --apply, żeby zapisać.');
    return;
  }

  const data = {
    platform: 'CSV_FEED' as const,
    feedUrl,
    configJson: providerConfig as unknown as Prisma.InputJsonValue,
    // Sync wyzwala scraper (--sync), nie scheduler - patrz naglowek pliku.
    syncEnabled: false,
    syncInterval: 1440,
    isActive: true,
  };

  const provider = existing
    ? await prisma.wholesaleProvider.update({ where: { id: existing.id }, data })
    : await prisma.wholesaleProvider.create({ data: { ...data, tenantId, name: PROVIDER_NAME } });

  console.log(`\n${existing ? 'Zaktualizowano' : 'Utworzono'} providera: ${provider.id}`);
  console.log('\nDalej:');
  console.log('  1. npx tsx src/scripts/scrape-netuno.ts --sync');
  console.log('  2. w panelu: Integracje -> hurtownie -> Netuno -> automatyczne mapowanie (tryb sku_ean)');
}

main()
  .catch((error) => {
    console.error('\nBŁĄD:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
