/// <reference lib="dom" />
import type { CustomerReturnRequestStatus, Prisma } from '@prisma/client';
import { decrypt } from '../../lib/encryption';
import { createLogger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';

export interface CustomerReturnRequestsQuery {
  page?: number;
  limit?: number;
  status?: CustomerReturnRequestStatus | 'ALL' | '';
  shopId?: string;
  q?: string;
}

const logger = createLogger('customer-return-requests-service');

function tenantWhere() {
  const tenantId = getTenantId();
  return tenantId ? { tenantId } : {};
}

function listWhere(query: CustomerReturnRequestsQuery): Prisma.CustomerReturnRequestWhereInput {
  const where: Prisma.CustomerReturnRequestWhereInput = {
    ...tenantWhere(),
  };

  if (query.status && query.status !== 'ALL') {
    where.status = query.status;
  }
  if (query.shopId) {
    where.shopId = query.shopId;
  }
  if (query.q?.trim()) {
    const q = query.q.trim();
    where.OR = [
      { orderReference: { contains: q, mode: 'insensitive' } },
      { customerEmail: { contains: q, mode: 'insensitive' } },
      { customerName: { contains: q, mode: 'insensitive' } },
      { externalOrderId: { contains: q, mode: 'insensitive' } },
    ];
  }

  return where;
}

const include = {
  shop: { select: { id: true, name: true, platform: true } },
  order: { select: { id: true, orderReference: true, externalOrderId: true } },
  payments: { orderBy: { createdAt: 'desc' as const } },
};

export async function listCustomerReturnRequests(query: CustomerReturnRequestsQuery = {}) {
  const page = Math.max(1, Number(query.page ?? 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 50)));
  const where = listWhere(query);
  const [total, data] = await Promise.all([
    prisma.customerReturnRequest.count({ where }),
    prisma.customerReturnRequest.findMany({
      where,
      include,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

// Szczegoly celowo ciagna caly kontekst zamowienia: zgloszenie samo w sobie nie
// mowi, czy zwrot da sie w ogole obsluzyc z panelu - o tym decyduja WZ, faktura
// i wczesniejsze operacje zwrotu.
const detailInclude = {
  shop: { select: { id: true, name: true, platform: true, baseUrl: true } },
  payments: { orderBy: { createdAt: 'desc' as const } },
  order: {
    include: {
      items: { orderBy: { createdAt: 'asc' as const } },
      returns: {
        include: {
          items: true,
          warehouseDocument: { select: { id: true, number: true, type: true, status: true, date: true } },
          salesDocument: {
            select: {
              id: true, documentType: true, status: true, externalId: true,
              externalNumber: true, issuedAt: true, pdfPath: true, errorMessage: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' as const },
      },
      warehouseDocuments: {
        select: { id: true, number: true, type: true, status: true, date: true, description: true },
        orderBy: { date: 'asc' as const },
      },
      salesDocuments: {
        select: {
          id: true, documentType: true, status: true, externalId: true,
          externalNumber: true, issuedAt: true, pdfPath: true, errorMessage: true, parentDocumentId: true,
        },
        orderBy: { createdAt: 'asc' as const },
      },
    },
  },
};

export async function getCustomerReturnRequest(id: string) {
  const request = await prisma.customerReturnRequest.findFirst({
    where: {
      id,
      ...tenantWhere(),
    },
    include: detailInclude,
  });

  if (!request) throw new Error('Zgłoszenie zwrotu nie znalezione');

  return {
    ...request,
    matchedItems: matchRequestItemsToOrder(request),
    diagnostics: buildDiagnostics(request),
  };
}

type RequestDetail = Prisma.CustomerReturnRequestGetPayload<{ include: typeof detailInclude }>;

interface RequestedItem {
  sku?: string;
  productName?: string;
  quantity?: number;
  orderDetailId?: string;
}

function requestedItems(itemsJson: unknown): RequestedItem[] {
  return Array.isArray(itemsJson) ? itemsJson as RequestedItem[] : [];
}

/** Ile sztuk kazdej pozycji zamowienia zeszlo juz zwrotami (anulowane pomijamy). */
function returnedQuantities(request: RequestDetail) {
  const result = new Map<string, number>();
  for (const orderReturn of request.order?.returns ?? []) {
    if (orderReturn.status === 'CANCELLED') continue;
    for (const item of orderReturn.items) {
      result.set(item.orderItemId, (result.get(item.orderItemId) ?? 0) + Number(item.quantity));
    }
  }
  return result;
}

// Zgloszenie z formularza niesie tylko SKU i orderDetailId ze sklepu. Dopasowanie
// do pozycji zamowienia to jedyny sposob, zeby pokazac, ile faktycznie zostalo
// do zwrotu - i wychwycic zgloszenie wystawione na niewlasciwe zamowienie.
function matchRequestItemsToOrder(request: RequestDetail) {
  const orderItems = request.order?.items ?? [];
  const returned = returnedQuantities(request);

  return requestedItems(request.itemsJson).map((item) => {
    const orderItem = orderItems.find((candidate) => {
      if (item.orderDetailId && String(candidate.externalItemId).split(':')[0] === String(item.orderDetailId)) return true;
      return Boolean(item.sku) && candidate.sku === item.sku;
    }) ?? null;

    const orderedQuantity = orderItem ? Number(orderItem.quantity) : null;
    const returnedQuantity = orderItem ? returned.get(orderItem.id) ?? 0 : 0;

    return {
      sku: item.sku ?? orderItem?.sku ?? null,
      productName: item.productName ?? orderItem?.productNameSnapshot ?? null,
      requestedQuantity: Number(item.quantity ?? 0),
      orderDetailId: item.orderDetailId ?? null,
      orderItemId: orderItem?.id ?? null,
      orderedQuantity,
      returnedQuantity,
      availableQuantity: orderedQuantity === null ? null : Math.max(0, orderedQuantity - returnedQuantity),
      unitPriceTaxIncl: orderItem?.unitPriceTaxIncl ?? null,
      warehouseProductId: orderItem?.warehouseProductId ?? null,
      matched: Boolean(orderItem),
    };
  });
}

// Te same warunki, o ktore wyklada sie operacja zwrotu w order-returns.service.
// Lepiej pokazac je na zgloszeniu, niz pozwolic uzytkownikowi trafic na blad
// dopiero po kliknieciu "Zapisz zwrot".
function buildDiagnostics(request: RequestDetail) {
  const order = request.order;
  const warnings: string[] = [];

  if (!order) {
    return {
      hasOrder: false,
      orderCancelled: false,
      hasConfirmedWz: false,
      hasInvoiceInPanel: false,
      canRestock: false,
      completedReturnsCount: 0,
      warnings: ['Zgłoszenie nie jest powiązane z zamówieniem w panelu — zwrotu nie da się wykonać z poziomu zamówienia.'],
    };
  }

  const hasConfirmedWz = order.warehouseDocuments.some((document) => document.type === 'WZ' && document.status === 'CONFIRMED');
  const hasInvoiceInPanel = order.salesDocuments.some((document) => document.documentType === 'INVOICE');
  const orderCancelled = order.operationalStatus === 'CANCELLED';
  const activeReturns = order.returns.filter((item) => item.status !== 'CANCELLED');
  const unmatched = matchRequestItemsToOrder(request).filter((item) => !item.matched);

  if (orderCancelled) {
    warnings.push('Zamówienie jest anulowane — sprawdź, czy zgłoszenie nie trafiło na niewłaściwe zamówienie klienta.');
  }
  if (!hasConfirmedWz) {
    warnings.push('Brak zatwierdzonego WZ — towar nigdy nie zszedł ze stanu, więc przyjęcie na magazyn odrzuci operację.');
  }
  if (!hasInvoiceInPanel) {
    warnings.push('Brak faktury w panelu — korekta iFirma zostanie pominięta. Jeśli faktura istnieje tylko w iFirma, wystaw korektę ręcznie.');
  }
  if (unmatched.length > 0) {
    warnings.push(`Nie dopasowano do pozycji zamówienia: ${unmatched.map((item) => item.sku || item.productName || '?').join(', ')}.`);
  }
  if (activeReturns.some((item) => item.type === 'CANCELLATION')) {
    warnings.push('Zamówienie ma operację anulowania — pieniądze mogły już zostać zwrócone tą drogą.');
  }

  return {
    hasOrder: true,
    orderCancelled,
    hasConfirmedWz,
    hasInvoiceInPanel,
    canRestock: hasConfirmedWz && !orderCancelled,
    completedReturnsCount: activeReturns.length,
    warnings,
  };
}

export async function updateCustomerReturnRequestStatus(id: string, status: CustomerReturnRequestStatus) {
  const current = await prisma.customerReturnRequest.findFirst({
    where: {
      id,
      ...tenantWhere(),
    },
    include: { shop: true },
  });

  if (!current) throw new Error('Zgłoszenie zwrotu nie znalezione');

  const updated = await prisma.customerReturnRequest.update({
    where: { id },
    data: { status },
    include,
  });

  await syncReturnStatusToPrestaShop(current, status);

  return updated;
}

type ReturnRequestForSync = Prisma.CustomerReturnRequestGetPayload<{
  include: { shop: true };
}>;

async function syncReturnStatusToPrestaShop(
  request: ReturnRequestForSync,
  status: CustomerReturnRequestStatus,
) {
  if (request.shop.platform !== 'PRESTASHOP') return;
  if (!request.prestashopRequestId) return;

  const config = normalizeConfig(request.shop.configJson);
  const apiKey = connectorApiKey(request.shop, config);
  if (!apiKey) {
    logger.warn(
      { requestId: request.id, shopId: request.shopId },
      'Skipping PrestaShop return status sync because admin connector API key is missing',
    );
    return;
  }

  const prestashopShopId = prestashopShopIdFromConfig(config);
  const url = returnStatusEndpoint(request.shop.baseUrl, config, prestashopShopId);
  const payload = {
    prestashopRequestId: request.prestashopRequestId,
    status,
    ...(prestashopShopId ? { idShop: prestashopShopId } : {}),
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000),
    });
    const text = await response.text();
    let json: { success?: boolean; errors?: string[] } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok || json?.success === false) {
      const message = json?.errors?.join(', ') || text.slice(0, 200) || `HTTP ${response.status}`;
      throw new Error(message);
    }

    logger.info(
      { requestId: request.id, prestashopRequestId: request.prestashopRequestId, shopId: request.shopId, status },
      'PrestaShop return status synchronized',
    );
  } catch (error) {
    logger.warn(
      { err: error, requestId: request.id, prestashopRequestId: request.prestashopRequestId, shopId: request.shopId, status },
      'Could not synchronize PrestaShop return status',
    );
  }
}

function normalizeConfig(configJson: unknown): Record<string, unknown> {
  return configJson && typeof configJson === 'object' && !Array.isArray(configJson)
    ? configJson as Record<string, unknown>
    : {};
}

function connectorApiKey(
  shop: ReturnRequestForSync['shop'],
  config: Record<string, unknown>,
) {
  for (const key of ['adminConnectorApiKey', 'productContentApiKey', 'contentModuleApiKey', 'bulkStockApiKey']) {
    const value = config[key];
    if (typeof value === 'string' && value.trim()) return decrypt(value.trim());
  }

  return decrypt(shop.apiKey || '');
}

function returnStatusEndpoint(
  baseUrl: string,
  config: Record<string, unknown>,
  prestashopShopId: string | number | null,
) {
  const configuredUrl = normalizeUrl(config.adminConnectorUrl);
  const moduleUrl = configuredUrl
    ?? `${baseUrl.replace(/\/+$/, '').replace(/\/api$/, '')}/index.php?fc=module&module=kp_adminconnector&controller=capabilities`;

  return buildAdminConnectorControllerUrl(moduleUrl, 'returnstatus', {
    idShop: prestashopShopId,
  });
}

function buildAdminConnectorControllerUrl(
  moduleUrl: string,
  controller: string,
  params: Record<string, string | number | null | undefined> = {},
) {
  const trimmed = moduleUrl.replace(/\/+$/, '');
  let url: string;
  if (trimmed.includes('?')) {
    url = trimmed.includes('controller=')
      ? trimmed.replace(/([?&]controller=)[^&]*/, `$1${encodeURIComponent(controller)}`)
      : `${trimmed}&controller=${encodeURIComponent(controller)}`;
  } else {
    url = `${stripKnownModuleController(trimmed)}/${encodeURIComponent(controller)}`;
  }

  return withQueryParams(url, params);
}

function stripKnownModuleController(url: string) {
  return url.replace(/\/(?:bulkupdate|snapshot|stocksnapshot|capabilities|patch|mediaimport|mediaorder|mediaupdate|mediadelete|returnstatus)$/i, '');
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

function normalizeUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function prestashopShopIdFromConfig(config: Record<string, unknown>) {
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
