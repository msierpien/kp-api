/// <reference lib="dom" />
import { Buffer } from 'node:buffer';
import type { ShopStockClient } from './shop-stock-client.interface';

export class PrestaShopStockClient implements ShopStockClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: { baseUrl: string; apiKey: string }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    this.apiKey = config.apiKey;
  }

  async updateStockQuantity(externalProductId: string, quantity: number): Promise<void> {
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
      outOfStock: stockAvailable.outOfStock ?? '2',
    });

    await this.fetchWebService(`stock_availables/${stockAvailable.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/json',
      },
      body: payload,
    });
  }

  private async findStockAvailable(externalProductId: string) {
    const data = await this.fetchWebService<any>(
      `stock_availables?filter[id_product]=[${encodeURIComponent(externalProductId)}]&display=full`,
    );

    const entries = data.stock_availables
      ? Array.isArray(data.stock_availables) ? data.stock_availables : [data.stock_availables]
      : [];

    const entry = entries[0];
    if (!entry) return null;

    return {
      id: String(entry.id),
      idProductAttribute: entry.id_product_attribute === undefined ? undefined : String(entry.id_product_attribute),
      idShop: entry.id_shop === undefined ? undefined : String(entry.id_shop),
      idShopGroup: entry.id_shop_group === undefined ? undefined : String(entry.id_shop_group),
      dependsOnStock: entry.depends_on_stock === undefined ? undefined : String(entry.depends_on_stock),
      outOfStock: entry.out_of_stock === undefined ? undefined : String(entry.out_of_stock),
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
