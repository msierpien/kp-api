/// <reference lib="dom" />
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

export interface PrestaShopOrder {
  id: number;
  id_customer: number;
  id_cart: number;
  id_address_delivery?: number;
  id_address_invoice?: number;
  id_carrier?: number;
  id_lang?: number | string;
  id_shop?: number | string;
  reference: string;
  current_state: number;
  payment?: string;
  module?: string;
  total_discounts_tax_incl?: string;
  total_discounts_tax_excl?: string;
  total_shipping_tax_incl?: string;
  total_shipping_tax_excl?: string;
  total_paid: string;
  date_add: string;
  date_upd?: string;
  associations?: {
    order_rows?: Array<{
      id: number;
      product_id: number;
      product_attribute_id: number;
      product_quantity: number;
      product_name: string;
      product_reference: string;
      product_price?: string;
      unit_price_tax_incl?: string;
      unit_price_tax_excl?: string;
      total_price_tax_incl?: string;
      total_price_tax_excl?: string;
      tax_rate?: string;
      tax_name?: string;
    }>;
  };
}

interface PrestaShopCustomer {
  id: number;
  email: string;
  firstname: string;
  lastname: string;
  is_guest?: string | number | boolean;
}

export interface PrestaShopAddress {
  id: number | string;
  id_country?: number | string;
  company?: string;
  vat_number?: string;
  dni?: string;
  firstname?: string;
  lastname?: string;
  address1?: string;
  address2?: string;
  postcode?: string;
  city?: string;
  phone?: string;
  phone_mobile?: string;
}

export interface PrestaShopCountry {
  id: number | string;
  iso_code?: string;
  name?: unknown;
}

export interface PrestaShopCarrier {
  id: number | string;
  name?: string;
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
  id_parent?: number | string;
  level_depth?: number | string;
  nleft?: number | string;
  nright?: number | string;
  position?: number | string;
  is_root_category?: string | number | boolean;
  associations?: {
    products?: unknown;
  };
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
  parentId: string | null;
  levelDepth: number | null;
  position: number | null;
  isRoot: boolean;
  nleft: number | null;
  nright: number | null;
  path: string;
}

export interface CreatePrestaShopCategoryInput {
  name: string;
  parentId: string | number;
  active?: boolean;
  linkRewrite?: string | null;
  description?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  languageId?: string | number | null;
  idShopDefault?: string | number | null;
}

export interface UpdatePrestaShopCategoryInput {
  name?: string;
  parentId?: string | number;
  active?: boolean;
  linkRewrite?: string | null;
  description?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  languageId?: string | number | null;
  idShopDefault?: string | number | null;
}

