/// <reference lib="dom" />
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { encrypt, decrypt } from '../../lib/encryption';
import { config as appConfig } from '../../config';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors';
import type {
  CreatePrestaShopCategoryInput,
  CreateShopInput,
  PrestaShopCategoriesQueryInput,
  UpdatePrestaShopCategoryInput,
  UpdateShopInput,
} from '../../schemas/admin.schema';
import type { ShopItem, UserRole } from '../../types';
import { removeShopFromScheduler } from '../scheduler/scheduler.service';
import { getTenantContext } from '../../lib/tenant-context';
import { PrestaShopClient } from '../prestashop/prestashop-client';
import { normalizeBulkStockBatchSize } from '../shops/prestashop-stock-client';
import { assertValidOrderSyncDate, normalizeOrderSyncDate } from '../sync/order-sync-date';

type ShopTenantScopeContext = {
  tenantId?: string | null;
  role?: UserRole | null;
  overrideTenantId?: string | null;
};

export function resolveShopTenantWhereForContext(context: ShopTenantScopeContext | null): Prisma.ShopWhereInput {
  if (context?.role === 'SUPER_ADMIN') {
    return context.overrideTenantId ? { tenantId: context.overrideTenantId } : {};
  }

  if (!context?.tenantId) {
    throw new ForbiddenError('Brak kontekstu tenanta');
  }

  return { tenantId: context.tenantId };
}

export function getShopAdminWhere(id?: string): Prisma.ShopWhereInput {
  return {
    ...(id ? { id } : {}),
    ...resolveShopTenantWhereForContext(getTenantContext()),
  };
}

export async function assertShopAdminAccess(id: string) {
  const shop = await prisma.shop.findFirst({
    where: getShopAdminWhere(id),
    select: { id: true },
  });

  if (!shop) {
    throw new NotFoundError('Shop not found');
  }

  return shop;
}

const MANAGED_SHOP_CONFIG_KEYS = [
  'adminConnectorUrl',
  'adminConnectorApiKey',
  'adminConnectorEnabled',
  'bulkStockUrl',
  'bulkStockApiKey',
  'defaultLeadTimeDays',
  'bulkStockBatchSize',
  'productContentUrl',
  'productContentApiKey',
  'productContentEnabled',
] as const;

const MANAGED_SHOP_SECRET_KEYS = [
  'adminConnectorApiKey',
  'bulkStockApiKey',
  'productContentApiKey',
] as const;

const DEFAULT_ORDER_SYNC_CONFIG = {
  enabled: true,
  intervalMinutes: 10,
  orderStatus: 'ALL',
  fromDate: null as string | null,
};

const DEFAULT_ADMIN_API_CONFIG = {
  clientId: null,
  clientSecret: null,
  scopes: [],
};

function normalizeShopConfig(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {};
}

function hasOwn(value: Record<string, any>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function getRawOrderSyncFromDate(orderSync: Record<string, any>) {
  return hasOwn(orderSync, 'fromDate')
    ? orderSync.fromDate
    : orderSync.dateFrom
      ?? orderSync.syncFromDate
      ?? orderSync.startDate;
}

function normalizeOrderSyncForStorage(orderSyncInput: unknown) {
  const orderSync = normalizeShopConfig(orderSyncInput);
  if (Object.keys(orderSync).length === 0) return orderSync;

  const rawFromDate = getRawOrderSyncFromDate(orderSync);
  if (rawFromDate !== undefined || hasOwn(orderSync, 'fromDate')) {
    orderSync.fromDate = assertValidOrderSyncDate(rawFromDate, 'config.orderSync.fromDate');
  }

  return orderSync;
}

function normalizeOrderSyncStatus(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'ALL' || normalized === 'PAID' || normalized === 'CUSTOM') return normalized;
  throw new ValidationError('Nieprawidlowy zakres synchronizacji zamowien');
}

