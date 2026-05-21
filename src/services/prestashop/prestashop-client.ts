/// <reference lib="dom" />
import { Buffer } from 'node:buffer';

interface PrestaShopOrder {
  id: number;
  id_customer: number;
  id_cart: number;
  reference: string;
  current_state: number;
  total_paid: string;
  date_add: string;
  associations?: {
    order_rows?: Array<{
      id: number;
      product_id: number;
      product_attribute_id: number;
      product_quantity: number;
      product_name: string;
      product_reference: string;
    }>;
  };
}

interface PrestaShopCustomer {
  id: number;
  email: string;
  firstname: string;
  lastname: string;
}

interface PrestaShopProduct {
  id: number | string;
  reference?: string;
  ean13?: string;
  name?: unknown;
  price?: string;
  active?: string | number | boolean;
}

interface PrestaShopCategory {
  id: number | string;
  name?: unknown;
  active?: string | number | boolean;
}

const DEBUG_SHOP_SYNC = process.env.DEBUG_SHOP_SYNC === 'true';

export interface PrestaShopProductDetails {
  id: string;
  sku: string;
  ean?: string;
  name: string;
  price?: number;
  active: boolean;
}

export interface PrestaShopCategoryDetails {
  id: string;
  name: string;
  active: boolean;
}

export interface CreatePrestaShopProductInput {
  reference: string;
  name: string;
  price: number;
  categoryId: string;
  ean13?: string | null;
  description?: string | null;
  active?: boolean;
  languageId?: string | number;
  idShopDefault?: string | number;
  taxRulesGroupId?: string | number;
}

export interface PrestaShopOrderDetails {
  order: PrestaShopOrder;
  customer: PrestaShopCustomer;
  items: Array<{
    id: number;
    product_id: number;
    product_reference: string;
    product_name: string;
    quantity: number;
  }>;
}

