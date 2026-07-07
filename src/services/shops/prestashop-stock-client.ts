/// <reference lib="dom" />
import { Buffer } from 'node:buffer';
import type {
  ShopPriceBulkUpdateItem,
  ShopPriceBulkUpdateResult,
  ShopProductInventorySnapshot,
  ShopStockClient,
  ShopStockUpdateOptions,
} from './shop-stock-client.interface';

export const DEFAULT_BULK_STOCK_BATCH_SIZE = 500;
export const MIN_BULK_STOCK_BATCH_SIZE = 1;
export const MAX_BULK_STOCK_BATCH_SIZE = 500;

export interface BulkStockItem {
  productId: number;
  quantity?: number;
  inStockQty?: number | null;
  leadTimeDays?: number | null;
  warehouseAvailableAt?: string | null;
  outOfStockBehavior?: 0 | 1;
  availabilityPolicy?: 'IN_STOCK' | 'IN_STOCK_WITH_BACKORDER' | 'BACKORDER_FROM_WHOLESALE' | 'OUT_OF_STOCK';
  active?: boolean;
  idProductAttribute?: number;
}

export interface BulkStockResult {
  updated: number;
  errors: string[];
  results: Array<{
    productId: number;
    quantity?: number;
    inStockQty?: number | null;
    leadTimeDays?: number | null;
    warehouseAvailableAt?: string | null;
    outOfStockBehavior?: 0 | 1;
    availabilityPolicy?: 'IN_STOCK' | 'IN_STOCK_WITH_BACKORDER' | 'BACKORDER_FROM_WHOLESALE' | 'OUT_OF_STOCK';
    active?: boolean;
    idProductAttribute?: number;
    status: 'ok' | 'error';
    message?: string;
  }>;
}

interface BulkStockSnapshot {
  productId: number;
  idProductAttribute?: number;
  idShop?: number;
  quantity?: number;
  stockAvailableId?: string | null;
  outOfStockBehavior?: number | null;
  availableForOrder?: boolean | null;
  showPrice?: boolean | null;
  availableNow?: string | null;
  availableLater?: string | null;
  syncedLeadTimeDays?: number | null;
  effectiveLeadTimeDays?: number | null;
  etaLabel?: string | null;
}

export class PrestaShopStockClient implements ShopStockClient {
  private baseUrl: string;
  private apiKey: string;
  private bulkStockUrl: string | null;
  private bulkStockApiKey: string | null;
  private bulkStockBatchSize: number;
  private prestashopShopId: string | null;

