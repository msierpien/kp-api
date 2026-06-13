/// <reference lib="dom" />
import prisma from '../../lib/prisma';
import { decrypt, encrypt } from '../../lib/encryption';
import { NotFoundError, ValidationError } from '../../lib/errors';
import type { CreateShopInput, UpdateShopInput } from '../../schemas/admin.schema';
import {
  assertShopAdminAccess,
  createShop,
  deleteShop,
  getPrestaShopCategories,
  getShopAdminWhere,
  getShopImportReadiness,
  getShopDeletePreview,
  listShops,
  testShopConnection,
  updateShop,
  updateShopOrderSyncConfig,
} from '../../services/admin/shops.service';
import {
  disableShopSync,
  enableShopSync,
  triggerManualSync,
  updateShopSyncInterval,
} from '../../services/scheduler/scheduler.service';
import {
  buildAdminConnectorControllerUrl,
  buildBulkStockUrl,
  DEFAULT_BULK_STOCK_BATCH_SIZE,
  MAX_BULK_STOCK_BATCH_SIZE,
  MIN_BULK_STOCK_BATCH_SIZE,
} from '../../services/shops/prestashop-stock-client';
import * as stockSyncService from '../../services/stock/stock-sync.service';
import * as shopWebhookService from '../../services/webhooks/prestashop-order-webhook.service';
import { assertValidOrderSyncDate } from '../../services/sync/order-sync-date';

type Logger = {
  error: (payload: unknown, message?: string) => void;
  info: (payload: unknown, message?: string) => void;
};

export type UpdateOrderSyncConfigInput = {
  fromDate?: string | null;
};

export type UpdateBulkStockConfigInput = {
  bulkStockUrl?: string | null;
  bulkStockApiKey?: string | null;
  defaultLeadTimeDays?: number | null;
  bulkStockBatchSize?: number | null;
};

export type ManualSyncInput = {
  wait?: string | boolean;
  fromDate?: string | null;
  fromOrderId?: string;
  limit?: number;
};

type ModuleDiagnostic = {
  key: string;
  label: string;
  configured: boolean;
  ok: boolean;
  status: 'ok' | 'warning' | 'error' | 'missing_config';
  message: string;
  latencyMs?: number;
  url?: string | null;
  httpStatus?: number;
  capabilities?: unknown;
  details?: Record<string, unknown>;
};

function normalizeOptionalString(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function secretFromConfig(value: unknown) {
  const secret = normalizeOptionalString(value);
  return secret ? decrypt(secret) : null;
}

function moduleControllerUrl(moduleUrl: string | null, controller: string) {
  if (!moduleUrl) return null;
  const trimmed = moduleUrl.replace(/\/+$/, '');

  if (!trimmed.includes('?')) {
    return `${trimmed}/${encodeURIComponent(controller)}`;
  }

  if (trimmed.includes('controller=')) {
    return trimmed.replace(/([?&]controller=)[^&]*/, `$1${encodeURIComponent(controller)}`);
  }

  return `${trimmed}&controller=${encodeURIComponent(controller)}`;
}

async function checkJsonEndpoint(input: {
  key: string;
  label: string;
  configured: boolean;
  url: string | null;
  apiKey: string | null;
  missingMessage: string;
}): Promise<ModuleDiagnostic> {
  if (!input.configured || !input.url || !input.apiKey) {
    return {
      key: input.key,
      label: input.label,
      configured: false,
      ok: false,
      status: 'missing_config',
      message: input.missingMessage,
      url: input.url,
    };
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(input.url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Api-Key': input.apiKey,
      },
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? JSON.parse(text) as Record<string, unknown> : null;
    } catch {
      json = null;
    }

    const errors = Array.isArray(json?.errors) ? json.errors.filter((item) => typeof item === 'string') : [];
    const ok = response.ok && Boolean(json) && json?.success !== false;
    return {
      key: input.key,
      label: input.label,
      configured: true,
      ok,
      status: ok ? 'ok' : 'error',
      message: ok
        ? 'Endpoint modułu odpowiada poprawnym JSON.'
        : errors[0] || `Endpoint nie zwrócił poprawnej odpowiedzi JSON modułu. HTTP ${response.status}.`,
      latencyMs: Date.now() - startedAt,
      url: input.url,
      httpStatus: response.status,
      capabilities: json?.data,
      details: ok ? undefined : { bodyPreview: text.slice(0, 400) },
    };
  } catch (error) {
    return {
      key: input.key,
      label: input.label,
      configured: true,
      ok: false,
      status: 'error',
      message: error instanceof Error ? error.message : 'Nie udało się połączyć z endpointem modułu.',
      latencyMs: Date.now() - startedAt,
      url: input.url,
      httpStatus: 0,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeBulkStockUrl(value: unknown) {
  const url = normalizeOptionalString(value);
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('URL endpointu kp_bulkstock musi być poprawnym adresem http(s)');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ValidationError('URL endpointu kp_bulkstock musi zaczynać się od http:// lub https://');
  }

  return url;
}

function normalizeOptionalLeadTimeDays(value: unknown) {
  if (value === undefined) return null;
  if (value === null || value === '') return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new ValidationError('Domyślny czas wysyłki musi być liczbą całkowitą od 0 do 365 dni');
  }
  return days;
}

export function normalizeOptionalBulkStockBatchSize(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const size = Number(value);
  if (
    !Number.isInteger(size) ||
    size < MIN_BULK_STOCK_BATCH_SIZE ||
    size > MAX_BULK_STOCK_BATCH_SIZE
  ) {
    throw new ValidationError(
      `Rozmiar paczki bulk stock musi być liczbą całkowitą od ${MIN_BULK_STOCK_BATCH_SIZE} do ${MAX_BULK_STOCK_BATCH_SIZE}`,
    );
  }
  return size;
}

async function translateShopErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'Shop not found' || message === 'Integracja nie istnieje' || message.includes('not found')) {
      throw new NotFoundError(message || 'Shop not found');
    }
    throw error;
  }
}