export interface PrestaShopOrderStatusDetails {
  id: string;
  name: string;
  color?: string;
  paid: boolean;
  deleted: boolean;
  shipped: boolean;
  invoice: boolean;
  delivery: boolean;
  payload: Record<string, unknown>;
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

export function buildPrestaShopOrdersQuery(params: {
  limit?: number;
  dateFrom?: string;
  dateField?: 'date_add' | 'date_upd';
  idFrom?: string;
  currentState?: number;
}) {
  const queryParams = new URLSearchParams({
    display: 'full',
    limit: String(params.limit || 50),
    sort: '[id_ASC]',
  });

  if (params.dateFrom) {
    queryParams.set(`filter[${params.dateField ?? 'date_add'}]`, `>[${params.dateFrom}]`);
    queryParams.set('date', '1');
  }
  if (params.idFrom) {
    queryParams.set('filter[id]', `[${params.idFrom},]`);
  }
  if (params.currentState) {
    queryParams.set('filter[current_state]', `[${params.currentState}]`);
  }

  return queryParams.toString();
}

export interface CreatePrestaShopOrderSlipInput {
  orderId: number | string;
  customerId: number | string;
  conversionRate?: number;
  totalProductsTaxExcl: number;
  totalProductsTaxIncl: number;
  totalShippingTaxExcl?: number;
  totalShippingTaxIncl?: number;
  amount?: number;
  shippingCost?: boolean;
  shippingCostAmount?: number;
  partial?: boolean;
  orderSlipType?: number;
  details: Array<{
    idOrderDetail: number | string;
    productQuantity: number;
    amountTaxExcl: number;
    amountTaxIncl: number;
  }>;
}

export interface CreatePrestaShopOrderSlipResult {
  id: string | null;
  raw: string;
}

export interface PublishPrestaShopInvoiceLinkInput {
  orderId: number | string;
  cartId?: number | string | null;
  customerId?: number | string | null;
  customerEmail?: string | null;
  customerHasAccount?: boolean;
  languageId?: number | string | null;
  shopId?: number | string | null;
  message: string;
}

export interface PublishPrestaShopInvoiceLinkResult {
  orderMessageId: string | null;
  customerThreadId: string | null;
  customerMessageId: string | null;
  customerPanelDelivered: boolean;
  customerPanelSkippedReason?: string;
}

export interface PrestaShopOrderDetails {
  order: PrestaShopOrder;
  customer: PrestaShopCustomer;
  invoiceAddress: PrestaShopAddress | null;
  deliveryAddress: PrestaShopAddress | null;
  invoiceCountry: PrestaShopCountry | null;
  deliveryCountry: PrestaShopCountry | null;
  carrier: PrestaShopCarrier | null;
  orderStatus: PrestaShopOrderStatusDetails | null;
  items: Array<{
    id: number;
    product_id: number;
    product_attribute_id: number;
    product_reference: string;
    product_name: string;
    quantity: number;
    product_price?: string;
    unit_price_tax_incl?: string;
    unit_price_tax_excl?: string;
    total_price_tax_incl?: string;
    total_price_tax_excl?: string;
    tax_rate?: string;
    tax_name?: string;
    payload: Record<string, unknown>;
  }>;
  bundleSelections: PrestaShopBundleOrderSelection[];
}

export interface PrestaShopBundleComponent {
  id_product: number;
  id_product_attribute: number;
  reference: string;
  name: string;
  quantity: number;
}

export interface PrestaShopBundleOrderSelection {
  id_order_detail: number;
  id_product_bundle: number;
  id_product_attribute_bundle: number;
  bundle_name: string;
  bundle_reference: string;
  bundle_quantity: number;
  components: PrestaShopBundleComponent[];
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
    dateField?: 'date_add' | 'date_upd';
    idFrom?: string;
    currentState?: number;
  }): Promise<PrestaShopOrder[]> {
    const query = buildPrestaShopOrdersQuery(params);
    const data = await this.fetchWebService<any>(`orders?${query}`);

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

  async fetchCategories(params: { activeOnly?: boolean; limit?: number; tree?: boolean } = {}): Promise<PrestaShopCategoryDetails[]> {
    const queryParams = [
      'display=[id,name,active,id_parent,level_depth,position,is_root_category]',
      `limit=${params.limit ?? 1000}`,
    ];
    if (!params.tree) queryParams.push('sort=[name_ASC]');

    if (params.activeOnly ?? true) {
      queryParams.push('filter[active]=[1]');
    }

    const data = await this.fetchWebService<any>(`categories?${queryParams.join('&')}`);
    if (!data.categories) return [];

    const categories = Array.isArray(data.categories) ? data.categories : [data.categories];
    const normalized = categories.map((category: PrestaShopCategory) => normalizePrestaShopCategory(category));
    return params.tree ? sortCategoriesByPath(withCategoryPaths(normalized)) : normalized;
  }

  async createCategory(input: CreatePrestaShopCategoryInput): Promise<PrestaShopCategoryDetails> {
    if (!input.name.trim()) throw new Error('PrestaShop category name is required');
    if (!String(input.parentId ?? '').trim()) throw new Error('PrestaShop category parentId is required');

    const payload = buildCategoryXml(input);
    const { text, response } = await this.fetchWebServiceText('categories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: payload,
    });

    const idFromLocation = response.headers.get('location')?.match(/\/categories\/(\d+)\b/)?.[1];
    const id = idFromLocation ?? extractXmlTagValue(text, 'id');
    if (!id) {
      throw new Error('PrestaShop category was created but response did not contain category id');
    }

    return this.fetchCategory(id);
  }

  async updateCategory(categoryId: string, input: UpdatePrestaShopCategoryInput): Promise<PrestaShopCategoryDetails> {
    const id = categoryId.trim();
    if (!id) throw new Error('PrestaShop category id is required');

    const languageId = String(input.languageId ?? 1);
    const { text: categoryXml } = await this.fetchWebServiceText(`categories/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/xml' },
    });

    let payload = categoryXml;
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new Error('PrestaShop category name is required');
      payload = replaceLocalizedXmlTag(payload, 'name', name, languageId);
      if (input.linkRewrite === undefined) {
        payload = replaceLocalizedXmlTag(payload, 'link_rewrite', slugify(name), languageId);
      }
    }
    if (input.parentId !== undefined) {
      const parentId = String(input.parentId).trim();
      if (!parentId) throw new Error('PrestaShop category parentId is required');
      payload = replaceSimpleXmlTag(payload, 'id_parent', parentId);
    }
    if (input.active !== undefined) {
      payload = replaceSimpleXmlTag(payload, 'active', input.active ? '1' : '0');
    }
    if (input.idShopDefault !== undefined && input.idShopDefault !== null && String(input.idShopDefault).trim()) {
      payload = replaceSimpleXmlTag(payload, 'id_shop_default', String(input.idShopDefault).trim());
    }
    if (input.linkRewrite !== undefined) {
      payload = replaceLocalizedXmlTag(payload, 'link_rewrite', input.linkRewrite?.trim() || slugify(input.name ?? id), languageId);
    }
    if (input.description !== undefined) {
      payload = replaceLocalizedXmlTag(payload, 'description', input.description?.trim() || '', languageId);
    }
    if (input.metaTitle !== undefined) {
      payload = replaceLocalizedXmlTag(payload, 'meta_title', input.metaTitle?.trim() || '', languageId);
    }
    if (input.metaDescription !== undefined) {
      payload = replaceLocalizedXmlTag(payload, 'meta_description', input.metaDescription?.trim() || '', languageId);
    }

    await this.fetchWebServiceText(`categories/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: payload,
    });

    return this.fetchCategory(id);
  }

  async deactivateCategory(categoryId: string): Promise<PrestaShopCategoryDetails> {
    return this.updateCategory(categoryId, { active: false });
  }

  async deleteCategory(categoryId: string): Promise<void> {
    const id = categoryId.trim();
    if (!id) throw new Error('PrestaShop category id is required');

    await this.fetchWebServiceText(`categories/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/xml' },
    });
  }

  async fetchCategory(categoryId: string): Promise<PrestaShopCategoryDetails> {
    const id = categoryId.trim();
    if (!id) throw new Error('PrestaShop category id is required');

    const data = await this.fetchWebService<any>(`categories/${encodeURIComponent(id)}?display=full`);
    const category = data.category ?? data.categories?.[0] ?? data;
    return withCategoryPaths([normalizePrestaShopCategory(category as PrestaShopCategory)])[0];
  }

  async categoryHasChildren(categoryId: string): Promise<boolean> {
    const id = categoryId.trim();
    if (!id) return false;

    const childrenQuery = [
      `filter[id_parent]=[${encodeURIComponent(id)}]`,
      'display=[id]',
      'limit=1',
    ].join('&');
    const data = await this.fetchWebService<any>(`categories?${childrenQuery}`);
    const categories = data.categories
      ? Array.isArray(data.categories) ? data.categories : [data.categories]
      : [];
    return categories.length > 0;
  }

  async categoryHasProducts(categoryId: string): Promise<boolean> {
    const id = categoryId.trim();
    if (!id) return false;

    const defaultCategoryProductsQuery = [
      `filter[id_category_default]=[${encodeURIComponent(id)}]`,
      'display=[id]',
      'limit=1',
    ].join('&');
    const defaultCategoryData = await this.fetchWebService<any>(`products?${defaultCategoryProductsQuery}`);
    const defaultCategoryProducts = defaultCategoryData.products
      ? Array.isArray(defaultCategoryData.products) ? defaultCategoryData.products : [defaultCategoryData.products]
      : [];
    if (defaultCategoryProducts.length > 0) return true;

    try {
      const categoryData = await this.fetchWebService<any>(`categories/${encodeURIComponent(id)}?display=full`);
      const category = categoryData.category ?? categoryData.categories?.[0] ?? categoryData;
      const associatedProducts = (category as PrestaShopCategory | undefined)?.associations?.products;
      if (!associatedProducts) return false;
      if (Array.isArray(associatedProducts)) return associatedProducts.length > 0;
      if (typeof associatedProducts === 'object') {
        const product = (associatedProducts as any).product;
        return Array.isArray(product) ? product.length > 0 : Boolean(product);
      }
    } catch {
      return false;
    }

    return false;
  }

  async fetchCategoryProductIds(categoryId: string): Promise<string[]> {
    const id = categoryId.trim();
    if (!id) return [];
    const ids = new Set<string>();

    const defaultCategoryProductsQuery = [
      `filter[id_category_default]=[${encodeURIComponent(id)}]`,
      'display=[id]',
      'limit=1000',
    ].join('&');
    const defaultCategoryData = await this.fetchWebService<any>(`products?${defaultCategoryProductsQuery}`);
    const defaultCategoryProducts = defaultCategoryData.products
      ? Array.isArray(defaultCategoryData.products) ? defaultCategoryData.products : [defaultCategoryData.products]
      : [];
    defaultCategoryProducts.forEach((product: any) => {
      const productId = normalizeNullableId(product?.id);
      if (productId) ids.add(productId);
    });

    try {
      const categoryData = await this.fetchWebService<any>(`categories/${encodeURIComponent(id)}?display=full`);
      const category = categoryData.category ?? categoryData.categories?.[0] ?? categoryData;
      const associatedProducts = (category as PrestaShopCategory | undefined)?.associations?.products;
      const product = (associatedProducts as any)?.product;
      const products = Array.isArray(product) ? product : product ? [product] : [];
      products.forEach((entry: any) => {
        const productId = normalizeNullableId(entry?.id);
        if (productId) ids.add(productId);
      });
    } catch {
      // Some PrestaShop versions do not expose category associations reliably.
    }

    return Array.from(ids);
  }

  async moveProductsBetweenCategories(sourceCategoryId: string, targetCategoryId: string): Promise<{ moved: number; productIds: string[] }> {
    const sourceId = sourceCategoryId.trim();
    const targetId = targetCategoryId.trim();
    if (!sourceId) throw new Error('Source PrestaShop category id is required');
    if (!targetId) throw new Error('Target PrestaShop category id is required');
    if (sourceId === targetId) throw new Error('Source and target categories must be different');

    const productIds = await this.fetchCategoryProductIds(sourceId);
    let moved = 0;

    for (const productId of productIds) {
      const { text: productXml } = await this.fetchWebServiceText(`products/${encodeURIComponent(productId)}`, {
        headers: { Accept: 'application/xml' },
      });
      const payload = patchProductCategoryXml(productXml, sourceId, targetId);
      await this.fetchWebServiceText(`products/${encodeURIComponent(productId)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/xml',
          Accept: 'application/xml',
        },
        body: payload,
      });
      moved++;
    }

    return { moved, productIds };
  }

  async fetchOrderStates(): Promise<PrestaShopOrderStatusDetails[]> {
    const data = await this.fetchWebService<any>('order_states?display=full&sort=[id_ASC]&limit=1000');
    if (!data.order_states) return [];

    const states = Array.isArray(data.order_states) ? data.order_states : [data.order_states];
    return states.map((state: any) => ({
      id: String(state.id),
      name: normalizePrestaShopLocalizedValue(state.name) || `Status ${state.id}`,
      color: typeof state.color === 'string' && state.color.trim() ? state.color.trim() : undefined,
      paid: normalizeBooleanish(state.paid),
      deleted: normalizeBooleanish(state.deleted),
      shipped: normalizeBooleanish(state.shipped),
      invoice: normalizeBooleanish(state.invoice),
      delivery: normalizeBooleanish(state.delivery),
      payload: state,
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

  async deleteProduct(productId: string): Promise<void> {
    const id = productId.trim();
    if (!id) throw new Error('PrestaShop product id is required');

    await this.fetchWebServiceText(`products/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Accept: 'application/xml' },
    });
  }

  async setProductActive(productId: string, active: boolean): Promise<void> {
    const id = productId.trim();
    if (!id) throw new Error('PrestaShop product id is required');

    const { text: productXml } = await this.fetchWebServiceText(`products/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/xml' },
    });
    const payload = replaceSimpleXmlTag(productXml, 'active', active ? '1' : '0');

    await this.fetchWebServiceText(`products/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: payload,
    });
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

  async fetchOrderDetails(orderId: number, options: { bundleApiKey?: string } = {}): Promise<PrestaShopOrderDetails> {
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

      const [invoiceAddress, deliveryAddress, carrier, orderStatus] = await Promise.all([
        this.fetchAddressIfPresent(order.id_address_invoice),
        this.fetchAddressIfPresent(order.id_address_delivery),
        this.fetchCarrierIfPresent(order.id_carrier),
        this.fetchOrderStateIfPresent(order.current_state),
      ]);
      const invoiceCountry = await this.fetchCountryIfPresent(invoiceAddress?.id_country);
      const deliveryCountry = deliveryAddress?.id_country === invoiceAddress?.id_country
        ? invoiceCountry
        : await this.fetchCountryIfPresent(deliveryAddress?.id_country);

      // Fetch order items
      const items: Array<{
        id: number;
        product_id: number;
        product_attribute_id: number;
        product_reference: string;
        product_name: string;
        quantity: number;
        product_price?: string;
        unit_price_tax_incl?: string;
        unit_price_tax_excl?: string;
        total_price_tax_incl?: string;
        total_price_tax_excl?: string;
        tax_rate?: string;
        tax_name?: string;
        payload: Record<string, unknown>;
      }> = [];

      if (order.associations?.order_rows) {
        for (const row of order.associations.order_rows) {
          items.push({
            id: row.id,
            product_id: row.product_id,
            product_attribute_id: row.product_attribute_id ?? 0,
            product_reference: row.product_reference || '',
            product_name: row.product_name || '',
            quantity: row.product_quantity,
            product_price: row.product_price,
            unit_price_tax_incl: row.unit_price_tax_incl,
            unit_price_tax_excl: row.unit_price_tax_excl,
            total_price_tax_incl: row.total_price_tax_incl,
            total_price_tax_excl: row.total_price_tax_excl,
            tax_rate: row.tax_rate,
            tax_name: row.tax_name,
            payload: row as unknown as Record<string, unknown>,
          });
        }
      }

      const bundleSelections = options.bundleApiKey
        ? await this.fetchAdvancedBundleOrderSelections(orderId, options.bundleApiKey)
        : [];

      return {
        order,
        customer,
        invoiceAddress,
        deliveryAddress,
        invoiceCountry,
        deliveryCountry,
        carrier,
        orderStatus,
        items,
        bundleSelections,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to fetch order ${orderId} details: ${message}`);
    }
  }

  async createOrderHistory(input: { orderId: number | string; orderStateId: number | string }): Promise<void> {
    const orderId = String(input.orderId).trim();
    const orderStateId = String(input.orderStateId).trim();
    if (!orderId) throw new Error('PrestaShop order id is required');
    if (!orderStateId) throw new Error('PrestaShop order state id is required');

    await this.fetchWebServiceText('order_histories', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: buildOrderHistoryXml({ orderId, orderStateId }),
    });
  }

  async createOrderSlip(input: CreatePrestaShopOrderSlipInput): Promise<CreatePrestaShopOrderSlipResult> {
    const payload = buildOrderSlipXml(input);
    const { text, response } = await this.fetchWebServiceText('order_slip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: payload,
    });

    const idFromLocation = response.headers.get('location')?.match(/\/order_slip\/(\d+)\b/)?.[1];
    const id = idFromLocation ?? extractXmlTagValue(text, 'id') ?? null;
    return { id, raw: text };
  }

  async publishInvoiceLinkToOrder(input: PublishPrestaShopInvoiceLinkInput): Promise<PublishPrestaShopInvoiceLinkResult> {
    const orderId = normalizeId(input.orderId);
    if (!orderId) throw new Error('PrestaShop order id is required');

    const customerId = normalizeId(input.customerId);
    const orderMessageId = await this.createOrderMessage({
      orderId,
      cartId: normalizeId(input.cartId),
      customerId,
      message: input.message,
      private: false,
    });

    if (!input.customerHasAccount) {
      return {
        orderMessageId,
        customerThreadId: null,
        customerMessageId: null,
        customerPanelDelivered: false,
        customerPanelSkippedReason: 'Klient nie ma konta w sklepie albo zamówienie jest gościnne',
      };
    }

    if (!customerId) {
      return {
        orderMessageId,
        customerThreadId: null,
        customerMessageId: null,
        customerPanelDelivered: false,
        customerPanelSkippedReason: 'Brak ID klienta PrestaShop',
      };
    }

    try {
      const contactId = await this.fetchDefaultContactId();
      if (!contactId) {
        return {
          orderMessageId,
          customerThreadId: null,
          customerMessageId: null,
          customerPanelDelivered: false,
          customerPanelSkippedReason: 'Brak kontaktu PrestaShop do utworzenia wątku klienta',
        };
      }

      const customerThreadId = await this.findOrCreateCustomerThread({
        orderId,
        customerId,
        customerEmail: input.customerEmail ?? '',
        languageId: normalizeId(input.languageId) || '1',
        shopId: normalizeId(input.shopId),
        contactId,
      });
      const customerMessageId = await this.createCustomerMessage({
        customerThreadId,
        message: input.message,
        private: false,
      });

      return {
        orderMessageId,
        customerThreadId,
        customerMessageId,
        customerPanelDelivered: true,
      };
    } catch (error) {
      return {
        orderMessageId,
        customerThreadId: null,
        customerMessageId: null,
        customerPanelDelivered: false,
        customerPanelSkippedReason: error instanceof Error ? error.message : 'Nie udało się dodać wiadomości do panelu klienta',
      };
    }
  }

  private async fetchAddressIfPresent(addressId: unknown): Promise<PrestaShopAddress | null> {
    const id = normalizeId(addressId);
    if (!id) return null;

    const data = await this.fetchWebService<any>(`addresses/${encodeURIComponent(id)}?display=full`);
    return data.address || (data.addresses && data.addresses[0]) || data || null;
  }

  private async fetchCountryIfPresent(countryId: unknown): Promise<PrestaShopCountry | null> {
    const id = normalizeId(countryId);
    if (!id) return null;

    const data = await this.fetchWebService<any>(`countries/${encodeURIComponent(id)}?display=full`);
    return data.country || (data.countries && data.countries[0]) || data || null;
  }

  private async fetchCarrierIfPresent(carrierId: unknown): Promise<PrestaShopCarrier | null> {
    const id = normalizeId(carrierId);
    if (!id) return null;

    const data = await this.fetchWebService<any>(`carriers/${encodeURIComponent(id)}?display=full`);
    return data.carrier || (data.carriers && data.carriers[0]) || data || null;
  }

  private async fetchOrderStateIfPresent(stateId: unknown): Promise<PrestaShopOrderStatusDetails | null> {
    const id = normalizeId(stateId);
    if (!id) return null;

    const data = await this.fetchWebService<any>(`order_states/${encodeURIComponent(id)}?display=full`);
    const state = data.order_state || (data.order_states && data.order_states[0]) || data || null;
    if (!state) return null;

    return {
      id: String(state.id ?? id),
      name: normalizePrestaShopLocalizedValue(state.name) || `Status ${state.id ?? id}`,
      color: typeof state.color === 'string' && state.color.trim() ? state.color.trim() : undefined,
      paid: normalizeBooleanish(state.paid),
      deleted: normalizeBooleanish(state.deleted),
      shipped: normalizeBooleanish(state.shipped),
      invoice: normalizeBooleanish(state.invoice),
      delivery: normalizeBooleanish(state.delivery),
      payload: state,
    };
  }

  async fetchAdvancedBundleOrderSelections(orderId: number, apiKey: string): Promise<PrestaShopBundleOrderSelection[]> {
    const key = apiKey.trim();
    if (!key) throw new Error('kp_advancedbundle API key is empty');

    const url = new URL(`${this.baseUrl}/index.php`);
    url.searchParams.set('fc', 'module');
    url.searchParams.set('module', 'kp_advancedbundle');
    url.searchParams.set('controller', 'orderselections');
    url.searchParams.set('id_order', String(orderId));
    url.searchParams.set('api_key', key);

    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
    });

    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`kp_advancedbundle returned non-JSON response: ${text.slice(0, 120)}`);
    }

    if (!response.ok || !payload?.success) {
      const message = payload?.message || payload?.error || text.slice(0, 160) || `HTTP ${response.status}`;
      throw new Error(`kp_advancedbundle endpoint failed: ${message}`);
    }

    const rows: any[] = Array.isArray(payload?.data?.selections) ? payload.data.selections : [];
    return rows
      .map((row: any) => normalizeBundleSelection(row))
      .filter((row: PrestaShopBundleOrderSelection | null): row is PrestaShopBundleOrderSelection => Boolean(row));
  }

  async addOrderNote(orderId: number, message: string): Promise<void> {
    // This would require order_histories endpoint
    // Implementation depends on PrestaShop version
    console.log(`Would add note to order ${orderId}: ${message}`);
  }

  private async createOrderMessage(input: {
    orderId: string;
    cartId: string;
    customerId: string;
    message: string;
    private: boolean;
  }) {
    const { text, response } = await this.fetchWebServiceText('messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: buildOrderMessageXml(input),
    });
    return response.headers.get('location')?.match(/\/messages\/(\d+)\b/)?.[1] ?? extractXmlTagValue(text, 'id') ?? null;
  }

  private async fetchDefaultContactId() {
    const data = await this.fetchWebService<any>('contacts?display=[id]&sort=[id_ASC]&limit=1');
    const contacts = data.contacts
      ? Array.isArray(data.contacts) ? data.contacts : [data.contacts]
      : [];
    return normalizeId(contacts[0]?.id) || null;
  }

  private async findOrCreateCustomerThread(input: {
    orderId: string;
    customerId: string;
    customerEmail: string;
    languageId: string;
    shopId: string;
    contactId: string;
  }) {
    const query = [
      `filter[id_order]=[${encodeURIComponent(input.orderId)}]`,
      `filter[id_customer]=[${encodeURIComponent(input.customerId)}]`,
      'display=full',
      'sort=[id_DESC]',
      'limit=1',
    ].join('&');
    const data = await this.fetchWebService<any>(`customer_threads?${query}`);
    const threads = data.customer_threads
      ? Array.isArray(data.customer_threads) ? data.customer_threads : [data.customer_threads]
      : [];
    const existingId = normalizeId(threads[0]?.id);
    if (existingId) return existingId;

    const { text, response } = await this.fetchWebServiceText('customer_threads', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: buildCustomerThreadXml(input),
    });
    const createdId = response.headers.get('location')?.match(/\/customer_threads\/(\d+)\b/)?.[1] ?? extractXmlTagValue(text, 'id');
    if (!createdId) throw new Error('PrestaShop customer thread was created but response did not contain id');
    return createdId;
  }

  private async createCustomerMessage(input: {
    customerThreadId: string;
    message: string;
    private: boolean;
  }) {
    const { text, response } = await this.fetchWebServiceText('customer_messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: buildCustomerMessageXml(input),
    });
    return response.headers.get('location')?.match(/\/customer_messages\/(\d+)\b/)?.[1] ?? extractXmlTagValue(text, 'id') ?? null;
  }
}

