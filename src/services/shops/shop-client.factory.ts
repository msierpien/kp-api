import type { Shop } from '@prisma/client';
import { decrypt } from '../../lib/encryption';
import type { ShopStockClient } from './shop-stock-client.interface';
import { PrestaShopStockClient } from './prestashop-stock-client';

export function createShopStockClient(shop: Shop): ShopStockClient {
  if (shop.platform === 'PRESTASHOP') {
    return new PrestaShopStockClient({
      baseUrl: shop.baseUrl,
      apiKey: decrypt(shop.apiKey),
    });
  }

  throw new Error(`Stock sync is not implemented for platform ${shop.platform}`);
}
