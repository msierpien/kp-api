import { ShopPlatform } from '@prisma/client';
import prisma from '../lib/prisma';
import { decrypt } from '../lib/encryption';
import { buildAdminConnectorControllerUrl } from '../services/shops/prestashop-stock-client';

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

type ConnectorConfig = {
  adminConnectorUrl?: string | null;
  adminConnectorApiKey?: string | null;
  bulkStockApiKey?: string | null;
  productContentApiKey?: string | null;
  contentModuleApiKey?: string | null;
  prestashopShopId?: string | number | null;
  idShopDefault?: string | number | null;
  prestashopProductDefaults?: { idShopDefault?: string | number | null } | null;
  productCreate?: { idShopDefault?: string | number | null } | null;
};

type ConnectorCarrier = {
  id: number;
  referenceId: number;
  name: string;
  moduleName: string;
};

type ProductCarrierRestrictionProfile = {
  productId: number;
  idShop: number;
  carrierReferenceIds: number[];
  carriers: ConnectorCarrier[];
  dimensions: {
    width: number;
    height: number;
    depth: number;
    weight: number;
    maxDimension: number;
  };
};

type ConnectorResponse<T> = {
  success: boolean;
  data?: T;
  errors?: string[];
};

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

function isLockerCarrier(carrier: ConnectorCarrier) {
  const haystack = `${carrier.name} ${carrier.moduleName ?? ''}`.toLowerCase();
  return /paczkomat|locker/.test(haystack);
}

function configObject(value: unknown): ConnectorConfig {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ConnectorConfig : {};
}

function normalizeOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function secretFromConfig(config: ConnectorConfig) {
  for (const key of ['adminConnectorApiKey', 'productContentApiKey', 'contentModuleApiKey', 'bulkStockApiKey'] as const) {
    const encrypted = normalizeOptionalString(config[key]);
    if (encrypted) return decrypt(encrypted);
  }

  return null;
}

function getPrestaShopShopId(config: ConnectorConfig) {
  if (typeof config.idShopDefault === 'string' || typeof config.idShopDefault === 'number') return config.idShopDefault;
  if (typeof config.prestashopShopId === 'string' || typeof config.prestashopShopId === 'number') return config.prestashopShopId;
  if (config.prestashopProductDefaults && typeof config.prestashopProductDefaults.idShopDefault === 'string') return config.prestashopProductDefaults.idShopDefault;
  if (config.prestashopProductDefaults && typeof config.prestashopProductDefaults.idShopDefault === 'number') return config.prestashopProductDefaults.idShopDefault;
  if (config.productCreate && typeof config.productCreate.idShopDefault === 'string') return config.productCreate.idShopDefault;
  if (config.productCreate && typeof config.productCreate.idShopDefault === 'number') return config.productCreate.idShopDefault;
  return null;
}

function connectorBaseUrl(shop: { baseUrl: string }, config: ConnectorConfig) {
  const configured = normalizeOptionalString(config.adminConnectorUrl);
  if (configured) return configured;

  return `${shop.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '')}/index.php?fc=module&module=kp_adminconnector&controller=capabilities`;
}

function connectorUrl(
  shop: { baseUrl: string },
  config: ConnectorConfig,
  controller: string,
  params: Record<string, string | number> = {},
) {
  const idShop = getPrestaShopShopId(config);
  return buildAdminConnectorControllerUrl(connectorBaseUrl(shop, config), controller, {
    ...params,
    ...(idShop === null ? {} : { idShop }),
  });
}

async function connectorRequest<T>(
  shop: { baseUrl: string },
  config: ConnectorConfig,
  controller: string,
  params: Record<string, string | number>,
  init: RequestInit = {},
): Promise<T> {
  const apiKey = secretFromConfig(config);
  if (!apiKey) {
    throw new Error('Brak adminConnectorApiKey w konfiguracji sklepu');
  }

  const url = connectorUrl(shop, config, controller, params);
  if (!url) {
    throw new Error('Brak URL kp_adminconnector w konfiguracji sklepu');
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'X-Api-Key': apiKey,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) as ConnectorResponse<T> : null;
  if (!response.ok || !json?.success || json.data === undefined) {
    const message = json?.errors?.join(', ') || text.slice(0, 300) || `HTTP ${response.status}`;
    throw new Error(`kp_adminconnector ${controller}: ${message}`);
  }

  return json.data;
}

