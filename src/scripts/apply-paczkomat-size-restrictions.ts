import { ShopPlatform } from '@prisma/client';
import prisma from '../lib/prisma';
import { decrypt } from '../lib/encryption';
import { PrestaShopClient, type PrestaShopCarrierDetails } from '../services/prestashop/prestashop-client';

type Args = {
  shopId?: string;
  shopName?: string;
  sku?: string;
  externalProductId?: string;
  thresholdCm: number;
  apply: boolean;
  allMapped: boolean;
  limit?: number;
};

type ResultStatus = 'UPDATED' | 'WOULD_UPDATE' | 'UNCHANGED' | 'SKIPPED' | 'FAILED';

function parseArgs(argv: string[]): Args {
  const args: Args = {
    shopName: 'Kreatywne-party',
    thresholdCm: 62,
    apply: false,
    allMapped: false,
  };

  for (const raw of argv) {
    if (raw === '--apply') {
      args.apply = true;
      continue;
    }
    if (raw === '--dry-run') {
      args.apply = false;
      continue;
    }
    if (raw === '--all-mapped') {
      args.allMapped = true;
      continue;
    }

    const [key, value = ''] = raw.split('=');
    if (key === '--shop-id') args.shopId = value.trim();
    if (key === '--shop-name') args.shopName = value.trim();
    if (key === '--sku') args.sku = value.trim();
    if (key === '--external-product-id') args.externalProductId = value.trim();
    if (key === '--threshold-cm') {
      const threshold = Number(value.replace(',', '.'));
      if (Number.isFinite(threshold) && threshold > 0) args.thresholdCm = threshold;
    }
    if (key === '--limit') {
      const limit = Number(value);
      if (Number.isInteger(limit) && limit > 0) args.limit = limit;
    }
  }

  if (!args.allMapped && !args.sku && !args.externalProductId) {
    throw new Error('Podaj --all-mapped, --sku=... albo --external-product-id=...');
  }

  return args;
}

function sameIds(left: string[], right: string[]) {
  const normalize = (ids: string[]) => [...new Set(ids.map(String))].sort();
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function isLockerCarrier(carrier: PrestaShopCarrierDetails) {
  const haystack = `${carrier.name} ${carrier.moduleName ?? ''}`.toLowerCase();
  return /paczkomat|locker/.test(haystack);
}

function buildClient(shop: { baseUrl: string; apiKey: string; configJson: unknown }) {
  const config = (shop.configJson || {}) as {
    authType?: string;
    adminApi?: { clientId: string; clientSecret: string; scopes: string[] };
  };

  return new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey: decrypt(shop.apiKey),
    authType: config.authType === 'ADMIN_API' ? 'ADMIN_API' : 'WEB_SERVICE',
    adminApiConfig: config.authType === 'ADMIN_API' ? config.adminApi : undefined,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const shop = await prisma.shop.findFirst({
    where: {
      platform: ShopPlatform.PRESTASHOP,
      status: 'ACTIVE',
      ...(args.shopId ? { id: args.shopId } : { name: args.shopName }),
    },
  });

  if (!shop) throw new Error('Nie znaleziono aktywnego sklepu PrestaShop');

  const client = buildClient(shop);
  const carriers = await client.fetchCarriers({ activeOnly: true, deleted: false });
  const lockerCarrierIds = carriers.filter(isLockerCarrier).map((carrier) => carrier.id);
  const nonLockerCarrierIds = carriers.filter((carrier) => !lockerCarrierIds.includes(carrier.id)).map((carrier) => carrier.id);

  if (lockerCarrierIds.length === 0) throw new Error('Nie znaleziono aktywnego carriera Paczkomatu');
  if (nonLockerCarrierIds.length === 0) throw new Error('Nie znaleziono aktywnego carriera alternatywnego dla produktów ponadgabarytowych');

  const mappings = await prisma.shopProductMapping.findMany({
    where: {
      shopId: shop.id,
      isActive: true,
      externalProductId: args.externalProductId ? args.externalProductId : { not: '' },
      ...(args.sku
        ? {
          OR: [
            { externalSku: args.sku },
            { warehouseProduct: { sku: args.sku } },
          ],
        }
        : {}),
    },
    include: { warehouseProduct: { select: { sku: true, name: true } } },
    orderBy: { externalProductId: 'asc' },
    ...(args.limit ? { take: args.limit } : {}),
  });

  const counts: Record<ResultStatus, number> = {
    UPDATED: 0,
    WOULD_UPDATE: 0,
    UNCHANGED: 0,
    SKIPPED: 0,
    FAILED: 0,
  };

  console.log(`Sklep: ${shop.name} (${shop.id})`);
  console.log(`Prog Paczkomatu: > ${args.thresholdCm} cm`);
  console.log(`Paczkomat carrierIds: ${lockerCarrierIds.join(', ')}`);
  console.log(`Dozwolone carrierIds po wykluczeniu: ${nonLockerCarrierIds.join(', ')}`);
  console.log(`Tryb: ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Mapowania do sprawdzenia: ${mappings.length}`);

  for (const mapping of mappings) {
    const sku = mapping.warehouseProduct?.sku ?? mapping.externalSku;
    try {
      const profile = await client.getProductShippingProfile(mapping.externalProductId);
      if (profile.maxDimension === null) {
        counts.SKIPPED += 1;
        console.log(`SKIPPED ${sku} remote=${mapping.externalProductId}: brak wymiarow`);
        continue;
      }

      if (profile.maxDimension <= args.thresholdCm) {
        counts.UNCHANGED += 1;
        continue;
      }

      const currentIds = profile.carrierIds;
      const currentAllowsLocker = currentIds.length === 0 || currentIds.some((id) => lockerCarrierIds.includes(id));
      if (!currentAllowsLocker) {
        counts.UNCHANGED += 1;
        console.log(`UNCHANGED ${sku} remote=${mapping.externalProductId}: max=${profile.maxDimension} cm, Paczkomat juz wykluczony`);
        continue;
      }

      const desiredIds = currentIds.length > 0
        ? currentIds.filter((id) => !lockerCarrierIds.includes(id))
        : nonLockerCarrierIds;

      if (desiredIds.length === 0) {
        counts.FAILED += 1;
        console.log(`FAILED ${sku} remote=${mapping.externalProductId}: po wykluczeniu Paczkomatu nie zostaje zaden carrier`);
        continue;
      }

      if (sameIds(currentIds, desiredIds)) {
        counts.UNCHANGED += 1;
        continue;
      }

      const status: ResultStatus = args.apply ? 'UPDATED' : 'WOULD_UPDATE';
      if (args.apply) {
        await client.setProductCarrierRestrictions(mapping.externalProductId, desiredIds);
      }
      counts[status] += 1;
      console.log(`${status} ${sku} remote=${mapping.externalProductId}: max=${profile.maxDimension} cm, carriers ${currentIds.length ? currentIds.join(',') : 'ALL'} -> ${desiredIds.join(',')}`);
    } catch (error) {
      counts.FAILED += 1;
      console.log(`FAILED ${sku} remote=${mapping.externalProductId}: ${error instanceof Error ? error.message : 'Nieznany blad'}`);
    }
  }

  console.log('Podsumowanie:', counts);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
