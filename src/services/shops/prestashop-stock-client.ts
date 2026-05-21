/// <reference lib="dom" />
import { Buffer } from 'node:buffer';
import type { ShopProductInventorySnapshot, ShopStockClient, ShopStockUpdateOptions } from './shop-stock-client.interface';

const BULK_BATCH_SIZE = 500;

export interface BulkStockItem {
  productId: number;
  quantity: number;
  idProductAttribute?: number;
}

export interface BulkStockResult {
  updated: number;
  errors: string[];
  results: Array<{ productId: number; quantity?: number; idProductAttribute?: number; status: 'ok' | 'error'; message?: string }>;
}

export class PrestaShopStockClient implements ShopStockClient {
  private baseUrl: string;
  private apiKey: string;
  private bulkStockUrl: string | null;
  private bulkStockApiKey: string | null;

  constructor(config: { baseUrl: string; apiKey: string; bulkStockUrl?: string | null; bulkStockApiKey?: string | null }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    this.apiKey = config.apiKey;
    this.bulkStockUrl = config.bulkStockUrl ?? null;
    this.bulkStockApiKey = config.bulkStockApiKey ?? null;
  }

  get hasBulkModule(): boolean {
    return Boolean(this.bulkStockUrl && this.bulkStockApiKey);
  }

  async bulkUpdateStock(items: BulkStockItem[]): Promise<BulkStockResult> {
    if (!this.bulkStockUrl || !this.bulkStockApiKey) {
      throw new Error('Moduł kp_bulkstock nie jest skonfigurowany dla tego sklepu');
    }

    const combined: BulkStockResult = { updated: 0, errors: [], results: [] };

    for (let i = 0; i < items.length; i += BULK_BATCH_SIZE) {
      const batch = items.slice(i, i + BULK_BATCH_SIZE);
      const res = await fetch(this.bulkStockUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.bulkStockApiKey },
        body: JSON.stringify({ items: batch }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`kp_bulkstock HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = await res.json() as { success: boolean; data?: BulkStockResult; errors?: string[] };
      if (!json.success) {
        throw new Error(`kp_bulkstock error: ${json.errors?.join(', ') ?? 'Unknown error'}`);
      }

      const result = json.data!;
      combined.updated += result.updated;
      combined.errors.push(...result.errors);
      combined.results.push(...result.results);
    }

    console.log(`[PrestaShopStockClient] bulk update: ${combined.updated} updated, ${combined.errors.length} errors`);
    return combined;
  }

  async updateStockQuantity(
    externalProductId: string,
    quantity: number,
    options: ShopStockUpdateOptions = {},
  ): Promise<void> {
    const stockAvailable = await this.findStockAvailable(externalProductId);
    if (!stockAvailable) {
      throw new Error(`PrestaShop stock_available not found for product ${externalProductId}`);
    }

    const payload = buildStockAvailableXml({
      id: stockAvailable.id,
      idProduct: externalProductId,
      idProductAttribute: stockAvailable.idProductAttribute ?? '0',
      idShop: stockAvailable.idShop,
      idShopGroup: stockAvailable.idShopGroup,
      quantity: Math.max(0, Math.floor(quantity)),
      dependsOnStock: stockAvailable.dependsOnStock ?? '0',
      outOfStock: String(options.outOfStockBehavior ?? stockAvailable.outOfStock ?? '2'),
    });

    console.log(
      `[PrestaShopStockClient] Updating stock for product ${externalProductId}: ` +
      `stock_available id=${stockAvailable.id}, qty=${Math.max(0, Math.floor(quantity))}, ` +
      `depends_on_stock=${stockAvailable.dependsOnStock}, id_product_attribute=${stockAvailable.idProductAttribute ?? '0'}`,
    );

    const putResult = await this.fetchWebService<any>(`stock_availables/${stockAvailable.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/json',
      },
      body: payload,
    });

    const confirmedQty = putResult?.stock_available?.quantity ?? putResult?.quantity;
    console.log(
      `[PrestaShopStockClient] PUT result for product ${externalProductId}: ` +
      `confirmed qty=${confirmedQty ?? 'unknown'}`,
    );
  }

  async updateProductPrice(externalProductId: string, price: number): Promise<void> {
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Invalid product price for PrestaShop product ${externalProductId}`);
    }

    const productXml = await this.fetchWebServiceText(`products/${encodeURIComponent(externalProductId)}`, {
      headers: { Accept: 'application/xml' },
    });

    const payload = replaceProductPriceXml(productXml, price);

    await this.fetchWebServiceText(`products/${encodeURIComponent(externalProductId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: payload,
    });
  }

  async getProductInventorySnapshot(externalProductId: string): Promise<ShopProductInventorySnapshot> {
    const [product, stockAvailable] = await Promise.all([
      this.fetchWebService<any>(`products/${encodeURIComponent(externalProductId)}`),
      this.findStockAvailable(externalProductId),
    ]);

    const productData = product.product || (product.products && product.products[0]) || product;
    const price = productData?.price === undefined || productData.price === ''
      ? undefined
      : Number(productData.price);

    return {
      externalProductId,
      price: Number.isFinite(price) ? price : undefined,
      stock: stockAvailable?.quantity,
      stockAvailableId: stockAvailable?.id,
    };
  }