function normalizeBundleSelection(row: any): PrestaShopBundleOrderSelection | null {
  const idOrderDetail = Number(row?.id_order_detail ?? row?.idOrderDetail);
  const idProductBundle = Number(row?.id_product_bundle ?? row?.idProductBundle);
  if (!Number.isFinite(idOrderDetail) || idOrderDetail <= 0 || !Number.isFinite(idProductBundle) || idProductBundle <= 0) {
    return null;
  }

  const components: any[] = Array.isArray(row?.components)
    ? row.components
    : Array.isArray(row?.selection?.components)
      ? row.selection.components
      : [];

  return {
    id_order_detail: idOrderDetail,
    id_product_bundle: idProductBundle,
    id_product_attribute_bundle: Number(row?.id_product_attribute_bundle ?? row?.idProductAttributeBundle ?? 0) || 0,
    bundle_name: String(row?.bundle_name ?? row?.bundleName ?? '').trim(),
    bundle_reference: String(row?.bundle_reference ?? row?.bundleReference ?? '').trim(),
    bundle_quantity: Number(row?.bundle_quantity ?? row?.bundleQuantity ?? 1) || 1,
    components: components
      .map((component: any) => normalizeBundleComponent(component))
      .filter((component: PrestaShopBundleComponent | null): component is PrestaShopBundleComponent => Boolean(component)),
  };
}

