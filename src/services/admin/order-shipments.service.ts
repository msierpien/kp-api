/// <reference lib="dom" />
import type { Prisma } from '@prisma/client';
import { decrypt } from '../../lib/encryption';
import prisma from '../../lib/prisma';
import {
  isFinalShipmentStage,
  normalizeShipmentStatus,
  shipmentStageFromStatus,
  type ShipmentStage,
} from '../../lib/inpost-statuses';
import { getTenantId } from '../../lib/tenant-context';
import { buildAdminConnectorControllerUrl } from '../shops/prestashop-stock-client';
import {
  triggerShipmentCreatedAutomations,
  triggerShipmentStatusAutomations,
} from './automation.service';

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

type ShipmentShop = ShipmentOrder['shop'];

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
  return connectorJsonRequest(order.shop, 'inpostshipmentstatus', 'GET', undefined, {
    id_order: order.externalOrderId,
  });
}

export async function createOrderShipment(orderId: string, input: CreateOrderShipmentInput = {}) {
  const order = await loadOrder(orderId);
  const result = await connectorJsonRequest<Record<string, unknown>>(order.shop, 'inpostshipmentcreate', 'POST', {
    idOrder: Number(order.externalOrderId),
    ...input,
  });

  // List przewozowy jest juz nadany w InPost — bledu automatyzacji nie wolno
  // zamienic na blad calej operacji, wiec wynik tylko dokladamy do odpowiedzi.
  const automation = await triggerShipmentCreatedAutomations({
    orderId: order.id,
    shipment: result,
  }).catch(() => null);

  if (!automation) return result;
  return {
    ...(result && typeof result === 'object' && !Array.isArray(result) ? result : { data: result }),
    automation,
  };
}

export async function refreshOrderShipment(orderId: string, input: RefreshOrderShipmentInput = {}) {
  const order = await loadOrder(orderId);
  return connectorJsonRequest(order.shop, 'inpostshipmentrefresh', 'POST', {
    idOrder: Number(order.externalOrderId),
    ...(input.idShipment ? { idShipment: Number(input.idShipment) } : {}),
  });
}

