/// <reference lib="dom" />
import type { Shop } from '@prisma/client';
import { decrypt } from '../../lib/encryption';

type ProductContentModuleConfig = {
  productContentUrl?: string | null;
  contentModuleUrl?: string | null;
  productContentApiKey?: string | null;
  contentModuleApiKey?: string | null;
  productContentEnabled?: boolean;
};

export class ProductContentConflictError extends Error {
  statusCode = 409;
  data: unknown;

  constructor(message: string, data: unknown) {
    super(message);
    this.name = 'ProductContentConflictError';
    this.data = data;
  }
}

export class PrestaShopProductContentAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly explicitModuleUrl: string | null;

  constructor(private readonly shop: Shop) {
    const config = this.config();
    this.baseUrl = shop.baseUrl.replace(/\/+$/, '');
    this.apiKey = String(config.productContentApiKey ?? config.contentModuleApiKey ?? '').trim();
    this.explicitModuleUrl = normalizeUrl(config.productContentUrl ?? config.contentModuleUrl);
  }

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async capabilities() {
    return this.request('capabilities', { method: 'GET' });
  }

  async snapshot(productId: string, query: { langId?: number | string } = {}) {
    const params = new URLSearchParams({ productId });
    if (query.langId) params.set('langId', String(query.langId));
    return this.request(`snapshot&${params.toString()}`, { method: 'GET' });
  }

  async patch(productId: string, payload: Record<string, unknown>) {
    return this.request('patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, productId }),
    });
  }

  async mediaImport(productId: string, payload: Record<string, unknown>) {
    return this.request('mediaimport', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, productId }),
    });
  }

  async mediaOrder(productId: string, payload: Record<string, unknown>) {
    return this.request('mediaorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, productId }),
    });
  }

  async mediaUpdate(productId: string, payload: Record<string, unknown>) {
    return this.request('mediaupdate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, productId }),
    });
  }

  async mediaDelete(productId: string, payload: Record<string, unknown>) {
    return this.request('mediadelete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, productId }),
    });
  }

  private async request(controller: string, init: RequestInit) {
    if (!this.apiKey) {
      throw new Error('Moduł kp_productcontent nie ma skonfigurowanego klucza API');
    }

    const url = this.endpoint(controller);
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        'X-Api-Key': this.apiKey,
        ...(init.headers || {}),
      },
    });

    const text = await response.text();
    let json: { success?: boolean; data?: unknown; errors?: string[] } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`kp_productcontent returned non-JSON response: ${text.slice(0, 160)}`);
    }

    if (!response.ok || !json?.success) {
      const message = json?.errors?.join(', ') || text.slice(0, 160) || `HTTP ${response.status}`;
      if (response.status === 409) throw new ProductContentConflictError(message, json?.data);
      throw new Error(`kp_productcontent ${response.status}: ${message}`);
    }

    return json.data;
  }

  private endpoint(controller: string) {
    const [name, qs] = controller.split('&', 2);
    const base = this.explicitModuleUrl
      ? `${this.explicitModuleUrl.replace(/\/+$/, '')}/${encodeURIComponent(name)}`
      : `${this.baseUrl}/index.php?fc=module&module=kp_productcontent&controller=${encodeURIComponent(name)}`;
    if (this.explicitModuleUrl) return qs ? `${base}?${qs}` : base;
    return qs ? `${base}&${qs}` : base;
  }

  private config(): ProductContentModuleConfig {
    return (this.shop.configJson || {}) as ProductContentModuleConfig;
  }
}

function normalizeUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function buildPrestaShopProductContentAdapter(shop: Shop) {
  // Touch the regular API key so misconfigured legacy shop records fail early in diagnostics,
  // but do not use it for product content writes.
  decrypt(shop.apiKey || '');
  if (shop.platform !== 'PRESTASHOP') {
    throw new Error(`Product content adapter does not support platform ${shop.platform}`);
  }
  if (shop.status !== 'ACTIVE') {
    throw new Error('Sklep jest nieaktywny');
  }
  return new PrestaShopProductContentAdapter(shop);
}
