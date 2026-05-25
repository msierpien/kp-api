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
  listShops,
  testShopConnection,
  updateShop,
} from '../../services/admin/shops.service';
import {
  disableShopSync,
  enableShopSync,
  triggerManualSync,
  updateShopSyncInterval,
} from '../../services/scheduler/scheduler.service';
import { buildBulkStockUrl } from '../../services/shops/prestashop-stock-client';
import * as stockSyncService from '../../services/stock/stock-sync.service';
import * as shopWebhookService from '../../services/webhooks/prestashop-order-webhook.service';

type Logger = {
  error: (payload: unknown, message?: string) => void;
  info: (payload: unknown, message?: string) => void;
};

export type UpdateBulkStockConfigInput = {
  bulkStockUrl?: string | null;
  bulkStockApiKey?: string | null;
  defaultLeadTimeDays?: number | null;
};

export type ManualSyncInput = {
  wait?: string | boolean;
  fromDate?: string;
  fromOrderId?: string;
  limit?: number;
};

function normalizeOptionalString(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
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

  getPrestaShopCategories: (id: string) => getPrestaShopCategories(id),

  getImportReadiness: (id: string) => getShopImportReadiness(id),

  testConnection: (id: string) => testShopConnection(id),

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

    const nextBulkStockUrl = normalizeOptionalString(input.bulkStockUrl);
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
    const defaultLeadTimeChanged = nextDefaultLeadTimeDays !== normalizeOptionalLeadTimeDays(existing.defaultLeadTimeDays);

    const updated = {
      ...existing,
      bulkStockUrl: nextBulkStockUrl,
      bulkStockApiKey: nextBulkStockApiKey,
      defaultLeadTimeDays: nextDefaultLeadTimeDays,
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
    logger.info({ shopId: id, wait, fromDate: input.fromDate, fromOrderId: input.fromOrderId, limit: input.limit }, 'Manual sync triggered');

    return triggerManualSync(id, {
      wait,
      fromDate: input.fromDate,
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