function normalizeCurrentStateIds(value: unknown): number[] {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : value === null || value === undefined
        ? []
        : [value];

  return Array.from(new Set(
    rawValues
      .map((item) => Number(String(item).trim()))
      .filter((item) => Number.isInteger(item) && item > 0),
  ));
}

function normalizeShopConfigForStorage(config: unknown, options: { encryptManagedSecrets?: boolean } = {}) {
  const configJson = normalizeShopConfig(config);
  const orderSync = normalizeOrderSyncForStorage(configJson.orderSync);
  if (Object.keys(orderSync).length > 0) {
    configJson.orderSync = orderSync;
  }

  if (options.encryptManagedSecrets !== false) {
    for (const key of MANAGED_SHOP_SECRET_KEYS) {
      if (!hasOwn(configJson, key)) continue;
      if (typeof configJson[key] !== 'string') {
        configJson[key] = null;
        continue;
      }
      const secret = configJson[key].trim();
      configJson[key] = secret ? encrypt(decrypt(secret)) : null;
    }
  }

  return configJson;
}

function publicOrderSyncConfig(orderSyncInput: unknown) {
  const orderSync = normalizeShopConfig(orderSyncInput);
  return {
    ...DEFAULT_ORDER_SYNC_CONFIG,
    ...orderSync,
    fromDate: normalizeOrderSyncDate(getRawOrderSyncFromDate(orderSync)),
  };
}

export function preserveManagedShopConfig(
  inputConfig: unknown,
  existingConfig: unknown,
): Record<string, any> {
  const next = normalizeShopConfig(inputConfig);
  const existing = normalizeShopConfig(existingConfig);
  const preservedSecrets: Partial<Record<typeof MANAGED_SHOP_SECRET_KEYS[number], unknown>> = {};

  for (const key of MANAGED_SHOP_CONFIG_KEYS) {
    if (!(key in next) && key in existing) {
      next[key] = existing[key];
      if ((MANAGED_SHOP_SECRET_KEYS as readonly string[]).includes(key)) {
        preservedSecrets[key as typeof MANAGED_SHOP_SECRET_KEYS[number]] = existing[key];
      }
    }
  }

  const nextOrderSync = normalizeShopConfig(next.orderSync);
  const existingOrderSync = normalizeShopConfig(existing.orderSync);
  if (!hasOwn(nextOrderSync, 'fromDate') && hasOwn(existingOrderSync, 'fromDate')) {
    nextOrderSync.fromDate = existingOrderSync.fromDate;
  }
  if (Object.keys(nextOrderSync).length > 0) {
    next.orderSync = nextOrderSync;
  }

  const normalized = normalizeShopConfigForStorage(next);
  for (const key of MANAGED_SHOP_SECRET_KEYS) {
    if (hasOwn(preservedSecrets, key)) {
      normalized[key] = preservedSecrets[key];
    }
  }

  return normalized;
}

function publicShopConfig(configJson: Record<string, any>) {
  const safeConfig = { ...configJson };
  delete safeConfig.bulkStockApiKey;
  delete safeConfig.productContentApiKey;
  delete safeConfig.adminConnectorApiKey;
  const adminApi = normalizeShopConfig(safeConfig.adminApi);

  return {
    ...safeConfig,
    orderSync: publicOrderSyncConfig(safeConfig.orderSync),
    adminApi: {
      ...DEFAULT_ADMIN_API_CONFIG,
      ...adminApi,
    },
  };
}

