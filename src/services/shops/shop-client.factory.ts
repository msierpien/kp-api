import type { Shop } from '@prisma/client';
import { decrypt } from '../../lib/encryption';
import type { ShopStockClient } from './shop-stock-client.interface';
import { PrestaShopStockClient } from './prestashop-stock-client';

function getConfigJson(shop: Shop): Record<string, unknown> {
  if (!shop.configJson || typeof shop.configJson !== 'object' || Array.isArray(shop.configJson)) return {};
  return shop.configJson as Record<string, unknown>;
}

export function createShopStockClient(shop: Shop): ShopStockClient {
  if (shop.platform === 'PRESTASHOP') {
    const config = getConfigJson(shop);
    const bulkStockApiKey = typeof config.bulkStockApiKey === 'string' && config.bulkStockApiKey
      ? decrypt(config.bulkStockApiKey)
      : null;

    return new PrestaShopStockClient({
      baseUrl: shop.baseUrl,
      apiKey: decrypt(shop.apiKey),
      bulkStockUrl: typeof config.bulkStockUrl === 'string' ? config.bulkStockUrl : null,
      bulkStockApiKey,
    });
  }

  throw new Error(`Stock sync is not implemented for platform ${shop.platform}`);
}
