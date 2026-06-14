import type { Shop } from '@prisma/client';
import { decrypt } from '../../lib/encryption';
import type { ShopStockClient } from './shop-stock-client.interface';
import { buildAdminConnectorControllerUrl, PrestaShopStockClient } from './prestashop-stock-client';

function getConfigJson(shop: Shop): Record<string, unknown> {
  if (!shop.configJson || typeof shop.configJson !== 'object' || Array.isArray(shop.configJson)) return {};
  return shop.configJson as Record<string, unknown>;
}

export function createShopStockClient(shop: Shop): ShopStockClient {
  if (shop.platform === 'PRESTASHOP') {
    const config = getConfigJson(shop);
    const configuredBulkStockUrl = typeof config.bulkStockUrl === 'string' && config.bulkStockUrl.trim()
      ? config.bulkStockUrl
      : null;
    const connectorBulkStockUrl = adminConnectorStockUrl(config);
    const bulkStockUrl = configuredBulkStockUrl ?? connectorBulkStockUrl;
    const bulkStockUsesConnector = isAdminConnectorModuleUrl(bulkStockUrl);
    const bulkStockApiKey = bulkStockUsesConnector && typeof config.adminConnectorApiKey === 'string' && config.adminConnectorApiKey
        ? decrypt(String(config.adminConnectorApiKey))
      : typeof config.bulkStockApiKey === 'string' && config.bulkStockApiKey
        ? decrypt(config.bulkStockApiKey)
        : null;

    return new PrestaShopStockClient({
      baseUrl: shop.baseUrl,
      apiKey: decrypt(shop.apiKey),
      bulkStockUrl,
      bulkStockApiKey,
      bulkStockBatchSize: config.bulkStockBatchSize as number | string | null | undefined,
      prestashopShopId: getPrestaShopShopId(config),
    });
  }

  throw new Error(`Stock sync is not implemented for platform ${shop.platform}`);
}

function isAdminConnectorModuleUrl(value: string | null | undefined) {
  return Boolean(value && /\bmodule=kp_adminconnector\b|\/kp_adminconnector(?:\/|$)/i.test(value));
}

function getPrestaShopShopId(config: Record<string, unknown>) {
  const defaults = config.prestashopProductDefaults;
  const productCreate = config.productCreate;

  if (typeof config.idShopDefault === 'string' || typeof config.idShopDefault === 'number') {
    return config.idShopDefault;
  }
  if (typeof config.prestashopShopId === 'string' || typeof config.prestashopShopId === 'number') {
    return config.prestashopShopId;
  }
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const id = (defaults as Record<string, unknown>).idShopDefault;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  if (productCreate && typeof productCreate === 'object' && !Array.isArray(productCreate)) {
    const id = (productCreate as Record<string, unknown>).idShopDefault;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }

  return null;
}

function adminConnectorStockUrl(config: Record<string, unknown>) {
  if (
    typeof config.adminConnectorUrl !== 'string' ||
    !config.adminConnectorUrl.trim() ||
    typeof config.adminConnectorApiKey !== 'string' ||
    !config.adminConnectorApiKey.trim()
  ) {
    return null;
  }

  return buildAdminConnectorControllerUrl(config.adminConnectorUrl, 'bulkupdate');
}