export class PrestaShopClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: {
    baseUrl: string;
    apiKey: string;
    authType: 'WEB_SERVICE' | 'ADMIN_API';
    adminApiConfig?: {
      clientId: string;
      clientSecret: string;
      scopes: string[];
    };
  }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    this.apiKey = config.apiKey;
  }

  private endpointUrl(endpoint: string, outputFormat?: 'JSON') {
    const separator = endpoint.includes('?') ? '&' : '?';
    const suffix = outputFormat ? `${separator}output_format=${outputFormat}` : '';
    return `${this.baseUrl}/api/${endpoint}${suffix}`;
  }

  private async fetchWebServiceResponse(
    endpoint: string,
    init: RequestInit = {},
    options: { outputFormat?: 'JSON' } = { outputFormat: 'JSON' },
  ): Promise<Response> {
    const url = this.endpointUrl(endpoint, options.outputFormat);
    const authHeader = 'Basic ' + Buffer.from(`${this.apiKey}:`).toString('base64');

    if (DEBUG_SHOP_SYNC) console.log(`[PrestaShop] Requesting: ${endpoint}`);

    let response = await fetch(url, {
      ...init,
      headers: {
        Authorization: authHeader,
        ...(options.outputFormat === 'JSON' ? { Accept: 'application/json' } : {}),
        ...(init.headers || {}),
      },
    });

    // Fallback: some hosts strip Authorization header
    if (!response.ok && response.status === 401) {
      if (DEBUG_SHOP_SYNC) console.log('[PrestaShop] Auth header failed, trying ws_key parameter');
      const urlWithKey = `${url}${url.includes('?') ? '&' : '?'}ws_key=${encodeURIComponent(this.apiKey)}`;
      response = await fetch(urlWithKey, {
        ...init,
        headers: {
          ...(options.outputFormat === 'JSON' ? { Accept: 'application/json' } : {}),
          ...(init.headers || {}),
        },
      });
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`[PrestaShop] Error ${response.status} for ${endpoint}:`, text.slice(0, 300));
      throw new Error(`PrestaShop API error: ${response.status} ${text.slice(0, 200)}`);
    }

    return response;
  }

  private async fetchWebService<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchWebServiceResponse(endpoint, init, { outputFormat: 'JSON' });
    const text = await response.text();
    return text ? JSON.parse(text) : {} as T;
  }

  private async fetchWebServiceText(
    endpoint: string,
    init: RequestInit = {},
    options: { outputFormat?: 'JSON' } = {},
  ): Promise<{ text: string; response: Response }> {
    const response = await this.fetchWebServiceResponse(endpoint, init, options);
    const text = await response.text();
    return { text, response };
  }

  async fetchOrders(params: {
    limit?: number;
    dateFrom?: string;
    currentState?: number;
  }): Promise<PrestaShopOrder[]> {
    const queryParams: string[] = [`limit=${params.limit || 50}`];
    if (params.dateFrom) {
      queryParams.push(`date_add>[${params.dateFrom}]`);
    }
    if (params.currentState) {
      queryParams.push(`current_state=${params.currentState}`);
    }

    const query = queryParams.join('&');
    const data = await this.fetchWebService<any>(`orders?${query}&display=full`);

    if (!data.orders) {
      return [];
    }

    // Handle both single order and array of orders
    const orders = Array.isArray(data.orders) ? data.orders : [data.orders];
    return orders;
  }

  async fetchProducts(params: { limit?: number; offset?: number; activeOnly?: boolean } = {}): Promise<PrestaShopProductDetails[]> {
    const limit = params.limit ?? 100;
    const offset = params.offset ?? 0;
    const queryParams = [
      'display=[id,reference,ean13,name,price,active]',
      `limit=${offset},${limit}`,
      'sort=[id_ASC]',
    ];

    if (params.activeOnly ?? true) {
      queryParams.push('filter[active]=[1]');
    }

    const data = await this.fetchWebService<any>(`products?${queryParams.join('&')}`);
    if (!data.products) return [];

    const products = Array.isArray(data.products) ? data.products : [data.products];

    return products.map((product: PrestaShopProduct) => {
      const sku = String(product.reference ?? '').trim();
      const ean = String(product.ean13 ?? '').trim() || undefined;
      const name = normalizePrestaShopLocalizedValue(product.name) || sku || `Produkt ${product.id}`;
      const price = product.price === undefined || product.price === '' ? undefined : Number(product.price);

      return {
        id: String(product.id),
        sku,
        ean,
        name,
        price: Number.isFinite(price) ? price : undefined,
        active: product.active === undefined ? true : String(product.active) !== '0',
      };
    });
  }

  async fetchCategories(params: { activeOnly?: boolean; limit?: number } = {}): Promise<PrestaShopCategoryDetails[]> {
    const queryParams = [
      'display=[id,name,active]',
      `limit=${params.limit ?? 1000}`,
      'sort=[name_ASC]',
    ];

    if (params.activeOnly ?? true) {
      queryParams.push('filter[active]=[1]');
    }

    const data = await this.fetchWebService<any>(`categories?${queryParams.join('&')}`);
    if (!data.categories) return [];

    const categories = Array.isArray(data.categories) ? data.categories : [data.categories];
    return categories.map((category: PrestaShopCategory) => ({
      id: String(category.id),
      name: normalizePrestaShopLocalizedValue(category.name) || `Kategoria ${category.id}`,
      active: category.active === undefined ? true : String(category.active) !== '0',
    }));
  }

  async findProductByReference(reference: string): Promise<PrestaShopProductDetails | null> {
    const normalizedReference = reference.trim();
    if (!normalizedReference) return null;

    const query = [
      `filter[reference]=[${encodeURIComponent(normalizedReference)}]`,
      'display=[id,reference,ean13,name,price,active]',
      'limit=1',
    ].join('&');

    const data = await this.fetchWebService<any>(`products?${query}`);
    const products = data.products
      ? Array.isArray(data.products) ? data.products : [data.products]
      : [];
    const product = products[0] as PrestaShopProduct | undefined;
    if (!product) return null;

    const price = product.price === undefined || product.price === '' ? undefined : Number(product.price);
    return {
      id: String(product.id),
      sku: String(product.reference ?? '').trim(),
      ean: String(product.ean13 ?? '').trim() || undefined,
      name: normalizePrestaShopLocalizedValue(product.name) || normalizedReference,
      price: Number.isFinite(price) ? price : undefined,
      active: product.active === undefined ? true : String(product.active) !== '0',
    };
  }

  async createSimpleProduct(input: CreatePrestaShopProductInput): Promise<PrestaShopProductDetails> {
    if (!input.reference.trim()) throw new Error('PrestaShop product reference is required');
    if (!input.name.trim()) throw new Error('PrestaShop product name is required');
    if (!Number.isFinite(input.price) || input.price < 0) throw new Error('PrestaShop product price is invalid');
    if (!input.categoryId.trim()) throw new Error('PrestaShop product category is required');

    const payload = buildProductXml(input);
    const { text, response } = await this.fetchWebServiceText('products', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: payload,
    });

    const idFromLocation = response.headers.get('location')?.match(/\/products\/(\d+)\b/)?.[1];
    const id = idFromLocation ?? extractXmlTagValue(text, 'id');
    if (!id) {
      throw new Error('PrestaShop product was created but response did not contain product id');
    }

    return {
      id,
      sku: input.reference.trim(),
      ean: input.ean13?.trim() || undefined,
      name: input.name.trim(),
      price: input.price,
      active: input.active ?? false,
    };
  }

  async uploadProductImage(productId: string, imageUrl: string): Promise<void> {
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Image download failed: ${imageResponse.status}`);
    }

    const contentType = imageResponse.headers.get('content-type') || 'image/jpeg';
    const bytes = await imageResponse.arrayBuffer();
    const filename = imageFilenameFromUrl(imageUrl, contentType);
    const formData = new FormData();
    formData.append('image', new Blob([bytes], { type: contentType }), filename);

    await this.fetchWebServiceText(`images/products/${encodeURIComponent(productId)}`, {
      method: 'POST',
      body: formData,
    });
  }

  async fetchOrderDetails(orderId: number): Promise<PrestaShopOrderDetails> {
    try {
      if (DEBUG_SHOP_SYNC) console.log(`[PrestaShop] Fetching order ${orderId} from: orders/${orderId}?display=full`);
      const orderData = await this.fetchWebService<any>(`orders/${orderId}?display=full`);
      
      if (DEBUG_SHOP_SYNC) {
        console.log(`[PrestaShop] Raw response for order ${orderId}:`, JSON.stringify(orderData, null, 2));
        console.log(`[PrestaShop] Response keys:`, Object.keys(orderData));
      }
      
      // PrestaShop returns orders as array even for single order request
      const order = orderData.order || (orderData.orders && orderData.orders[0]) || orderData;
      if (DEBUG_SHOP_SYNC) {
        console.log(`[PrestaShop] Extracted order object:`, JSON.stringify(order, null, 2).substring(0, 500));
        console.log(`[PrestaShop] Order keys:`, Object.keys(order || {}));
        console.log(`[PrestaShop] id_customer value:`, order?.id_customer);
      }

      if (!order || !order.id_customer) {
        console.error(`[PrestaShop] Invalid order data for ID ${orderId}`);
        console.error(`[PrestaShop] Full response:`, JSON.stringify(orderData, null, 2));
        throw new Error(`Invalid order data for ID ${orderId}`);
      }

      if (DEBUG_SHOP_SYNC) console.log(`[PrestaShop] Fetching customer ${order.id_customer}`);
      const customerData = await this.fetchWebService<any>(`customers/${order.id_customer}?display=full`);
      
      if (DEBUG_SHOP_SYNC) {
        console.log(`[PrestaShop] Customer raw response:`, JSON.stringify(customerData, null, 2).substring(0, 1000));
        console.log(`[PrestaShop] Customer data keys:`, Object.keys(customerData));
      }
      
      // Handle both single customer and array
      const customer = customerData.customer || 
                      (customerData.customers && customerData.customers[0]) || 
                      customerData;
      
      if (DEBUG_SHOP_SYNC) {
        console.log(`[PrestaShop] Customer ${order.id_customer} email: "${customer.email}"`);
        console.log(`[PrestaShop] Customer ${order.id_customer} firstname: "${customer.firstname}"`);
        console.log(`[PrestaShop] Customer ${order.id_customer} lastname: "${customer.lastname}"`);
      }

      // Fetch order items
      const items: Array<{
        id: number;
        product_id: number;
        product_reference: string;
        product_name: string;
        quantity: number;
      }> = [];

      if (order.associations?.order_rows) {
        for (const row of order.associations.order_rows) {
          items.push({
            id: row.id,
            product_id: row.product_id,
            product_reference: row.product_reference || '',
            product_name: row.product_name || '',
            quantity: row.product_quantity,
          });
        }
      }

      return {
        order,
        customer,
        items,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to fetch order ${orderId} details: ${message}`);
    }
  }

  async addOrderNote(orderId: number, message: string): Promise<void> {
    // This would require order_histories endpoint
    // Implementation depends on PrestaShop version
    console.log(`Would add note to order ${orderId}: ${message}`);
  }
}

function normalizePrestaShopLocalizedValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';

  const maybeRecord = value as any;

  if (Array.isArray(maybeRecord)) {
    const firstValue = maybeRecord
      .map((item) => normalizePrestaShopLocalizedValue(item))
      .find(Boolean);
    return firstValue ?? '';
  }

  if (typeof maybeRecord.value === 'string') return maybeRecord.value.trim();
  if (typeof maybeRecord.language === 'string') return maybeRecord.language.trim();
  if (Array.isArray(maybeRecord.language)) return normalizePrestaShopLocalizedValue(maybeRecord.language);

  return '';
}

function buildProductXml(input: CreatePrestaShopProductInput) {
  const languageId = String(input.languageId ?? 1);
  const categoryId = input.categoryId.trim();
  const description = input.description?.trim() || '';
  const ean13 = normalizeEan13(input.ean13);

  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product>
    ${input.idShopDefault ? `<id_shop_default>${escapeXml(String(input.idShopDefault))}</id_shop_default>` : ''}
    <id_category_default>${escapeXml(categoryId)}</id_category_default>
    <id_tax_rules_group>${escapeXml(String(input.taxRulesGroupId ?? 1))}</id_tax_rules_group>
    <state>1</state>
    <reference>${escapeXml(input.reference.trim())}</reference>
    ${ean13 ? `<ean13>${escapeXml(ean13)}</ean13>` : ''}
    <price>${input.price.toFixed(2)}</price>
    <active>${input.active ? 1 : 0}</active>
    <available_for_order>1</available_for_order>
    <show_price>1</show_price>
    <visibility>both</visibility>
    <name>
      <language id="${escapeXml(languageId)}"><![CDATA[${cdata(input.name.trim())}]]></language>
    </name>
    <link_rewrite>
      <language id="${escapeXml(languageId)}"><![CDATA[${cdata(slugify(input.name))}]]></language>
    </link_rewrite>
    <description>
      <language id="${escapeXml(languageId)}"><![CDATA[${cdata(description)}]]></language>
    </description>
    <description_short>
      <language id="${escapeXml(languageId)}"><![CDATA[${cdata(shortDescription(description))}]]></language>
    </description_short>
    <associations>
      <categories>
        <category>
          <id>${escapeXml(categoryId)}</id>
        </category>
      </categories>
    </associations>
  </product>
</prestashop>`;
}

function extractXmlTagValue(xml: string, tagName: string) {
  const match = xml.match(new RegExp(`<${tagName}\\b[^>]*>\\s*(?:<!\\[CDATA\\[)?([^<\\]]+)`, 'i'));
  return match?.[1]?.trim();
}

function normalizeEan13(value?: string | null) {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  return /^\d{8,13}$/.test(trimmed) ? trimmed : '';
}

function imageFilenameFromUrl(imageUrl: string, contentType: string) {
  try {
    const pathname = new URL(imageUrl).pathname;
    const last = pathname.split('/').filter(Boolean).pop();
    if (last && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
  } catch {
    // Ignore invalid URL parsing here; upload will still use a safe filename.
  }

  const extension = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  return `product-image.${extension}`;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(value: string) {
  return value.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

function shortDescription(value: string) {
  if (!value) return '';
  const plain = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length <= 400 ? plain : `${plain.slice(0, 397)}...`;
}

function slugify(value: string) {
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || 'produkt';
}