  constructor(config: {
    baseUrl: string;
    apiKey: string;
    bulkStockUrl?: string | null;
    bulkStockApiKey?: string | null;
    bulkStockBatchSize?: number | string | null;
    prestashopShopId?: string | number | null;
  }) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
    this.apiKey = config.apiKey;
    this.prestashopShopId = normalizeNullableString(config.prestashopShopId);
    this.bulkStockUrl = normalizeNullableString(config.bulkStockUrl);
    this.bulkStockApiKey = normalizeNullableString(config.bulkStockApiKey);
    this.bulkStockBatchSize = normalizeBulkStockBatchSize(config.bulkStockBatchSize);
  }

  get hasBulkModule(): boolean {
    return Boolean(this.bulkStockUrl && this.bulkStockApiKey);
  }

  get configuredPrestaShopShopId(): string | null {
    return this.prestashopShopId;
  }

  async bulkUpdateStock(items: BulkStockItem[]): Promise<BulkStockResult> {
    if (!this.bulkStockUrl || !this.bulkStockApiKey) {
      throw new Error('Moduł kp_adminconnector nie jest skonfigurowany dla tego sklepu');
    }

    const combined: BulkStockResult = { updated: 0, errors: [], results: [] };

    for (let i = 0; i < items.length; i += this.bulkStockBatchSize) {
      const batch = items.slice(i, i + this.bulkStockBatchSize);
      const payloadItems = batch.map((item) => ({
        productId: item.productId,
        ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
        ...(item.inStockQty === undefined ? {} : { inStockQty: normalizeInStockQty(item.inStockQty) }),
        ...(item.leadTimeDays === undefined ? {} : { leadTimeDays: normalizeLeadTimeDays(item.leadTimeDays) }),
        ...(item.warehouseAvailableAt === undefined ? {} : { warehouseAvailableAt: normalizeWarehouseAvailableAt(item.warehouseAvailableAt) }),
        ...(item.outOfStockBehavior === undefined ? {} : { outOfStockBehavior: normalizeOutOfStockBehavior(item.outOfStockBehavior) }),
        ...(item.availabilityPolicy === undefined ? {} : { availabilityPolicy: normalizeAvailabilityPolicy(item.availabilityPolicy) }),
        ...(item.active === undefined ? {} : { active: normalizeOptionalBoolean(item.active) }),
        ...(item.idProductAttribute === undefined ? {} : { idProductAttribute: item.idProductAttribute }),
      }));
      for (const item of payloadItems) {
        if (item.quantity === undefined && item.leadTimeDays === undefined) {
          throw new Error(`kp_adminconnector item for product ${item.productId} requires quantity or leadTimeDays`);
        }
      }
      const res = await fetch(this.moduleUrl(this.bulkStockUrl, 'bulkupdate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Api-Key': this.bulkStockApiKey,
        },
        body: JSON.stringify({ items: payloadItems }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`kp_adminconnector HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = await res.json().catch(() => null) as { success: boolean; data?: Partial<BulkStockResult>; errors?: string[] } | null;
      if (!json) {
        throw new Error('kp_adminconnector returned non-JSON response');
      }
      if (!json.success) {
        throw new Error(`kp_adminconnector error: ${json.errors?.join(', ') ?? 'Unknown error'}`);
      }

      const result = json.data ?? {};
      combined.updated += Number(result.updated ?? 0);
      combined.errors.push(...(Array.isArray(result.errors) ? result.errors : []));
      combined.results.push(...(Array.isArray(result.results) ? result.results : []));
    }

    console.log(
      `[PrestaShopStockClient] bulk update: ${combined.updated} updated, ` +
      `${combined.errors.length} errors, batchSize=${this.bulkStockBatchSize}`,
    );
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

    if (options.availabilityPolicy) {
      await this.updateProductOrderAvailability(externalProductId, options);
    }
  }

  async updateProductPrice(externalProductId: string, price: number, options: { wholesalePrice?: number | null } = {}): Promise<void> {
    if (!Number.isFinite(price) || price < 0) {
      throw new Error(`Invalid product price for PrestaShop product ${externalProductId}`);
    }
    if (options.wholesalePrice !== undefined && options.wholesalePrice !== null && (!Number.isFinite(options.wholesalePrice) || options.wholesalePrice < 0)) {
      throw new Error(`Invalid wholesale price for PrestaShop product ${externalProductId}`);
    }

    const productXml = await this.fetchWebServiceText(`products/${encodeURIComponent(externalProductId)}`, {
      headers: { Accept: 'application/xml' },
    });

    const payload = replaceProductPriceXml(productXml, price, options.wholesalePrice);

    await this.fetchWebServiceText(`products/${encodeURIComponent(externalProductId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/xml',
        Accept: 'application/xml',
      },
      body: payload,
    });
  }

  async bulkUpdateProductPrices(items: ShopPriceBulkUpdateItem[]): Promise<ShopPriceBulkUpdateResult> {
    if (!this.bulkStockUrl || !this.bulkStockApiKey) {
      throw new Error('Moduł kp_adminconnector nie jest skonfigurowany dla bulk aktualizacji cen');
    }

    const combined: ShopPriceBulkUpdateResult = { updated: 0, errors: [], results: [] };

    for (let i = 0; i < items.length; i += this.bulkStockBatchSize) {
      const batch = items.slice(i, i + this.bulkStockBatchSize);
      const payloadItems = batch.map((item) => {
        const productId = Number(item.externalProductId);
        if (!Number.isInteger(productId) || productId <= 0) {
          throw new Error(`Invalid PrestaShop product id for bulk price update: ${item.externalProductId}`);
        }
        if (!Number.isFinite(item.price) || item.price < 0) {
          throw new Error(`Invalid product price for PrestaShop product ${item.externalProductId}`);
        }
        if (item.wholesalePrice !== undefined && item.wholesalePrice !== null && (!Number.isFinite(item.wholesalePrice) || item.wholesalePrice < 0)) {
          throw new Error(`Invalid wholesale price for PrestaShop product ${item.externalProductId}`);
        }

        return {
          productId,
          price: item.price,
          ...(item.wholesalePrice === undefined || item.wholesalePrice === null ? {} : { wholesalePrice: item.wholesalePrice }),
        };
      });

      const res = await fetch(this.moduleUrl(this.bulkStockUrl, 'bulkupdate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Api-Key': this.bulkStockApiKey,
        },
        body: JSON.stringify({ items: payloadItems }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`kp_adminconnector price bulk HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const json = await res.json().catch(() => null) as { success: boolean; data?: Partial<ShopPriceBulkUpdateResult>; errors?: string[] } | null;
      if (!json) {
        throw new Error('kp_adminconnector price bulk returned non-JSON response');
      }
      if (!json.success) {
        throw new Error(`kp_adminconnector price bulk error: ${json.errors?.join(', ') ?? 'Unknown error'}`);
      }

      const result = json.data ?? {};
      combined.updated += Number(result.updated ?? 0);
      combined.errors.push(...(Array.isArray(result.errors) ? result.errors : []));
      combined.results.push(...(Array.isArray(result.results) ? result.results : []));
    }

    console.log(
      `[PrestaShopStockClient] bulk price update: ${combined.updated} updated, ` +
      `${combined.errors.length} errors, batchSize=${this.bulkStockBatchSize}`,
    );
    return combined;
  }

  async updateProductOrderAvailability(
    externalProductId: string,
    options: Pick<ShopStockUpdateOptions, 'availabilityPolicy' | 'leadTimeDays' | 'warehouseAvailableAt' | 'active'>,
  ): Promise<void> {
    const productXml = await this.fetchWebServiceText(`products/${encodeURIComponent(externalProductId)}`, {
      headers: { Accept: 'application/xml' },
    });

    const payload = replaceProductOrderAvailabilityXml(productXml, options);

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
    const [product, stockAvailable, bulkSnapshot] = await Promise.all([
      this.fetchWebService<any>(`products/${encodeURIComponent(externalProductId)}`),
      this.findStockAvailable(externalProductId),
      this.fetchBulkStockSnapshot(externalProductId),
    ]);

    const productData = product.product || (product.products && product.products[0]) || product;
    const price = productData?.price === undefined || productData.price === ''
      ? undefined
      : Number(productData.price);
    const stock = bulkSnapshot?.quantity ?? stockAvailable?.quantity;
    const outOfStockBehavior = bulkSnapshot?.outOfStockBehavior ?? normalizeNullableNumber(stockAvailable?.outOfStock);
    const availableForOrder = bulkSnapshot?.availableForOrder ?? normalizeNullableBoolean(productData?.available_for_order);

    return {
      externalProductId,
      price: Number.isFinite(price) ? price : undefined,
      stock,
      stockAvailableId: bulkSnapshot?.stockAvailableId ?? stockAvailable?.id,
      idShop: bulkSnapshot?.idShop === undefined ? stockAvailable?.idShop : String(bulkSnapshot.idShop),
      outOfStockBehavior,
      availableForOrder,
      showPrice: bulkSnapshot?.showPrice ?? normalizeNullableBoolean(productData?.show_price),
      leadTimeDays: bulkSnapshot?.syncedLeadTimeDays ?? null,
      effectiveLeadTimeDays: bulkSnapshot?.effectiveLeadTimeDays ?? null,
      nativeAvailableNow: bulkSnapshot?.availableNow ?? null,
      nativeAvailableLater: bulkSnapshot?.availableLater ?? null,
      etaLabel: bulkSnapshot?.etaLabel ?? null,
      availabilityPolicy: inferAvailabilityPolicy(stock, outOfStockBehavior, availableForOrder),
      etaDiagnosticsAvailable: Boolean(bulkSnapshot),
    };
  }

  async getStockAvailableSnapshot(externalProductId: string): Promise<ShopProductInventorySnapshot> {
    const stockAvailable = await this.findStockAvailable(externalProductId);

    return {
      externalProductId,
      stock: stockAvailable?.quantity,
      stockAvailableId: stockAvailable?.id,
      idShop: stockAvailable?.idShop,
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

    const entry = selectStockAvailableEntry(entries, this.prestashopShopId);

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

  private async fetchBulkStockSnapshot(externalProductId: string): Promise<BulkStockSnapshot | null> {
    if (!this.bulkStockApiKey || !this.bulkStockUrl) return null;

    const productId = Number(externalProductId);
    if (!Number.isInteger(productId) || productId <= 0) return null;

    try {
      const url = this.moduleUrl(this.bulkStockUrl, 'stocksnapshot', { productId });
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Api-Key': this.bulkStockApiKey,
        },
      });

      if (!response.ok) {
        return null;
      }

      const json = await response.json().catch(() => null) as { success?: boolean; data?: BulkStockSnapshot } | null;
      if (!json?.success || !json.data) return null;

      return json.data;
    } catch {
      return null;
    }
  }

  private moduleUrl(url: string, controller: string, params: Record<string, string | number | null | undefined> = {}) {
    return buildModuleControllerUrl(url, controller, {
      ...params,
      idShop: this.prestashopShopId,
    });
  }
}

function selectStockAvailableEntry(entries: any[], prestashopShopId: string | null) {
  const shopId = normalizeNullableString(prestashopShopId);
  const simpleEntries = entries.filter((entry) => String(entry.id_product_attribute ?? '0') === '0');
  const candidates = simpleEntries.length > 0 ? simpleEntries : entries;

  if (shopId) {
    const exactShop = candidates.find((entry) => String(entry.id_shop ?? '') === shopId);
    if (exactShop) return exactShop;

    const exactGroup = candidates.find((entry) => String(entry.id_shop_group ?? '') === shopId);
    if (exactGroup) return exactGroup;
  }

  return candidates.find((entry) => String(entry.id_shop ?? '0') !== '0') ?? candidates[0];
}

function normalizeNullableString(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeBulkStockBatchSize(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_BULK_STOCK_BATCH_SIZE;
  const size = Number(value);
  if (
    !Number.isInteger(size) ||
    size < MIN_BULK_STOCK_BATCH_SIZE ||
    size > MAX_BULK_STOCK_BATCH_SIZE
  ) {
    return DEFAULT_BULK_STOCK_BATCH_SIZE;
  }
  return size;
}

function normalizeLeadTimeDays(value: unknown) {
  if (value === null) return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new Error('leadTimeDays must be an integer between 0 and 365');
  }
  return days;
}

function normalizeInStockQty(value: unknown) {
  if (value === null) return null;
  const qty = Number(value);
  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error('inStockQty must be a non-negative integer or null');
  }
  return qty;
}

function normalizeWarehouseAvailableAt(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new Error('warehouseAvailableAt must be a YYYY-MM-DD string or null');
  }

  const dateValue = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    throw new Error('warehouseAvailableAt must use YYYY-MM-DD format');
  }

  const parsed = new Date(`${dateValue}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dateValue) {
    throw new Error('warehouseAvailableAt must be a valid calendar date');
  }

  return dateValue;
}

function normalizeOutOfStockBehavior(value: unknown) {
  const behavior = Number(value);
  if (behavior !== 0 && behavior !== 1) {
    throw new Error('outOfStockBehavior must be 0 or 1');
  }
  return behavior as 0 | 1;
}

function normalizeAvailabilityPolicy(value: unknown) {
  if (
    value === 'IN_STOCK' ||
    value === 'IN_STOCK_WITH_BACKORDER' ||
    value === 'BACKORDER_FROM_WHOLESALE' ||
    value === 'OUT_OF_STOCK'
  ) {
    return value;
  }
  throw new Error('availabilityPolicy must be IN_STOCK, IN_STOCK_WITH_BACKORDER, BACKORDER_FROM_WHOLESALE or OUT_OF_STOCK');
}

function normalizeOptionalBoolean(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new Error('active must be boolean');
}

export function buildAdminConnectorControllerUrl(
  moduleUrl: string | null,
  controller: string,
  params: Record<string, string | number> = {},
) {
  if (!moduleUrl) return null;

  const trimmed = moduleUrl.replace(/\/+$/, '');
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => query.set(key, String(value)));
  const suffix = query.toString();

  if (trimmed.includes('?')) {
    const separator = trimmed.includes('controller=') ? '&' : '&';
    if (trimmed.includes('controller=')) {
      const replaced = trimmed.replace(/([?&]controller=)[^&]*/, `$1${encodeURIComponent(controller)}`);
      return suffix ? `${replaced}&${suffix}` : replaced;
    }
    return `${trimmed}${separator}controller=${encodeURIComponent(controller)}${suffix ? `&${suffix}` : ''}`;
  }

  const base = stripKnownModuleController(trimmed);
  return `${base}/${encodeURIComponent(controller)}${suffix ? `?${suffix}` : ''}`;
}

function buildModuleControllerUrl(
  moduleUrl: string,
  controller: string,
  params: Record<string, string | number | null | undefined> = {},
) {
  const trimmed = moduleUrl.replace(/\/+$/, '');

  if (trimmed.includes('?')) {
    const url = trimmed.includes('controller=')
      ? trimmed.replace(/([?&]controller=)[^&]*/, `$1${encodeURIComponent(controller)}`)
      : `${trimmed}&controller=${encodeURIComponent(controller)}`;
    return withQueryParams(url, params);
  }

  const base = stripKnownModuleController(trimmed);
  return withQueryParams(`${base}/${encodeURIComponent(controller)}`, params);
}

function stripKnownModuleController(url: string) {
  return url.replace(/\/(?:bulkupdate|snapshot|stocksnapshot|capabilities|patch|mediaimport|mediaorder|mediaupdate|mediadelete|carrierrestrictions)$/i, '');
}

function withQueryParams(url: string, params: Record<string, string | number | null | undefined>) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    query.set(key, String(value));
  });

  const suffix = query.toString();
  if (!suffix) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${suffix}`;
}

export function buildStockAvailableXml(input: {
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

function cdata(value: string) {
  return value.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

export function replaceProductPriceXml(xml: string, price: number, wholesalePrice?: number | null) {
  const normalizedPrice = price.toFixed(2);
  let nextXml = stripProductReadonlyFields(xml);

  if (!/<price\b[^>]*>[\s\S]*?<\/price>/.test(nextXml)) {
    throw new Error('PrestaShop product XML does not contain a price field');
  }

  nextXml = nextXml.replace(
    /<price\b([^>]*)>[\s\S]*?<\/price>/,
    `<price$1>${normalizedPrice}</price>`,
  );

  if (wholesalePrice !== undefined && wholesalePrice !== null) {
    nextXml = replaceSimpleProductField(nextXml, 'wholesale_price', wholesalePrice.toFixed(2));
  }

  return nextXml;
}

export function replaceProductOrderAvailabilityXml(
  xml: string,
  options: Pick<ShopStockUpdateOptions, 'availabilityPolicy' | 'leadTimeDays' | 'warehouseAvailableAt' | 'active'>,
) {
  const availableForOrder = options.availabilityPolicy === 'OUT_OF_STOCK' ? 0 : 1;
  const showPrice = 1;
  const messages = buildAvailabilityMessages(options);

  let nextXml = stripProductReadonlyFields(xml);
  if (options.active !== undefined) {
    nextXml = replaceSimpleProductField(nextXml, 'active', options.active ? '1' : '0');
  }
  nextXml = replaceSimpleProductField(nextXml, 'available_for_order', String(availableForOrder));
  nextXml = replaceSimpleProductField(nextXml, 'show_price', String(showPrice));
  nextXml = replaceLocalizedTextField(nextXml, 'available_now', messages.availableNow);
  nextXml = replaceLocalizedTextField(nextXml, 'available_later', messages.availableLater);
  return nextXml;
}

function stripProductReadonlyFields(xml: string) {
  return xml
    .replace(/\s*<manufacturer_name\b[^>]*>[\s\S]*?<\/manufacturer_name>/g, '')
    .replace(/\s*<quantity\b[^>]*>[\s\S]*?<\/quantity>/g, '')
    // position_in_category is a virtual webservice field whose getter is 0-based
    // while setWsPositionInCategory() requires >= 1, so round-tripping it on PUT
    // throws PrestaShop errors 134 ("0 or negative position") / 135 ("greater than
    // total in category"). We never change positions here, so strip it.
    .replace(/\s*<position_in_category\b[^>]*>[\s\S]*?<\/position_in_category>/g, '');
}

function replaceSimpleProductField(xml: string, field: string, value: string) {
  const replacement = `<${field}>${escapeXml(value)}</${field}>`;
  const fieldPattern = new RegExp(`<${field}\\b[^>]*>[\\s\\S]*?<\\/${field}>`);
  if (fieldPattern.test(xml)) return xml.replace(fieldPattern, replacement);

  if (field === 'available_for_order' && /<show_price\b[^>]*>/.test(xml)) {
    return xml.replace(/<show_price\b[^>]*>/, `${replacement}\n    $&`);
  }

  if (/<visibility\b[^>]*>/.test(xml)) {
    return xml.replace(/<visibility\b[^>]*>/, `${replacement}\n    $&`);
  }

  return xml.replace('</product>', `    ${replacement}\n  </product>`);
}

function replaceLocalizedTextField(xml: string, field: string, value: string) {
  const fieldPattern = new RegExp(`<${field}\\b[^>]*>[\\s\\S]*?<\\/${field}>`);
  if (!fieldPattern.test(xml)) return xml;

  return xml.replace(fieldPattern, (fieldXml) => {
    if (!/<language\b[^>]*>/.test(fieldXml)) {
      return `<${field}>${escapeXml(value)}</${field}>`;
    }

    return fieldXml.replace(
      /<language\b([^>]*)>[\s\S]*?<\/language>/g,
      `<language$1><![CDATA[${cdata(value)}]]></language>`,
    );
  });
}

function buildAvailabilityMessages(
  options: Pick<ShopStockUpdateOptions, 'availabilityPolicy' | 'leadTimeDays' | 'warehouseAvailableAt'>,
) {
  if (options.availabilityPolicy === 'OUT_OF_STOCK') return { availableNow: '', availableLater: '' };

  const message = buildShippingPromiseMessage(options);
  return options.availabilityPolicy === 'IN_STOCK'
    ? { availableNow: message, availableLater: '' }
    : { availableNow: '', availableLater: message };
}

function normalizeNullableBoolean(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return null;
}

function normalizeNullableNumber(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferAvailabilityPolicy(
  stock?: number,
  outOfStockBehavior?: number | null,
  availableForOrder?: boolean | null,
): ShopProductInventorySnapshot['availabilityPolicy'] {
  if (availableForOrder === false) return 'OUT_OF_STOCK';
  if ((stock ?? 0) > 0) return 'IN_STOCK';
  if (availableForOrder === true && outOfStockBehavior === 1) return 'BACKORDER_FROM_WHOLESALE';
  if (availableForOrder === true) return 'OUT_OF_STOCK';
  return null;
}

function buildShippingPromiseMessage(
  options: Pick<ShopStockUpdateOptions, 'availabilityPolicy' | 'leadTimeDays' | 'warehouseAvailableAt'>,
) {
  if (options.warehouseAvailableAt) return `Wysyłka do ${formatPolishDate(parseDateOnly(options.warehouseAvailableAt))}`;
  if (options.leadTimeDays === 0) return 'Wysyłka dzisiaj';
  if (options.leadTimeDays === 1) return 'Wysyłka jutro';
  if (options.leadTimeDays === 2) return 'Wysyłka pojutrze';
  if (options.leadTimeDays !== undefined && options.leadTimeDays !== null) {
    return `Wysyłka do ${formatPolishDate(addBusinessDays(todayDateOnly(), options.leadTimeDays))}`;
  }
  return options.availabilityPolicy === 'BACKORDER_FROM_WHOLESALE'
    ? 'Wysyłka po potwierdzeniu hurtowni'
    : 'Wysyłka dzisiaj';
}

function parseDateOnly(value: string) {
  const [year, month, day] = value.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function todayDateOnly() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function addBusinessDays(date: Date, days: number) {
  let next = date;
  let remaining = days;
  while (remaining > 0) {
    next = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate() + 1));
    const day = next.getUTCDay();
    if (day !== 0 && day !== 6) remaining--;
  }
  return next;
}

function formatPolishDate(date: Date) {
  return new Intl.DateTimeFormat('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}