const mapShop = (shop: any): ShopItem => {
  const configJson = (shop.configJson as any) || {};
  const hasAdminConnectorKey = Boolean(configJson.adminConnectorApiKey);
  const contentUrl = typeof configJson.productContentUrl === 'string' ? configJson.productContentUrl : null;
  const bulkUrl = typeof configJson.bulkStockUrl === 'string' ? configJson.bulkStockUrl : null;
  const contentUsesConnector = isAdminConnectorModuleUrl(contentUrl) || (!contentUrl && isAdminConnectorModuleUrl(configJson.adminConnectorUrl));
  const bulkUsesConnector = isAdminConnectorModuleUrl(bulkUrl) || (!bulkUrl && isAdminConnectorModuleUrl(configJson.adminConnectorUrl));
  const latestSync = Array.isArray(shop.syncLogs) ? shop.syncLogs[0] : null;
  const isManual = shop.platform === 'MANUAL';
  const hasError = latestSync?.status === 'FAILED';
  return {
    id: shop.id,
    name: shop.name,
    platform: shop.platform,
    baseUrl: shop.baseUrl,
    status: shop.status,
    lastSyncAt: shop.lastSyncAt,
    apiKey: decrypt(shop.apiKey),
    apiSecret: shop.apiSecret ? decrypt(shop.apiSecret) : null,
    authType: configJson.authType || 'WEB_SERVICE',
    config: publicShopConfig(configJson),
    hasBulkStock: Boolean(configJson.bulkStockApiKey) || (hasAdminConnectorKey && bulkUsesConnector),
    hasProductContent: Boolean(configJson.productContentApiKey) || (hasAdminConnectorKey && contentUsesConnector),
    hasAdminConnector: hasAdminConnectorKey,
    adminConnectorUrl: typeof configJson.adminConnectorUrl === 'string' ? configJson.adminConnectorUrl : null,
    productContentUrl: typeof configJson.productContentUrl === 'string' ? configJson.productContentUrl : null,
    bulkStockUrl: typeof configJson.bulkStockUrl === 'string' ? configJson.bulkStockUrl : null,
    defaultLeadTimeDays: normalizeLeadTimeDays(configJson.defaultLeadTimeDays),
    bulkStockBatchSize: normalizeBulkStockBatchSize(configJson.bulkStockBatchSize),
    prestashopShopId: resolvePrestaShopShopId(configJson),
    health: isManual ? 'manual' : hasError ? 'error' : shop.status === 'ACTIVE' ? 'connected' : 'inactive',
    healthMessage: isManual
      ? 'Źródło ręczne'
      : hasError
        ? latestSync?.errorMessage || 'Błąd ostatniej synchronizacji'
        : shop.status === 'ACTIVE'
          ? 'Połączony'
          : 'Nieaktywny',
    latestSyncStatus: latestSync?.status ?? null,
    latestSyncError: latestSync?.errorMessage ?? null,
    ordersCount: shop._count?.orders ?? 0,
    casesCount: shop.casesCount ?? 0,
    mappingsCount: shop._count?.productMappings ?? 0,
    tenantId: shop.tenantId,
  };
};

function isAdminConnectorModuleUrl(value: unknown) {
  return typeof value === 'string' && /\bmodule=kp_adminconnector\b|\/kp_adminconnector(?:\/|$)/i.test(value);
}

function normalizeLeadTimeDays(value: unknown) {
  const days = Number(value);
  return Number.isInteger(days) && days >= 0 && days <= 365 ? days : null;
}

function resolvePrestaShopShopId(configJson: Record<string, any>) {
  if (typeof configJson.prestashopShopId === 'string' || typeof configJson.prestashopShopId === 'number') {
    return String(configJson.prestashopShopId);
  }
  if (typeof configJson.idShopDefault === 'string' || typeof configJson.idShopDefault === 'number') {
    return String(configJson.idShopDefault);
  }

  const defaults = configJson.prestashopProductDefaults;
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const id = defaults.idShopDefault;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }

  const productCreate = configJson.productCreate;
  if (productCreate && typeof productCreate === 'object' && !Array.isArray(productCreate)) {
    const id = productCreate.idShopDefault;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }

  return null;
}