  private async findStockAvailable(externalProductId: string) {
    const data = await this.fetchWebService<any>(
      `stock_availables?filter[id_product]=[${encodeURIComponent(externalProductId)}]&display=full`,
    );

    const entries: any[] = data.stock_availables
      ? Array.isArray(data.stock_availables) ? data.stock_availables : [data.stock_availables]
      : [];

    if (entries.length === 0) return null;

    // Dla produktów z kombinacjami PS tworzy wiele wpisów — bierzemy ten z id_product_attribute=0 (sam produkt)
    const entry = entries.find((e) => String(e.id_product_attribute) === '0') ?? entries[0];

    const dependsOnStock = entry.depends_on_stock === undefined ? undefined : String(entry.depends_on_stock);

    if (dependsOnStock === '1') {
      console.warn(
        `[PrestaShopStockClient] Product ${externalProductId} has depends_on_stock=1 (Advanced Stock Management). ` +
        `Direct stock_available update may be ignored by PrestaShop. Proceeding anyway.`,
      );
    }

    return {
      id: String(entry.id),
      idProductAttribute: entry.id_product_attribute === undefined ? undefined : String(entry.id_product_attribute),
      idShop: entry.id_shop === undefined ? undefined : String(entry.id_shop),
      idShopGroup: entry.id_shop_group === undefined ? undefined : String(entry.id_shop_group),
      dependsOnStock,
      outOfStock: entry.out_of_stock === undefined ? undefined : String(entry.out_of_stock),
      quantity: entry.quantity === undefined ? undefined : Number(entry.quantity),
    };
  }

  private async fetchWebService<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
    const separator = endpoint.includes('?') ? '&' : '?';
    const url = `${this.baseUrl}/api/${endpoint}${separator}output_format=JSON`;
    const authHeader = 'Basic ' + Buffer.from(`${this.apiKey}:`).toString('base64');

    let response = await fetch(url, {
      ...init,
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        ...(init.headers || {}),
      },
    });

    if (!response.ok && response.status === 401) {
      const urlWithKey = `${url}&ws_key=${encodeURIComponent(this.apiKey)}`;
      response = await fetch(urlWithKey, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init.headers || {}),
        },
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PrestaShop API error: ${response.status} ${text.slice(0, 200)}`);
    }

    const text = await response.text();
    return text ? JSON.parse(text) : {} as T;
  }

  private async fetchWebServiceText(endpoint: string, init: RequestInit = {}): Promise<string> {
    const url = `${this.baseUrl}/api/${endpoint}`;
    const authHeader = 'Basic ' + Buffer.from(`${this.apiKey}:`).toString('base64');

    let response = await fetch(url, {
      ...init,
      headers: {
        Authorization: authHeader,
        ...(init.headers || {}),
      },
    });

    if (!response.ok && response.status === 401) {
      const separator = endpoint.includes('?') ? '&' : '?';
      const urlWithKey = `${url}${separator}ws_key=${encodeURIComponent(this.apiKey)}`;
      response = await fetch(urlWithKey, {
        ...init,
        headers: {
          ...(init.headers || {}),
        },
      });
    }

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`PrestaShop API error: ${response.status} ${text.slice(0, 200)}`);
    }

    return text;
  }
}

function buildStockAvailableXml(input: {
  id: string;
  idProduct: string;
  idProductAttribute: string;
  idShop?: string;
  idShopGroup?: string;
  quantity: number;
  dependsOnStock: string;
  outOfStock: string;
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <stock_available>
    <id>${escapeXml(input.id)}</id>
    <id_product>${escapeXml(input.idProduct)}</id_product>
    <id_product_attribute>${escapeXml(input.idProductAttribute)}</id_product_attribute>
    ${input.idShop ? `<id_shop>${escapeXml(input.idShop)}</id_shop>` : ''}
    ${input.idShopGroup ? `<id_shop_group>${escapeXml(input.idShopGroup)}</id_shop_group>` : ''}
    <quantity>${input.quantity}</quantity>
    <depends_on_stock>${escapeXml(input.dependsOnStock)}</depends_on_stock>
    <out_of_stock>${escapeXml(input.outOfStock)}</out_of_stock>
  </stock_available>
</prestashop>`;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function replaceProductPriceXml(xml: string, price: number) {
  const normalizedPrice = price.toFixed(2);
  const withoutReadonlyFields = xml
    .replace(/\s*<manufacturer_name\b[^>]*>[\s\S]*?<\/manufacturer_name>/g, '')
    .replace(/\s*<quantity\b[^>]*>[\s\S]*?<\/quantity>/g, '');

  if (!/<price\b[^>]*>[\s\S]*?<\/price>/.test(withoutReadonlyFields)) {
    throw new Error('PrestaShop product XML does not contain a price field');
  }

  return withoutReadonlyFields.replace(
    /<price\b([^>]*)>[\s\S]*?<\/price>/,
    `<price$1>${normalizedPrice}</price>`,
  );
}