export async function downloadOrderShipmentLabel(
  orderId: string,
  query: OrderShipmentLabelQuery = {},
): Promise<OrderShipmentLabelFile> {
  const order = await loadOrder(orderId);
  const url = connectorUrl(order.shop, 'inpostshipmentlabel', {
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

/** Wiersz przesylki tak, jak zwraca go connector (presentShipmentRow). */
interface ConnectorShipmentRow {
  idShipment?: number;
  idOrder?: number;
  shipxShipmentId?: string;
  trackingNumber?: string;
  service?: string;
  sendingMethod?: string;
  targetPoint?: string;
  status?: string;
  dateUpd?: string | null;
  [key: string]: unknown;
}

interface ConnectorShipmentsBatchResponse {
  idShop?: number;
  configuration?: { ready?: boolean; missing?: string[] };
  refreshedShipmentIds?: number[];
  shipments?: ConnectorShipmentRow[];
}

export interface ShipmentStatusChange {
  orderId: string;
  orderReference: string;
  shipmentId: string;
  trackingNumber: string | null;
  previousStatus: string | null;
  previousStage: ShipmentStage | null;
  status: string;
  stage: ShipmentStage;
}

export interface ShipmentSyncResult {
  shopId: string;
  shopName: string;
  ordersChecked: number;
  shipmentsSeen: number;
  changes: ShipmentStatusChange[];
  errors: string[];
}

/** Tyle zamowien miesci sie w jednym zapytaniu do connectora (limit po stronie modulu). */
const SYNC_ORDER_BATCH_SIZE = 25;
/** Gorny limit na przebieg — przy zaleglosciach nadrobimy je kolejnymi cyklami. */
const SYNC_ORDERS_LIMIT = 500;
const SYNC_LOOKBACK_DAYS = 21;
/** ShipX odpowiada osobno na kazda przesylke, wiec paczka potrzebuje wiecej czasu niz pojedyncze pytanie. */
const SYNC_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Zaciaga statusy przesylek dla sklepu i zapisuje je u nas. Zwraca liste
 * zmian statusu — na niej stoja automatyzacje powiadamiajace klienta.
 */
export async function syncShipmentsForShop(shopId: string): Promise<ShipmentSyncResult> {
  const tenantId = getTenantId();
  const shop = await prisma.shop.findFirst({
    where: { id: shopId, ...(tenantId ? { tenantId } : {}) },
  });

  if (!shop) throw new Error('Sklep nie został znaleziony');
  if (shop.platform !== 'PRESTASHOP') {
    throw new Error('Synchronizacja przesyłek InPost działa tylko dla sklepów PrestaShop');
  }

  const since = new Date(Date.now() - SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  // Pytamy o dwie grupy: przesylki jeszcze w drodze (te maja co zmieniac) oraz
  // swieze zamowienia bez zapisanej przesylki — list przewozowy mogl powstac
  // w sklepie, po naszej stronie jeszcze go nie ma.
  const orders = await prisma.order.findMany({
    where: {
      shopId: shop.id,
      OR: [
        { shipments: { some: { isFinal: false } } },
        {
          shipments: { none: {} },
          createdAtShop: { gte: since },
          operationalStatus: { notIn: ['NEW', 'CANCELLED'] },
        },
      ],
    },
    select: { id: true, externalOrderId: true, orderReference: true },
    orderBy: { createdAtShop: 'desc' },
    take: SYNC_ORDERS_LIMIT,
  });

  const result: ShipmentSyncResult = {
    shopId: shop.id,
    shopName: shop.name,
    ordersChecked: orders.length,
    shipmentsSeen: 0,
    changes: [],
    errors: [],
  };

  if (orders.length === 0) return result;

  const ordersByExternalId = new Map<string, typeof orders[number]>();
  orders.forEach((order) => {
    const externalId = externalOrderIdKey(order.externalOrderId);
    if (externalId) ordersByExternalId.set(externalId, order);
  });

  for (let index = 0; index < orders.length; index += SYNC_ORDER_BATCH_SIZE) {
    const batch = orders.slice(index, index + SYNC_ORDER_BATCH_SIZE);
    const idOrders = batch
      .map((order) => Number(order.externalOrderId))
      .filter((id) => Number.isInteger(id) && id > 0);
    if (idOrders.length === 0) continue;

    try {
      const response = await connectorJsonRequest<ConnectorShipmentsBatchResponse>(
        shop,
        'inpostshipmentsbatch',
        'POST',
        { idOrders, refresh: true },
        {},
        SYNC_REQUEST_TIMEOUT_MS,
      );

      for (const row of response?.shipments ?? []) {
        const order = ordersByExternalId.get(externalOrderIdKey(row.idOrder));
        if (!order || !row.idShipment) continue;

        result.shipmentsSeen += 1;
        const change = await upsertShipmentRow(shop.tenantId, order, row);
        if (!change) continue;

        result.changes.push(change);
        // Powiadomienia dla klienta ida stad. Blad jednej reguly nie moze
        // zatrzymac synchronizacji pozostalych przesylek.
        await triggerShipmentStatusAutomations({
          orderId: change.orderId,
          shipmentId: change.shipmentId,
          shipment: row as Record<string, unknown>,
          previousStatus: change.previousStatus,
        }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(`Automatyzacja ${order.orderReference}: ${message}`);
        });
      }
    } catch (error) {
      // Jedna paczka nie moze zabrac reszty — sklep moze miec chwilowy blad
      // connectora, a pozostale zamowienia i tak trzeba odswiezyc.
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Zamówienia ${idOrders[0]}–${idOrders[idOrders.length - 1]}: ${message}`);
    }
  }

  return result;
}

/** Synchronizacja dla wszystkich aktywnych sklepow PrestaShop — uzywa jej scheduler. */
export async function syncShipmentsForAllShops(): Promise<ShipmentSyncResult[]> {
  const tenantId = getTenantId();
  const shops = await prisma.shop.findMany({
    where: { platform: 'PRESTASHOP', status: 'ACTIVE', ...(tenantId ? { tenantId } : {}) },
    select: { id: true },
  });

  const results: ShipmentSyncResult[] = [];
  for (const shop of shops) {
    try {
      results.push(await syncShipmentsForShop(shop.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Shipments] Synchronizacja sklepu ${shop.id} nie powiodła się:`, message);
    }
  }

  return results;
}

async function upsertShipmentRow(
  tenantId: string,
  order: { id: string; orderReference: string },
  row: ConnectorShipmentRow,
): Promise<ShipmentStatusChange | null> {
  const externalShipmentId = String(row.idShipment);
  const status = normalizeShipmentStatus(row.status);
  const stage = shipmentStageFromStatus(status);
  const trackingNumber = stringOrNull(row.trackingNumber);

  const existing = await prisma.orderShipment.findUnique({
    where: {
      orderId_carrier_externalShipmentId: {
        orderId: order.id,
        carrier: 'INPOST',
        externalShipmentId,
      },
    },
    select: { id: true, status: true, stage: true },
  });

  const previousStatus = existing ? normalizeShipmentStatus(existing.status) : null;
  const statusChanged = previousStatus !== status;
  const now = new Date();

  const data = {
    tenantId,
    orderId: order.id,
    carrier: 'INPOST',
    externalShipmentId,
    shipxShipmentId: stringOrNull(row.shipxShipmentId),
    trackingNumber,
    service: stringOrNull(row.service),
    sendingMethod: stringOrNull(row.sendingMethod),
    targetPoint: stringOrNull(row.targetPoint),
    status: status || null,
    stage,
    isFinal: isFinalShipmentStage(stage),
    payloadJson: row as unknown as Prisma.InputJsonValue,
    syncedAt: now,
    ...(statusChanged ? { statusChangedAt: now } : {}),
  };

  const shipment = await prisma.orderShipment.upsert({
    where: {
      orderId_carrier_externalShipmentId: {
        orderId: order.id,
        carrier: 'INPOST',
        externalShipmentId,
      },
    },
    create: data,
    update: data,
    select: { id: true },
  });

  // Pierwszy odczyt przesylki bez statusu nie jest zmiana, o ktorej warto
  // kogokolwiek powiadamiac — przewoznik jeszcze nic nie powiedzial.
  if (!statusChanged || !status) return null;

  return {
    orderId: order.id,
    orderReference: order.orderReference,
    shipmentId: shipment.id,
    trackingNumber,
    previousStatus,
    previousStage: existing ? (existing.stage as ShipmentStage) : null,
    status,
    stage,
  };
}

function externalOrderIdKey(value: unknown): string {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : '';
}

function stringOrNull(value: unknown): string | null {
  const trimmed = String(value ?? '').trim();
  return trimmed ? trimmed : null;
}

async function connectorJsonRequest<T = unknown>(
  shop: ShipmentShop,
  controller: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  query: Record<string, string | number | null | undefined> = {},
  timeoutMs = 30_000,
): Promise<T> {
  const url = connectorUrl(shop, controller, query);
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Api-Key': connectorApiKey(shop, normalizeConfig(shop.configJson)),
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
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
  shop: ShipmentShop,
  controller: string,
  params: Record<string, string | number | null | undefined>,
) {
  const config = normalizeConfig(shop.configJson);
  const prestashopShopId = prestashopShopIdFromConfig(config);

  const baseUrl = connectorBaseUrl(shop.baseUrl, config);
  const filteredParams: Record<string, string | number> = {};
  if (prestashopShopId !== null) {
    filteredParams.idShop = prestashopShopId;
  }
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
  shop: ShipmentShop,
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