export async function listShops(): Promise<ShopItem[]> {
  const shops = await prisma.shop.findMany({
    where: getShopAdminWhere(),
    include: {
      syncLogs: { orderBy: { startedAt: 'desc' }, take: 1 },
      _count: {
        select: {
          orders: true,
          productMappings: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const caseCounts = await Promise.all(
    shops.map((shop) =>
      prisma.personalizationCase.count({
        where: { order: { shopId: shop.id } },
      }),
    ),
  );

  return shops.map((shop, index) => mapShop({ ...shop, casesCount: caseCounts[index] }));
}

export async function createShop(input: CreateShopInput): Promise<ShopItem> {
  const context = getTenantContext();
  const targetTenantId = context?.role === 'SUPER_ADMIN' ? input.tenantId : context?.tenantId;

  if (!targetTenantId) {
    throw new ValidationError('Brak tenanta dla integracji');
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: targetTenantId },
    select: { id: true, status: true },
  });

  if (!tenant || tenant.status !== 'ACTIVE') {
    throw new ValidationError('Wybrany tenant nie istnieje lub jest nieaktywny');
  }

  const shop = await prisma.shop.create({
    data: {
      name: input.name,
      platform: input.platform,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey ? encrypt(input.apiKey) : '', // Szyfruj przed zapisem
      apiSecret: input.apiSecret ? encrypt(input.apiSecret) : null, // Szyfruj jeśli istnieje
      status: input.status,
      configJson: normalizeShopConfigForStorage(input.config),
      tenantId: targetTenantId,
    } as any,
  });

  return mapShop(shop);
}

export async function updateShop(id: string, input: UpdateShopInput): Promise<ShopItem> {
  const existingShop = await prisma.shop.findFirst({
    where: getShopAdminWhere(id),
    select: { configJson: true },
  });

  if (!existingShop) {
    throw new NotFoundError('Shop not found');
  }

  const shop = await prisma.shop.update({
    where: { id },
    data: {
      name: input.name,
      platform: input.platform,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey ? encrypt(input.apiKey) : '', // Szyfruj przed zapisem
      apiSecret: input.apiSecret ? encrypt(input.apiSecret) : null, // Szyfruj jeśli istnieje
      status: input.status,
      configJson: preserveManagedShopConfig(input.config || {}, existingShop.configJson),
    },
  });

  return mapShop(shop);
}

export async function updateShopOrderSyncConfig(
  id: string,
  input: { fromDate?: string | null; orderStatus?: 'ALL' | 'PAID' | 'CUSTOM'; currentStateIds?: Array<string | number> | string | null },
): Promise<ShopItem> {
  const existingShop = await prisma.shop.findFirst({
    where: getShopAdminWhere(id),
    select: { configJson: true },
  });

  if (!existingShop) {
    throw new NotFoundError('Shop not found');
  }

  const configJson = normalizeShopConfig(existingShop.configJson);
  const orderSync = normalizeShopConfig(configJson.orderSync);

  if (hasOwn(input, 'fromDate')) {
    orderSync.fromDate = assertValidOrderSyncDate(input.fromDate, 'fromDate');
  }
  if (hasOwn(input, 'orderStatus')) {
    const status = normalizeOrderSyncStatus(input.orderStatus);
    if (status) {
      orderSync.orderStatus = status;
      if (status === 'ALL') {
        orderSync.currentStateIds = [];
        delete orderSync.paidStatusIds;
        delete orderSync.currentStates;
      }
      if (status === 'PAID') {
        orderSync.currentStateIds = [];
      }
    }
  }
  if (hasOwn(input, 'currentStateIds')) {
    const ids = normalizeCurrentStateIds(input.currentStateIds);
    orderSync.currentStateIds = ids;
    if (ids.length > 0 && !hasOwn(input, 'orderStatus')) {
      orderSync.orderStatus = 'CUSTOM';
    }
  }

  const shop = await prisma.shop.update({
    where: { id },
    data: {
      configJson: normalizeShopConfigForStorage({
        ...configJson,
        orderSync,
      }, { encryptManagedSecrets: false }),
    },
  });

  return mapShop(shop);
}

export async function deleteShop(id: string): Promise<void> {
  const shop = await prisma.shop.findFirst({
    where: getShopAdminWhere(id),
    select: {
      id: true,
      syncEnabled: true,
    },
  });

  if (!shop) {
    throw new NotFoundError('Integracja nie istnieje');
  }

  if (shop.syncEnabled) {
    removeShopFromScheduler(shop.id);
  }

  await prisma.shop.delete({
    where: { id },
  });
}

export async function getShopDeletePreview(id: string) {
  const shop = await prisma.shop.findFirst({
    where: getShopAdminWhere(id),
    select: {
      id: true,
      name: true,
      platform: true,
      tenantId: true,
    },
  });

  if (!shop) {
    throw new NotFoundError('Integracja nie istnieje');
  }

  const [orders, cases, mappings, syncLogs, stockSyncLogs, priceSyncLogs] = await Promise.all([
    prisma.order.count({ where: { shopId: shop.id } }),
    prisma.personalizationCase.count({ where: { order: { shopId: shop.id } } }),
    prisma.shopProductMapping.count({ where: { shopId: shop.id, tenantId: shop.tenantId } }),
    prisma.syncLog.count({ where: { shopId: shop.id } }),
    prisma.stockSyncLog.count({ where: { shopId: shop.id, tenantId: shop.tenantId } }),
    prisma.priceSyncLog.count({ where: { shopId: shop.id, tenantId: shop.tenantId } }),
  ]);

  return {
    shop: {
      id: shop.id,
      name: shop.name,
      platform: shop.platform,
    },
    counts: {
      orders,
      cases,
      mappings,
      syncLogs,
      stockSyncLogs,
      priceSyncLogs,
    },
  };
}

export async function testShopConnection(id: string) {
  const shop = await prisma.shop.findFirst({ where: getShopAdminWhere(id) });
  if (!shop) {
    throw new NotFoundError('Shop not found');
  }

  // Odszyfruj klucze przed użyciem
  const apiKey = decrypt(shop.apiKey);

  const shopConfig = (shop.configJson as any) || {};
  const authType = shopConfig.authType || 'WEB_SERVICE';
  const started = Date.now();

  // Normalize base URL (avoid double /api when user already provided it)
  let baseUrl = shop.baseUrl.replace(/\/+$/, '');
  if (authType === 'WEB_SERVICE' && baseUrl.endsWith('/api')) {
    baseUrl = baseUrl.replace(/\/api$/, '');
  }

  const allowInsecure =
    appConfig.app.env === 'development' ||
    baseUrl.includes('localhost') ||
    baseUrl.includes('127.0.0.1');
  const shouldDisableTls = allowInsecure && baseUrl.startsWith('https://');
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (shouldDisableTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  try {
    if (authType === 'WEB_SERVICE') {
      const url = `${baseUrl}/api/orders?limit=1&output_format=JSON`;
      const authHeader = 'Basic ' + Buffer.from(`${apiKey || ''}:`).toString('base64');

      // try Authorization header
      let res = await fetch(url, {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
      });
      let body = await res.text();

      // fallback: some hosts strip Authorization; try ws_key query param
      if (!res.ok && res.status === 401) {
        const urlWithKey = `${baseUrl}/api/orders?limit=1&output_format=JSON&ws_key=${encodeURIComponent(
          apiKey || ''
        )}`;
        res = await fetch(urlWithKey, { headers: { Accept: 'application/json' } });
        body = await res.text();
      }

      return {
        ok: res.ok,
        status: res.status,
        latencyMs: Date.now() - started,
        message: res.ok
          ? 'Połączenie OK (Webservice)'
          : `Błąd Webservice: ${res.status} ${body?.slice(0, 180)}`,
      };
    }

    // ADMIN_API
    const adminApi = shopConfig.adminApi || {};
    const tokenRes = await fetch(`${baseUrl}/admin-api/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: adminApi.clientId || '',
        client_secret: adminApi.clientSecret || '',
        scope: Array.isArray(adminApi.scopes) ? adminApi.scopes.join(' ') : '',
      }),
    });

    if (!tokenRes.ok) {
      return {
        ok: false,
        status: tokenRes.status,
        latencyMs: Date.now() - started,
        message: `Błąd tokenu Admin API: ${tokenRes.status}`,
      };
    }

    const tokenJson = await tokenRes.json();
    const token = tokenJson.access_token as string | undefined;
    if (!token) {
      return {
        ok: false,
        status: 500,
        latencyMs: Date.now() - started,
        message: 'Brak access_token w odpowiedzi',
      };
    }

    const pingRes = await fetch(`${baseUrl}/admin-api/api-client/infos`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await pingRes.text();

    return {
      ok: pingRes.ok,
      status: pingRes.status,
      latencyMs: Date.now() - started,
      message: pingRes.ok
        ? 'Połączenie OK (Admin API)'
        : `Błąd Admin API: ${pingRes.status} ${body?.slice(0, 180)}`,
    };
  } catch (error) {
    return {
      ok: false,
      status: 500,
      latencyMs: Date.now() - started,
      message: error instanceof Error ? error.message : 'Nieznany błąd',
    };
  } finally {
    if (shouldDisableTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    }
  }
}

export async function getShopImportReadiness(id: string) {
  const shop = await prisma.shop.findFirst({
    where: getShopAdminWhere(id),
  });
  if (!shop) throw new NotFoundError('Sklep nie znaleziony');

  const tenantId = shop.tenantId;
  const mappingWhere = {
    shopId: shop.id,
    tenantId,
  };

  const [
    totalMappings,
    mappedMappings,
    activeMappings,
    lastImportLog,
    defaultCatalog,
  ] = await Promise.all([
    prisma.shopProductMapping.count({ where: mappingWhere }),
    prisma.shopProductMapping.count({ where: { ...mappingWhere, warehouseProductId: { not: null } } }),
    prisma.shopProductMapping.count({ where: { ...mappingWhere, isActive: true } }),
    prisma.shopProductImportLog.findFirst({
      where: mappingWhere,
      orderBy: { startedAt: 'desc' },
    }),
    prisma.warehouseCatalog.findFirst({
      where: {
        tenantId: shop.tenantId,
        isDefault: true,
      },
    }),
  ]);

  const hasApiKey = Boolean(decrypt(shop.apiKey || '').trim());
  const isSupportedPlatform = shop.platform === 'PRESTASHOP';
  const isActive = shop.status === 'ACTIVE';
  const hasDefaultCatalog = Boolean(defaultCatalog);

  return {
    shop: {
      id: shop.id,
      name: shop.name,
      platform: shop.platform,
      status: shop.status,
      lastSyncAt: shop.lastSyncAt,
    },
    ready: isSupportedPlatform && isActive && hasApiKey && hasDefaultCatalog,
    checks: {
      isSupportedPlatform,
      isActive,
      hasApiKey,
      hasDefaultCatalog,
    },
    mappings: {
      total: totalMappings,
      mapped: mappedMappings,
      unmapped: totalMappings - mappedMappings,
      active: activeMappings,
    },
    lastImportLog,
  };
}

export async function getPrestaShopCategories(id: string, query: PrestaShopCategoriesQueryInput = { activeOnly: true, tree: false }) {
  const client = await getPrestaShopCategoryClient(id);
  return client.fetchCategories({
    activeOnly: query.activeOnly,
    tree: query.tree,
    limit: query.limit,
  });
}

export async function createPrestaShopCategory(id: string, input: CreatePrestaShopCategoryInput) {
  const client = await getPrestaShopCategoryClient(id);
  return client.createCategory(input);
}

export async function updatePrestaShopCategory(id: string, categoryId: string, input: UpdatePrestaShopCategoryInput) {
  const client = await getPrestaShopCategoryClient(id);
  return client.updateCategory(categoryId, input);
}

export async function deletePrestaShopCategory(id: string, categoryId: string, options: { hard?: boolean } = {}) {
  const client = await getPrestaShopCategoryClient(id);

  if (!options.hard) {
    return client.deactivateCategory(categoryId);
  }

  const [hasChildren, hasProducts] = await Promise.all([
    client.categoryHasChildren(categoryId),
    client.categoryHasProducts(categoryId),
  ]);
  if (hasChildren) {
    throw new ValidationError('Nie można trwale usunąć kategorii, która ma podkategorie. Najpierw przenieś lub usuń podkategorie.');
  }
  if (hasProducts) {
    throw new ValidationError('Nie można trwale usunąć kategorii, która ma produkty. Użyj dezaktywacji albo przenieś produkty.');
  }

  await client.deleteCategory(categoryId);
  return { success: true, id: categoryId };
}

export async function deleteEmptyPrestaShopCategories(id: string, categoryIds: string[]) {
  const client = await getPrestaShopCategoryClient(id);
  const result = {
    requested: categoryIds.length,
    deleted: 0,
    skipped: 0,
    errors: [] as Array<{ categoryId: string; message: string }>,
  };

  for (const categoryId of Array.from(new Set(categoryIds.map((value) => String(value).trim()).filter(Boolean)))) {
    try {
      const [hasChildren, hasProducts] = await Promise.all([
        client.categoryHasChildren(categoryId),
        client.categoryHasProducts(categoryId),
      ]);

      if (hasChildren || hasProducts) {
        result.skipped++;
        result.errors.push({
          categoryId,
          message: hasChildren ? 'Kategoria ma podkategorie' : 'Kategoria ma produkty',
        });
        continue;
      }

      await client.deleteCategory(categoryId);
      result.deleted++;
    } catch (error) {
      result.skipped++;
      result.errors.push({
        categoryId,
        message: error instanceof Error ? error.message : 'Nie udało się usunąć kategorii',
      });
    }
  }

  return result;
}

export async function mergePrestaShopCategories(id: string, sourceCategoryId: string, targetCategoryId: string, options: { deleteSource?: boolean } = {}) {
  const client = await getPrestaShopCategoryClient(id);
  const source = String(sourceCategoryId).trim();
  const target = String(targetCategoryId).trim();
  if (!source || !target) throw new ValidationError('Kategorie zrodlowa i docelowa sa wymagane');
  if (source === target) throw new ValidationError('Kategorie zrodlowa i docelowa musza byc rozne');

  const moved = await client.moveProductsBetweenCategories(source, target);
  const children = await client.fetchCategories({ tree: false, limit: 5000 });
  const childCategories = children.filter((category) => category.parentId === source);

  for (const child of childCategories) {
    await client.updateCategory(child.id, { parentId: target });
  }

  let sourceDeleted = false;
  if (options.deleteSource ?? true) {
    const [hasChildren, hasProducts] = await Promise.all([
      client.categoryHasChildren(source),
      client.categoryHasProducts(source),
    ]);
    if (!hasChildren && !hasProducts) {
      await client.deleteCategory(source);
      sourceDeleted = true;
    } else {
      await client.deactivateCategory(source);
    }
  }

  return {
    success: true,
    sourceCategoryId: source,
    targetCategoryId: target,
    movedProducts: moved.moved,
    movedProductIds: moved.productIds,
    movedChildren: childCategories.length,
    sourceDeleted,
  };
}

async function getPrestaShopCategoryClient(id: string) {
  const shop = await prisma.shop.findFirst({
    where: getShopAdminWhere(id),
  });
  if (!shop) throw new NotFoundError('Sklep nie znaleziony');
  if (shop.status !== 'ACTIVE') throw new ValidationError('Sklep jest nieaktywny');
  if (shop.platform !== 'PRESTASHOP') throw new ValidationError(`Kategorie PrestaShop nie obsługują platformy ${shop.platform}`);

  const shopConfig = (shop.configJson || {}) as {
    authType?: string;
    adminApi?: { clientId: string; clientSecret: string; scopes: string[] };
  };
  const client = new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey: decrypt(shop.apiKey),
    authType: shopConfig.authType === 'ADMIN_API' ? 'ADMIN_API' : 'WEB_SERVICE',
    adminApiConfig: shopConfig.authType === 'ADMIN_API' ? shopConfig.adminApi : undefined,
  });
  return client;
}