async function getProductCarrierRestrictions(
  shop: { baseUrl: string },
  config: ConnectorConfig,
  productId: string,
) {
  return connectorRequest<ProductCarrierRestrictionProfile>(shop, config, 'carrierrestrictions', {
    productId,
  });
}

async function setProductCarrierRestrictions(
  shop: { baseUrl: string },
  config: ConnectorConfig,
  productId: string,
  carrierReferenceIds: string[],
) {
  return connectorRequest<ProductCarrierRestrictionProfile>(shop, config, 'carrierrestrictions', {}, {
    method: 'POST',
    body: JSON.stringify({
      productId: Number(productId),
      carrierReferenceIds: carrierReferenceIds.map(Number),
    }),
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

  const connectorConfig = configObject(shop.configJson);
  const firstMappingForCarriers = await prisma.shopProductMapping.findFirst({
    where: {
      shopId: shop.id,
      isActive: true,
      externalProductId: { not: '' },
      ...(args.sku
        ? {
          OR: [
            { externalSku: args.sku },
            { warehouseProduct: { sku: args.sku } },
          ],
        }
        : {}),
      ...(args.externalProductId ? { externalProductId: args.externalProductId } : {}),
    },
    orderBy: { externalProductId: 'asc' },
  });
  if (!firstMappingForCarriers) throw new Error('Nie znaleziono mapowania produktu do sprawdzenia carrierow');

  const carrierProfile = await getProductCarrierRestrictions(shop, connectorConfig, firstMappingForCarriers.externalProductId);
  const carriers = carrierProfile.carriers;
  const lockerCarrierIds = carriers.filter(isLockerCarrier).map((carrier) => String(carrier.referenceId));
  const nonLockerCarrierIds = carriers.filter((carrier) => !lockerCarrierIds.includes(String(carrier.referenceId))).map((carrier) => String(carrier.referenceId));

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
  console.log(`Paczkomat carrierReferenceIds: ${lockerCarrierIds.join(', ')}`);
  console.log(`Dozwolone carrierReferenceIds po wykluczeniu: ${nonLockerCarrierIds.join(', ')}`);
  console.log(`Tryb: ${args.apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`Mapowania do sprawdzenia: ${mappings.length}`);

  for (const mapping of mappings) {
    const sku = mapping.warehouseProduct?.sku ?? mapping.externalSku;
    try {
      const profile = await getProductCarrierRestrictions(shop, connectorConfig, mapping.externalProductId);
      if (!Number.isFinite(profile.dimensions.maxDimension)) {
        counts.SKIPPED += 1;
        console.log(`SKIPPED ${sku} remote=${mapping.externalProductId}: brak wymiarow`);
        continue;
      }

      if (profile.dimensions.maxDimension <= args.thresholdCm) {
        counts.UNCHANGED += 1;
        continue;
      }

      const currentIds = profile.carrierReferenceIds.map(String);
      const currentAllowsLocker = currentIds.length === 0 || currentIds.some((id) => lockerCarrierIds.includes(id));
      if (!currentAllowsLocker) {
        counts.UNCHANGED += 1;
        console.log(`UNCHANGED ${sku} remote=${mapping.externalProductId}: max=${profile.dimensions.maxDimension} cm, Paczkomat juz wykluczony`);
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
        await setProductCarrierRestrictions(shop, connectorConfig, mapping.externalProductId, desiredIds);
      }
      counts[status] += 1;
      console.log(`${status} ${sku} remote=${mapping.externalProductId}: max=${profile.dimensions.maxDimension} cm, carrierRefs ${currentIds.length ? currentIds.join(',') : 'ALL'} -> ${desiredIds.join(',')}`);
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
