/// <reference lib="dom" />
import type { Prisma } from '@prisma/client';
import { decrypt } from '../../lib/encryption';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { buildAdminConnectorControllerUrl } from '../shops/prestashop-stock-client';

export interface CreateOrderShipmentInput {
  force?: boolean;
  service?: string;
  sendingMethod?: string;
  parcelsCount?: number;
  parcels?: Array<Record<string, unknown>>;
  printLabel?: boolean;
}

export interface RefreshOrderShipmentInput {
  idShipment?: number | string;
}

export interface OrderShipmentLabelQuery {
  idShipment?: number | string;
  format?: string;
  type?: string;
}

export interface OrderShipmentLabelFile {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

type ShipmentOrder = Prisma.OrderGetPayload<{
  include: { shop: true };
}>;

type ConnectorJson<T> = {
  success?: boolean;
  data?: T;
  errors?: string[];
};

function tenantWhere() {
  const tenantId = getTenantId();
  return tenantId ? { shop: { tenantId } } : {};
}

async function loadOrder(id: string): Promise<ShipmentOrder> {
  const order = await prisma.order.findFirst({
    where: {
      id,
      ...tenantWhere(),
    },
    include: {
      shop: true,
    },
  });

  if (!order) throw new Error('Zamówienie nie zostało znalezione');
  if (order.shop.platform !== 'PRESTASHOP') {
    throw new Error('Listy InPost przez connector są dostępne tylko dla zamówień PrestaShop');
  }

  return order;
}

export async function getOrderShipment(orderId: string) {
  const order = await loadOrder(orderId);
  return connectorJsonRequest(order, 'inpostshipmentstatus', 'GET', undefined, {
    id_order: order.externalOrderId,
  });
}

export async function createOrderShipment(orderId: string, input: CreateOrderShipmentInput = {}) {
  const order = await loadOrder(orderId);
  return connectorJsonRequest(order, 'inpostshipmentcreate', 'POST', {
    idOrder: Number(order.externalOrderId),
    ...input,
  });
}

export async function refreshOrderShipment(orderId: string, input: RefreshOrderShipmentInput = {}) {
  const order = await loadOrder(orderId);
  return connectorJsonRequest(order, 'inpostshipmentrefresh', 'POST', {
    idOrder: Number(order.externalOrderId),
    ...(input.idShipment ? { idShipment: Number(input.idShipment) } : {}),
  });
}

export async function downloadOrderShipmentLabel(
  orderId: string,
  query: OrderShipmentLabelQuery = {},
): Promise<OrderShipmentLabelFile> {
  const order = await loadOrder(orderId);
  const url = connectorUrl(order, 'inpostshipmentlabel', {
    id_order: order.externalOrderId,
    ...(query.idShipment ? { id_shipment: String(query.idShipment) } : {}),
    ...(query.format ? { format: query.format } : {}),
    ...(query.type ? { type: query.type } : {}),
  });

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/pdf',
      'X-Api-Key': connectorApiKey(order.shop, normalizeConfig(order.shop.configJson)),
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(await connectorErrorMessage(response));
  }

  const contentType = response.headers.get('content-type') || 'application/pdf';
  const contentDisposition = response.headers.get('content-disposition');
  const arrayBuffer = await response.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    contentType,
    filename: filenameFromContentDisposition(contentDisposition) ?? `inpost-${order.orderReference}.pdf`,
  };
}

async function connectorJsonRequest<T = unknown>(
  order: ShipmentOrder,
  controller: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  query: Record<string, string | number | null | undefined> = {},
): Promise<T> {
  const url = connectorUrl(order, controller, query);
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Key': connectorApiKey(order.shop, normalizeConfig(order.shop.configJson)),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(30_000),
  });

  const text = await response.text();
  let parsed: ConnectorJson<T> | null = null;
  try {
    parsed = text ? JSON.parse(text) as ConnectorJson<T> : null;
  } catch {
    parsed = null;
  }

  if (!response.ok || parsed?.success === false) {
    const message = parsed?.errors?.join(', ') || text.slice(0, 300) || `HTTP ${response.status}`;
    throw new Error(message);
  }

  return (parsed?.data ?? parsed) as T;
}

function connectorUrl(
  order: ShipmentOrder,
  controller: string,
  params: Record<string, string | number | null | undefined>,
) {
  const config = normalizeConfig(order.shop.configJson);
  const prestashopShopId = prestashopShopIdFromConfig(config);
  if (prestashopShopId === null) {
    throw new Error('Brak prestashopShopId w konfiguracji sklepu. Ustaw ID sklepu PrestaShop dla multishop.');
  }

  const baseUrl = connectorBaseUrl(order.shop.baseUrl, config);
  const filteredParams: Record<string, string | number> = {
    idShop: prestashopShopId,
  };
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    filteredParams[key] = value;
  });

  const url = buildAdminConnectorControllerUrl(baseUrl, controller, filteredParams);
  if (!url) throw new Error('Brak URL connectora PrestaShop dla sklepu.');
  return url;
}

function connectorBaseUrl(baseUrl: string, config: Record<string, unknown>) {
  const configuredUrl = normalizeUrl(config.adminConnectorUrl);
  if (configuredUrl) return configuredUrl;

  return `${baseUrl.replace(/\/+$/, '').replace(/\/api$/, '')}/index.php?fc=module&module=kp_adminconnector&controller=capabilities`;
}

function connectorApiKey(
  shop: ShipmentOrder['shop'],
  config: Record<string, unknown>,
) {
  for (const key of ['adminConnectorApiKey', 'productContentApiKey', 'contentModuleApiKey', 'bulkStockApiKey']) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return decrypt(value.trim());
  }

  const fallback = decrypt(shop.apiKey || '');
  if (!fallback) {
    throw new Error('Brak klucza API connectora PrestaShop w konfiguracji sklepu.');
  }
  return fallback;
}

function normalizeConfig(configJson: unknown): Record<string, unknown> {
  return configJson && typeof configJson === 'object' && !Array.isArray(configJson)
    ? configJson as Record<string, unknown>
    : {};
}

function normalizeUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function prestashopShopIdFromConfig(config: Record<string, unknown>): string | number | null {
  if (typeof config.prestashopShopId === 'string' || typeof config.prestashopShopId === 'number') {
    return config.prestashopShopId;
  }
  if (typeof config.idShopDefault === 'string' || typeof config.idShopDefault === 'number') {
    return config.idShopDefault;
  }

  const defaults = config.prestashopProductDefaults;
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const id = (defaults as Record<string, unknown>).idShopDefault;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }

  const productCreate = config.productCreate;
  if (productCreate && typeof productCreate === 'object' && !Array.isArray(productCreate)) {
    const id = (productCreate as Record<string, unknown>).idShopDefault;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }

  return null;
}

async function connectorErrorMessage(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const json = await response.json().catch(() => null) as { errors?: string[]; message?: string } | null;
    return json?.errors?.join(', ') || json?.message || `HTTP ${response.status}`;
  }

  const text = await response.text().catch(() => '');
  return text.slice(0, 300) || `HTTP ${response.status}`;
}

function filenameFromContentDisposition(value: string | null) {
  if (!value) return null;
  const utfMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) return decodeURIComponent(utfMatch[1]);
  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1] ?? null;
}