function normalizeBundleComponent(component: any): PrestaShopBundleComponent | null {
  const idProduct = Number(component?.id_product ?? component?.idProduct);
  if (!Number.isFinite(idProduct) || idProduct <= 0) return null;

  return {
    id_product: idProduct,
    id_product_attribute: Number(component?.id_product_attribute ?? component?.idProductAttribute ?? 0) || 0,
    reference: String(component?.reference ?? component?.sku ?? '').trim(),
    name: String(component?.name ?? component?.product_name ?? '').trim(),
    quantity: Number(component?.quantity ?? component?.qty ?? 1) || 1,
  };
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

function normalizePrestaShopCategory(category: PrestaShopCategory): PrestaShopCategoryDetails {
  const id = String(category.id);
  const parentId = normalizeNullableId(category.id_parent);

  return {
    id,
    name: normalizePrestaShopLocalizedValue(category.name) || `Kategoria ${id}`,
    active: category.active === undefined ? true : String(category.active) !== '0',
    parentId,
    levelDepth: normalizeNullableNumber(category.level_depth),
    position: normalizeNullableNumber(category.position),
    isRoot: normalizeBooleanish(category.is_root_category),
    nleft: normalizeNullableNumber(category.nleft),
    nright: normalizeNullableNumber(category.nright),
    path: '',
  };
}

function withCategoryPaths(categories: PrestaShopCategoryDetails[]): PrestaShopCategoryDetails[] {
  const byId = new Map(categories.map((category) => [category.id, category]));

  function buildPath(category: PrestaShopCategoryDetails, seen = new Set<string>()): string {
    if (seen.has(category.id)) return category.name;
    seen.add(category.id);

    const parent = category.parentId ? byId.get(category.parentId) : null;
    if (!parent || parent.id === category.id) return category.name;
    return `${buildPath(parent, seen)} / ${category.name}`;
  }

  return categories.map((category) => ({
    ...category,
    path: buildPath(category),
  }));
}

function sortCategoriesByPath(categories: PrestaShopCategoryDetails[]) {
  return [...categories].sort((left, right) => {
    const pathComparison = left.path.localeCompare(right.path, 'pl', { numeric: true, sensitivity: 'base' });
    if (pathComparison !== 0) return pathComparison;
    return Number(left.position ?? 0) - Number(right.position ?? 0);
  });
}

export function buildCategoryXml(input: CreatePrestaShopCategoryInput) {
  const languageId = String(input.languageId ?? 1);
  const name = input.name.trim();
  const parentId = String(input.parentId).trim();
  const linkRewrite = input.linkRewrite?.trim() || slugify(name);

  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <category>
    <id_parent>${escapeXml(parentId)}</id_parent>
    <active>${input.active === false ? 0 : 1}</active>
    ${input.idShopDefault ? `<id_shop_default>${escapeXml(String(input.idShopDefault))}</id_shop_default>` : ''}
    <name>
      <language id="${escapeXml(languageId)}"><![CDATA[${cdata(name)}]]></language>
    </name>
    <link_rewrite>
      <language id="${escapeXml(languageId)}"><![CDATA[${cdata(linkRewrite)}]]></language>
    </link_rewrite>
    <description>
      <language id="${escapeXml(languageId)}"><![CDATA[${cdata(input.description?.trim() || '')}]]></language>
    </description>
    <meta_title>
      <language id="${escapeXml(languageId)}"><![CDATA[${cdata(input.metaTitle?.trim() || '')}]]></language>
    </meta_title>
    <meta_description>
      <language id="${escapeXml(languageId)}"><![CDATA[${cdata(input.metaDescription?.trim() || '')}]]></language>
    </meta_description>
  </category>
</prestashop>`;
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

function replaceSimpleXmlTag(xml: string, tagName: string, value: string) {
  const pattern = new RegExp(`(<${tagName}\\b[^>]*>)([\\s\\S]*?)(</${tagName}>)`, 'i');
  if (!pattern.test(xml)) throw new Error(`PrestaShop XML missing <${tagName}>`);
  return xml.replace(pattern, (_match, openTag, _currentValue, closeTag) => `${openTag}${escapeXml(value)}${closeTag}`);
}

function patchProductCategoryXml(productXml: string, sourceCategoryId: string, targetCategoryId: string) {
  let payload = productXml;
  const currentDefault = extractXmlTagValue(productXml, 'id_category_default');
  if (currentDefault === sourceCategoryId) {
    payload = replaceSimpleXmlTag(payload, 'id_category_default', targetCategoryId);
  }

  const categoriesMatch = payload.match(/<categories\b[^>]*>([\s\S]*?)<\/categories>/i);
  const categoryIds = new Set<string>();
  if (categoriesMatch) {
    const categoryBlock = categoriesMatch[1] ?? '';
    for (const match of categoryBlock.matchAll(/<category\b[^>]*>[\s\S]*?<id>([\s\S]*?)<\/id>[\s\S]*?<\/category>/gi)) {
      const id = String(match[1] ?? '').trim();
      if (id && id !== sourceCategoryId) categoryIds.add(id);
    }
  }
  categoryIds.add(targetCategoryId);

  const nextCategories = Array.from(categoryIds).map((id) => `
        <category>
          <id>${escapeXml(id)}</id>
        </category>`).join('');
  const nextBlock = `<categories>${nextCategories}
      </categories>`;

  if (categoriesMatch) {
    return payload.replace(/<categories\b[^>]*>[\s\S]*?<\/categories>/i, nextBlock);
  }

  return payload.replace(/<\/associations>/i, `  ${nextBlock}\n    </associations>`);
}

function replaceLocalizedXmlTag(xml: string, tagName: string, value: string, languageId: string) {
  const tagPattern = new RegExp(`(<${tagName}\\b[^>]*>)([\\s\\S]*?)(</${tagName}>)`, 'i');
  const tagMatch = xml.match(tagPattern);
  if (!tagMatch) throw new Error(`PrestaShop category XML missing <${tagName}>`);

  const [, openTag, innerXml, closeTag] = tagMatch;
  const languagePattern = new RegExp(`(<language\\b[^>]*\\bid=["']?${escapeRegExp(languageId)}["']?[^>]*>)([\\s\\S]*?)(</language>)`, 'i');
  const nextLanguageXml = `${escapeXml(value)}`;
  const replacementInnerXml = languagePattern.test(innerXml)
    ? innerXml.replace(languagePattern, (_match, openLanguage, _currentValue, closeLanguage) => `${openLanguage}${nextLanguageXml}${closeLanguage}`)
    : `${innerXml}\n      <language id="${escapeXml(languageId)}">${nextLanguageXml}</language>`;

  return xml.replace(tagPattern, `${openTag}${replacementInnerXml}${closeTag}`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildOrderHistoryXml(input: { orderId: string; orderStateId: string }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <order_history>
    <id_order>${escapeXml(input.orderId)}</id_order>
    <id_order_state>${escapeXml(input.orderStateId)}</id_order_state>
  </order_history>
</prestashop>`;
}

function buildOrderMessageXml(input: { orderId: string; cartId?: string; customerId?: string; message: string; private: boolean }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <message>
    ${input.cartId ? `<id_cart>${escapeXml(input.cartId)}</id_cart>` : ''}
    <id_order>${escapeXml(input.orderId)}</id_order>
    ${input.customerId ? `<id_customer>${escapeXml(input.customerId)}</id_customer>` : ''}
    <message><![CDATA[${cdata(input.message)}]]></message>
    <private>${input.private ? 1 : 0}</private>
  </message>
</prestashop>`;
}

function buildCustomerThreadXml(input: {
  orderId: string;
  customerId: string;
  customerEmail: string;
  languageId: string;
  shopId?: string;
  contactId: string;
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <customer_thread>
    <id_lang>${escapeXml(input.languageId)}</id_lang>
    ${input.shopId ? `<id_shop>${escapeXml(input.shopId)}</id_shop>` : ''}
    <id_customer>${escapeXml(input.customerId)}</id_customer>
    <id_order>${escapeXml(input.orderId)}</id_order>
    <id_contact>${escapeXml(input.contactId)}</id_contact>
    ${input.customerEmail ? `<email><![CDATA[${cdata(input.customerEmail)}]]></email>` : ''}
    <token>${escapeXml(randomCustomerThreadToken())}</token>
    <status>open</status>
  </customer_thread>
</prestashop>`;
}

function buildCustomerMessageXml(input: { customerThreadId: string; message: string; private: boolean }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <customer_message>
    <id_customer_thread>${escapeXml(input.customerThreadId)}</id_customer_thread>
    <message><![CDATA[${cdata(input.message)}]]></message>
    <private>${input.private ? 1 : 0}</private>
    <read>0</read>
  </customer_message>
</prestashop>`;
}

function randomCustomerThreadToken() {
  return `kp${randomBytes(12).toString('hex')}`;
}

export function buildOrderSlipXml(input: CreatePrestaShopOrderSlipInput) {
  const orderId = String(input.orderId).trim();
  const customerId = String(input.customerId).trim();
  if (!orderId) throw new Error('PrestaShop order id is required');
  if (!customerId) throw new Error('PrestaShop customer id is required');
  if (input.details.length === 0 && !input.shippingCost) {
    throw new Error('PrestaShop order slip requires at least one detail or shipping refund');
  }

  const totalShippingTaxExcl = input.totalShippingTaxExcl ?? 0;
  const totalShippingTaxIncl = input.totalShippingTaxIncl ?? 0;
  const shippingCostAmount = input.shippingCostAmount ?? totalShippingTaxIncl;
  const amount = input.amount ?? input.totalProductsTaxIncl + totalShippingTaxIncl;

  return `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <order_slip>
    <id_customer>${escapeXml(customerId)}</id_customer>
    <id_order>${escapeXml(orderId)}</id_order>
    <conversion_rate>${formatDecimal(input.conversionRate ?? 1, 6)}</conversion_rate>
    <total_products_tax_excl>${formatDecimal(input.totalProductsTaxExcl)}</total_products_tax_excl>
    <total_products_tax_incl>${formatDecimal(input.totalProductsTaxIncl)}</total_products_tax_incl>
    <total_shipping_tax_excl>${formatDecimal(totalShippingTaxExcl)}</total_shipping_tax_excl>
    <total_shipping_tax_incl>${formatDecimal(totalShippingTaxIncl)}</total_shipping_tax_incl>
    <amount>${formatDecimal(amount)}</amount>
    <shipping_cost>${input.shippingCost ? 1 : 0}</shipping_cost>
    <shipping_cost_amount>${formatDecimal(shippingCostAmount)}</shipping_cost_amount>
    <partial>${input.partial ? 1 : 0}</partial>
    ${input.orderSlipType === undefined ? '' : `<order_slip_type>${escapeXml(String(input.orderSlipType))}</order_slip_type>`}
    <associations>
      <order_slip_details>
        ${input.details.map((detail) => `<order_slip_detail>
          <id_order_detail>${escapeXml(String(detail.idOrderDetail))}</id_order_detail>
          <product_quantity>${formatDecimal(detail.productQuantity, 3)}</product_quantity>
          <amount_tax_excl>${formatDecimal(detail.amountTaxExcl)}</amount_tax_excl>
          <amount_tax_incl>${formatDecimal(detail.amountTaxIncl)}</amount_tax_incl>
        </order_slip_detail>`).join('')}
      </order_slip_details>
    </associations>
  </order_slip>
</prestashop>`;
}

function formatDecimal(value: number, scale = 2) {
  if (!Number.isFinite(value)) return (0).toFixed(scale);
  return value.toFixed(scale);
}

function normalizeId(value: unknown) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  return text && text !== '0' ? text : '';
}

function normalizeNullableId(value: unknown) {
  const id = normalizeId(value);
  return id || null;
}

function normalizeNullableNumber(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeBooleanish(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
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