export const shopsUseCases = {
  list: () => listShops(),

  create: (input: CreateShopInput) => createShop(input),

  update: (id: string, input: UpdateShopInput) => updateShop(id, input),

  remove: async (id: string) => {
    await deleteShop(id);
    return {
      success: true,
      message: 'Integracja została usunięta',
    };
  },

  deletePreview: (id: string) => getShopDeletePreview(id),

  getPrestaShopCategories: (id: string) => getPrestaShopCategories(id),

  getImportReadiness: (id: string) => getShopImportReadiness(id),

  testConnection: (id: string) => testShopConnection(id),

  updateOrderSyncConfig: (id: string, input: UpdateOrderSyncConfigInput) => updateShopOrderSyncConfig(id, input),

  updateBulkStockConfig: async (id: string, input: UpdateBulkStockConfigInput, logger: Pick<Logger, 'error'>) => {
    const shop = await prisma.shop.findFirst({
      where: getShopAdminWhere(id),
      select: { id: true, configJson: true },
    });
    if (!shop) {
      throw new NotFoundError('Sklep nie znaleziony');
    }

    const existing = (shop.configJson && typeof shop.configJson === 'object' && !Array.isArray(shop.configJson))
      ? shop.configJson as Record<string, unknown>
      : {};

    const nextBulkStockUrl = normalizeBulkStockUrl(input.bulkStockUrl);
    const providedBulkStockApiKey = normalizeOptionalString(input.bulkStockApiKey);
    const existingBulkStockApiKey = typeof existing.bulkStockApiKey === 'string'
      ? existing.bulkStockApiKey
      : null;
    const nextBulkStockApiKey = input.bulkStockApiKey === undefined
      ? existingBulkStockApiKey
      : providedBulkStockApiKey
        ? encrypt(providedBulkStockApiKey)
        : null;
    const nextDefaultLeadTimeDays = input.defaultLeadTimeDays === undefined
      ? normalizeOptionalLeadTimeDays(existing.defaultLeadTimeDays)
      : normalizeOptionalLeadTimeDays(input.defaultLeadTimeDays);
    const nextBulkStockBatchSize = input.bulkStockBatchSize === undefined
      ? normalizeOptionalBulkStockBatchSize(existing.bulkStockBatchSize) ?? DEFAULT_BULK_STOCK_BATCH_SIZE
      : normalizeOptionalBulkStockBatchSize(input.bulkStockBatchSize) ?? DEFAULT_BULK_STOCK_BATCH_SIZE;
    const defaultLeadTimeChanged = nextDefaultLeadTimeDays !== normalizeOptionalLeadTimeDays(existing.defaultLeadTimeDays);

    const updated = {
      ...existing,
      bulkStockUrl: nextBulkStockUrl,
      bulkStockApiKey: nextBulkStockApiKey,
      defaultLeadTimeDays: nextDefaultLeadTimeDays,
      bulkStockBatchSize: nextBulkStockBatchSize,
    };

    await prisma.shop.update({ where: { id }, data: { configJson: updated } });
    if (defaultLeadTimeChanged) {
      stockSyncService.syncStockForShop(id, 'LEAD_TIME_UPDATE').catch((error) => {
        logger.error({ err: error, shopId: id }, 'Failed to enqueue lead time sync after bulk stock config change');
      });
    }

    return { success: true, hasBulkStock: Boolean(updated.bulkStockApiKey) };
  },

  getBulkStockDiagnostics: async (id: string) => {
    const shop = await prisma.shop.findFirst({
      where: getShopAdminWhere(id),
      select: { id: true, baseUrl: true, configJson: true },
    });
    if (!shop) {
      throw new NotFoundError('Sklep nie znaleziony');
    }

    const config = (shop.configJson && typeof shop.configJson === 'object' && !Array.isArray(shop.configJson))
      ? shop.configJson as Record<string, unknown>
      : {};
    const configuredUrl = normalizeOptionalString(config.bulkStockUrl);
    const url = configuredUrl ?? buildBulkStockUrl(shop.baseUrl.replace(/\/+$/, '').replace(/\/api$/, ''));
    const apiKey = typeof config.bulkStockApiKey === 'string' && config.bulkStockApiKey
      ? decrypt(config.bulkStockApiKey)
      : null;

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (apiKey) headers['X-Api-Key'] = apiKey;

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const text = await res.text().catch(() => '');
      const contentType = res.headers.get('content-type') ?? '';
      const bodyPreview = text.slice(0, 400);
      const looksJson = contentType.includes('application/json') || bodyPreview.trim().startsWith('{');
      const expectedGet405 = res.status === 405 && looksJson;
      const ok = looksJson && res.status !== 503;
      const message = expectedGet405
        ? 'Endpoint modułu jest osiągalny. GET zwrócił oczekiwane HTTP 405 JSON.'
        : res.status === 503 && !looksJson
          ? 'Endpoint zwraca HTML 503 przed kontrolerem modułu. Sprawdź maintenance/CDN/IP whitelist lub URL sklepu multistore.'
          : ok
            ? `Endpoint zwraca JSON HTTP ${res.status}; moduł prawdopodobnie odpowiada, ale oczekiwany test GET to HTTP 405.`
            : `Endpoint nie zwrócił odpowiedzi JSON modułu. HTTP ${res.status}.`;

      return {
        ok,
        expectedGet405,
        status: res.status,
        latencyMs: Date.now() - startedAt,
        contentType,
        url,
        message,
        bodyPreview,
      };
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Nie udało się połączyć z endpointem kp_bulkstock';
      return {
        ok: false,
        expectedGet405: false,
        status: 0,
        latencyMs: Date.now() - startedAt,
        contentType: '',
        url,
        message,
        bodyPreview: '',
      };
    } finally {
      clearTimeout(timeout);
    }
  },

  getModuleHealth: async (id: string) => {
    const shop = await prisma.shop.findFirst({
      where: getShopAdminWhere(id),
      select: { id: true, platform: true, baseUrl: true, configJson: true },
    });
    if (!shop) {
      throw new NotFoundError('Sklep nie znaleziony');
    }

    const config = (shop.configJson && typeof shop.configJson === 'object' && !Array.isArray(shop.configJson))
      ? shop.configJson as Record<string, unknown>
      : {};

    if (shop.platform !== 'PRESTASHOP') {
      return {
        ok: false,
        checkedAt: new Date().toISOString(),
        checks: [{
          key: 'platform',
          label: 'Platforma',
          configured: false,
          ok: false,
          status: 'warning',
          message: 'Kontrola modułów jest dostępna dla integracji PrestaShop.',
        }],
      };
    }

    const baseUrl = shop.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    const adminConnectorUrl = normalizeOptionalString(config.adminConnectorUrl);
    const adminConnectorApiKey = secretFromConfig(config.adminConnectorApiKey);
    const productContentApiKey = secretFromConfig(config.productContentApiKey ?? config.contentModuleApiKey);
    const bulkStockApiKey = secretFromConfig(config.bulkStockApiKey);

    const adminConnectorCheck = await checkJsonEndpoint({
      key: 'admin_connector',
      label: 'KP Admin Connector',
      configured: Boolean(adminConnectorApiKey),
      url: buildAdminConnectorControllerUrl(adminConnectorUrl, 'capabilities')
        ?? `${baseUrl}/index.php?fc=module&module=kp_adminconnector&controller=capabilities`,
      apiKey: adminConnectorApiKey,
      missingMessage: 'Nie skonfigurowano wspólnego modułu KP Admin Connector.',
    });

    const productContentUrl = moduleControllerUrl(
      normalizeOptionalString(config.productContentUrl ?? config.contentModuleUrl),
      'capabilities',
    ) ?? `${baseUrl}/index.php?fc=module&module=kp_productcontent&controller=capabilities`;
    const productContentCheck = await checkJsonEndpoint({
      key: 'product_content',
      label: 'Karta produktu',
      configured: Boolean(productContentApiKey),
      url: productContentUrl,
      apiKey: productContentApiKey,
      missingMessage: 'Brak klucza dla modułu treści produktu.',
    });

    const bulkDiagnostics = await shopsUseCases.getBulkStockDiagnostics(id);
    const bulkStockCheck: ModuleDiagnostic = {
      key: 'bulk_stock',
      label: 'Stany i dostępność',
      configured: Boolean(bulkStockApiKey),
      ok: Boolean(bulkStockApiKey && (bulkDiagnostics.expectedGet405 || bulkDiagnostics.ok)),
      status: !bulkStockApiKey ? 'missing_config' : bulkDiagnostics.expectedGet405 || bulkDiagnostics.ok ? 'ok' : 'error',
      message: bulkStockApiKey ? bulkDiagnostics.message : 'Brak klucza dla modułu stanów.',
      latencyMs: bulkDiagnostics.latencyMs,
      url: bulkDiagnostics.url,
      httpStatus: bulkDiagnostics.status,
      details: {
        expectedGet405: bulkDiagnostics.expectedGet405,
        contentType: bulkDiagnostics.contentType,
      },
    };

    const webhook = await shopWebhookService.getShopWebhookSettings(id);
    const webhookConfigured = Boolean(webhook.enabled && webhook.webhookUrl && webhook.secret);
    const webhookCheck: ModuleDiagnostic = {
      key: 'order_webhook',
      label: 'Webhook zamówień',
      configured: webhookConfigured,
      ok: webhookConfigured,
      status: webhookConfigured ? 'ok' : webhook.enabled ? 'error' : 'warning',
      message: webhookConfigured
        ? 'Webhook jest skonfigurowany po stronie API. Potwierdzenie hooków sklepu zapewnia KP Admin Connector.'
        : webhook.enabled
          ? 'Webhook jest włączony, ale brakuje URL lub sekretu.'
          : 'Webhook jest wyłączony.',
      url: webhook.webhookUrl,
      details: {
        enabled: webhook.enabled,
        hasSecret: Boolean(webhook.secret),
        eventTypes: webhook.eventTypes,
      },
    };

    const checks = [adminConnectorCheck, productContentCheck, bulkStockCheck, webhookCheck];
    return {
      ok: checks.every((check) => check.status === 'ok' || check.status === 'warning'),
      checkedAt: new Date().toISOString(),
      checks,
    };
  },

  getWebhookSettings: (id: string) => translateShopErrors(() => shopWebhookService.getShopWebhookSettings(id)),

  updateWebhookSettings: (id: string, input: { enabled?: boolean }) =>
    translateShopErrors(() => shopWebhookService.updateShopWebhookSettings(id, input)),

  rotateWebhookSecret: (id: string) => translateShopErrors(() => shopWebhookService.rotateShopWebhookSecret(id)),

  listWebhookEvents: (id: string, query: shopWebhookService.ShopWebhookEventsQuery) =>
    translateShopErrors(() => shopWebhookService.listShopWebhookEvents(id, query)),

  reprocessWebhookEvent: (id: string, eventId: string) =>
    translateShopErrors(() => shopWebhookService.reprocessShopWebhookEvent(id, eventId)),

  triggerManualSync: async (id: string, input: ManualSyncInput, logger: Pick<Logger, 'info'>) => {
    await assertShopAdminAccess(id);
    const wait = input.wait === true || input.wait === 'true';
    const fromDate = assertValidOrderSyncDate(input.fromDate, 'fromDate') ?? undefined;
    logger.info({ shopId: id, wait, fromDate, fromOrderId: input.fromOrderId, limit: input.limit }, 'Manual sync triggered');

    return triggerManualSync(id, {
      wait,
      fromDate,
      fromOrderId: input.fromOrderId,
      limit: input.limit,
    });
  },

  enableSync: async (id: string) => {
    await assertShopAdminAccess(id);
    await enableShopSync(id);
    return {
      success: true,
      message: 'Auto-sync włączona dla sklepu',
    };
  },

  disableSync: async (id: string) => {
    await assertShopAdminAccess(id);
    await disableShopSync(id);
    return {
      success: true,
      message: 'Auto-sync wyłączona dla sklepu',
    };
  },

  updateSyncInterval: async (id: string, intervalMinutes: number) => {
    if (typeof intervalMinutes !== 'number' || intervalMinutes < 5 || intervalMinutes > 1440) {
      throw new ValidationError('Interval musi być liczbą między 5 a 1440 minut');
    }

    await assertShopAdminAccess(id);
    await updateShopSyncInterval(id, intervalMinutes);
    return {
      success: true,
      message: `Interwał synchronizacji zmieniony na ${intervalMinutes} minut`,
    };
  },
};
