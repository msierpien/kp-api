import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { config } from '../../config';
import { decrypt } from '../../lib/encryption';
import { getTenantId } from '../../lib/tenant-context';
import { IfirmaClient } from '../ifirma/ifirma-client';
import { buildIfirmaDomesticInvoicePayload, type IfirmaInvoiceSettingsSnapshot } from '../ifirma/ifirma-invoice.mapper';
import { PrestaShopClient, type PrestaShopOrderDetails } from '../prestashop/prestashop-client';
import { getDecryptedIfirmaSettings } from './ifirma-settings.service';
import { createTenantEmailService } from './email-settings.service';

function orderWhere(orderId: string) {
  const tenantId = getTenantId();
  return {
    id: orderId,
    ...(tenantId ? { shop: { tenantId } } : {}),
  };
}

async function loadOrder(orderId: string) {
  const order = await prisma.order.findFirst({
    where: orderWhere(orderId),
    include: {
      shop: true,
      salesDocuments: {
        orderBy: { createdAt: 'desc' },
        include: { emailLogs: { orderBy: { createdAt: 'desc' }, take: 10 } },
      },
      items: {
        orderBy: { createdAt: 'asc' },
      },
      warehouseDocuments: true,
    },
  });

  if (!order) throw new Error('Zamówienie nie znalezione');
  return order;
}

export async function getOrderInvoice(orderId: string) {
  const order = await loadOrder(orderId);
  const invoice = getPrimaryInvoice(order);
  return {
    orderId: order.id,
    orderReference: order.orderReference,
    invoice,
    documents: order.salesDocuments,
    corrections: order.salesDocuments.filter((document) => document.documentType === 'CORRECTION'),
    warehouseDocuments: order.warehouseDocuments,
  };
}

export async function previewOrderInvoice(orderId: string) {
  const initialOrder = await loadOrder(orderId);
  const settings = await getDecryptedIfirmaSettings(initialOrder.shopId);
  const order = await ensureInvoiceSnapshot(initialOrder, settings);
  const preview = buildIfirmaDomesticInvoicePayload(order, settings);

  return {
    orderId: order.id,
    orderReference: order.orderReference,
    existingInvoice: getPrimaryInvoice(order),
    ...preview,
  };
}

export async function issueOrderInvoice(orderId: string) {
  const initialOrder = await loadOrder(orderId);
  const settings = await getDecryptedIfirmaSettings(initialOrder.shopId);
  const order = await ensureInvoiceSnapshot(initialOrder, settings);
  const existing = getPrimaryInvoice(order);
  if (existing && ['ISSUED', 'SENT'].includes(existing.status)) {
    throw new Error('Faktura dla tego zamówienia została już wystawiona');
  }

  const preview = buildIfirmaDomesticInvoicePayload(order, settings);
  if (preview.errors.length > 0) {
    throw new Error(preview.errors.join('; '));
  }

  const document = existing
    ? await prisma.salesDocument.update({
        where: { id: existing.id },
        data: {
          status: 'PENDING',
          requestPayloadJson: preview.payload as Prisma.InputJsonValue,
          responsePayloadJson: Prisma.JsonNull,
          externalId: null,
          externalNumber: null,
          pdfUrl: null,
          pdfPath: null,
          issuedAt: null,
          sentAt: null,
          failedAt: null,
          errorMessage: null,
        },
      })
    : await prisma.salesDocument.create({
        data: {
          tenantId: order.shop.tenantId,
          shopId: order.shopId,
          orderId: order.id,
          externalOrderId: order.externalOrderId,
          documentType: 'INVOICE',
          documentKey: 'PRIMARY',
          status: 'PENDING',
          requestPayloadJson: preview.payload as Prisma.InputJsonValue,
        },
      });

  const issued = await issuePreparedInvoice(document.id, order.shopId, preview.payload);

  if (settings.sendEmailAfterIssue && issued.status === 'ISSUED') {
    await sendInvoiceEmail(issued.id).catch(() => undefined);
  }

  return issued;
}

export async function retryInvoice(invoiceId: string) {
  const document = await prisma.salesDocument.findFirst({
    where: {
      id: invoiceId,
      ...(getTenantId() ? { tenantId: getTenantId() as string } : {}),
    },
    include: { order: { include: { shop: true } } },
  });

  if (!document) throw new Error('Faktura nie znaleziona');
  if (document.documentType !== 'INVOICE') {
    throw new Error('Korekty należy ponawiać przez operację zwrotu');
  }
  if (['ISSUED', 'SENT'].includes(document.status)) {
    throw new Error('Nie można ponowić faktury, która została już wystawiona');
  }

  const payload = document.requestPayloadJson && typeof document.requestPayloadJson === 'object'
    ? document.requestPayloadJson as Record<string, unknown>
    : (await previewOrderInvoice(document.orderId)).payload;

  await prisma.salesDocument.update({
    where: { id: document.id },
    data: {
      status: 'PENDING',
      requestPayloadJson: payload as Prisma.InputJsonValue,
      failedAt: null,
      errorMessage: null,
    },
  });

  return issuePreparedInvoice(document.id, document.shopId, payload);
}

export async function cancelOrderInvoice(orderId: string) {
  const orderInvoice = await getOrderInvoice(orderId);
  const invoice = orderInvoice.invoice;
  if (!invoice) throw new Error('Brak faktury dla zamówienia');
  return cancelInvoice(invoice.id);
}

export async function cancelInvoice(invoiceId: string) {
  const document = await prisma.salesDocument.findFirst({
    where: {
      id: invoiceId,
      ...(getTenantId() ? { tenantId: getTenantId() as string } : {}),
    },
    include: { emailLogs: { orderBy: { createdAt: 'desc' }, take: 10 } },
  });

  if (!document) throw new Error('Faktura nie znaleziona');
  if (document.status === 'CANCELLED') {
    return document;
  }

  return prisma.salesDocument.update({
    where: { id: document.id },
    data: {
      status: 'CANCELLED',
      errorMessage: 'Anulowano lokalnie w KP Admin. Dokument w iFirma nie został zmieniony.',
      failedAt: null,
      sentAt: null,
    },
    include: { emailLogs: { orderBy: { createdAt: 'desc' }, take: 10 } },
  });
}

export async function getInvoicePdf(invoiceId: string) {
  const document = await prisma.salesDocument.findFirst({
    where: {
      id: invoiceId,
      ...(getTenantId() ? { tenantId: getTenantId() as string } : {}),
    },
    include: { order: true },
  });

  if (!document) throw new Error('Faktura nie znaleziona');

  const pdfPath = await ensureInvoicePdf(document);

  const label = document.externalNumber || document.externalId || document.order.orderReference || document.id;
  const safeLabel = label.replace(/[^\w.-]+/g, '_');
  return {
    path: pdfPath,
    filename: `faktura-${safeLabel}.pdf`,
  };
}

export async function getPublicInvoicePdf(invoiceId: string, token: string) {
  const document = await prisma.salesDocument.findUnique({
    where: { id: invoiceId },
    include: { order: true },
  });

  if (!document) throw new Error('Faktura nie znaleziona');
  if (!verifyPublicInvoiceToken(document, token)) {
    throw new Error('Nieprawidłowy token faktury');
  }

  const pdfPath = await ensureInvoicePdf(document);
  const label = document.externalNumber || document.externalId || document.order.orderReference || document.id;
  const safeLabel = label.replace(/[^\w.-]+/g, '_');
  return {
    path: pdfPath,
    filename: `faktura-${safeLabel}.pdf`,
  };
}

export async function publishInvoiceToPrestaShop(invoiceId: string, options: { force?: boolean } = {}) {
  const document = await prisma.salesDocument.findFirst({
    where: {
      id: invoiceId,
      ...(getTenantId() ? { tenantId: getTenantId() as string } : {}),
    },
    include: { order: { include: { shop: true } } },
  });

  if (!document) throw new Error('Faktura nie znaleziona');
  if (document.documentType !== 'INVOICE') throw new Error('Do PrestaShop można przekazać tylko fakturę pierwotną');
  if (!['ISSUED', 'SENT'].includes(document.status)) {
    throw new Error('Faktura musi być wystawiona przed przekazaniem do PrestaShop');
  }
  if (document.order.shop.platform !== 'PRESTASHOP') {
    throw new Error('Przekazywanie faktury obsługiwane jest tylko dla PrestaShop');
  }

  const existingDelivery = getPrestaShopDeliveryMetadata(document.responsePayloadJson);
  if (!options.force && existingDelivery?.orderMessageId) {
    return {
      invoiceId: document.id,
      status: 'ALREADY_PUBLISHED' as const,
      ...existingDelivery,
    };
  }

  await ensureInvoicePdf(document);
  const publicUrl = buildPublicInvoicePdfUrl(document);
  const externalOrderId = Number(document.externalOrderId);
  if (!Number.isFinite(externalOrderId) || externalOrderId <= 0) {
    throw new Error('Zamówienie nie ma prawidłowego ID PrestaShop');
  }

  const client = createPrestaShopClient(document.order.shop);
  const details = await client.fetchOrderDetails(externalOrderId);
  const customerId = details.order.id_customer ?? details.customer.id;
  const customerHasAccount = Boolean(customerId) && !isBooleanishTrue(details.customer.is_guest);
  const delivery = await client.publishInvoiceLinkToOrder({
    orderId: document.externalOrderId,
    cartId: details.order.id_cart ?? null,
    customerId,
    customerEmail: details.customer.email || document.order.customerEmail,
    customerHasAccount,
    languageId: details.order.id_lang ?? null,
    shopId: details.order.id_shop ?? null,
    message: buildPrestaShopInvoiceMessage({
      invoiceNumber: document.externalNumber || document.externalId || document.id,
      orderReference: document.order.orderReference,
      publicUrl,
    }),
  });

  const deliveryMetadata = {
    publicUrl,
    invoiceNumber: document.externalNumber || document.externalId || null,
    deliveredAt: new Date().toISOString(),
    customerHasAccount,
    ...delivery,
  };

  await prisma.salesDocument.update({
    where: { id: document.id },
    data: {
      pdfUrl: publicUrl,
      responsePayloadJson: mergePrestaShopDeliveryMetadata(document.responsePayloadJson, deliveryMetadata),
    },
  });

  return {
    invoiceId: document.id,
    status: 'PUBLISHED' as const,
    ...deliveryMetadata,
  };
}

export function buildPublicInvoicePdfUrl(document: {
  id: string;
  tenantId: string;
  externalId: string | null;
}) {
  const baseUrl = config.app.url.replace(/\/+$/, '');
  const token = signPublicInvoiceToken(document);
  return `${baseUrl}/public/invoices/${encodeURIComponent(document.id)}/pdf?token=${encodeURIComponent(token)}`;
}

async function ensureInvoicePdf(document: {
  id: string;
  tenantId?: string;
  shopId: string;
  externalId: string | null;
  pdfPath: string | null;
}) {
  const existingPdfPath = await resolveStoredInvoicePdfPath(document.pdfPath);
  if (existingPdfPath) return existingPdfPath;

  if (!document.externalId) {
    throw new Error('PDF faktury nie jest zapisany lokalnie i brakuje identyfikatora iFirma do ponownego pobrania');
  }

  const settings = await getDecryptedIfirmaSettings(document.shopId);
  const client = new IfirmaClient({
    login: settings.login,
    invoiceKey: settings.invoiceKey,
  });

  try {
    const pdfPath = await downloadAndStoreInvoicePdf(client, document.id, document.externalId);
    await prisma.salesDocument.update({
      where: { id: document.id },
      data: { pdfPath },
    });
    return pdfPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nie udało się pobrać PDF z iFirma';
    throw new Error(`PDF faktury nie jest zapisany lokalnie. Ponowne pobranie z iFirma nie powiodło się: ${message}`);
  }
}

async function resolveStoredInvoicePdfPath(pdfPath: string | null) {
  if (!pdfPath) return null;

  const storageRoot = path.resolve(process.cwd(), 'storage', 'invoices');
  const resolvedPdfPath = path.resolve(pdfPath);
  if (!resolvedPdfPath.startsWith(`${storageRoot}${path.sep}`)) {
    throw new Error('Nieprawidłowa ścieżka PDF faktury');
  }

  try {
    await stat(resolvedPdfPath);
    return resolvedPdfPath;
  } catch {
    return null;
  }
}

function createPrestaShopClient(shop: {
  baseUrl: string;
  apiKey: string;
  configJson?: Prisma.JsonValue | null;
}) {
  const shopConfig = (shop.configJson && typeof shop.configJson === 'object' && !Array.isArray(shop.configJson))
    ? shop.configJson as Record<string, any>
    : {};
  const authType = shopConfig.authType === 'ADMIN_API' ? 'ADMIN_API' : 'WEB_SERVICE';
  return new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey: decrypt(shop.apiKey),
    authType,
    adminApiConfig: authType === 'ADMIN_API' ? shopConfig.adminApi : undefined,
  });
}

function signPublicInvoiceToken(document: { id: string; tenantId: string; externalId: string | null }) {
  return createHmac('sha256', config.auth.jwtAccessSecret)
    .update(`${document.tenantId}:${document.id}:${document.externalId ?? ''}`)
    .digest('base64url');
}

function verifyPublicInvoiceToken(
  document: { id: string; tenantId: string; externalId: string | null },
  token: string,
) {
  const expected = signPublicInvoiceToken(document);
  const expectedBuffer = Buffer.from(expected);
  const tokenBuffer = Buffer.from(token);
  return expectedBuffer.length === tokenBuffer.length && timingSafeEqual(expectedBuffer, tokenBuffer);
}

function buildPrestaShopInvoiceMessage(input: {
  invoiceNumber: string;
  orderReference: string;
  publicUrl: string;
}) {
  const invoiceNumber = escapeHtml(input.invoiceNumber);
  const orderReference = escapeHtml(input.orderReference);
  const publicUrl = escapeHtml(input.publicUrl);
  return [
    'Dzień dobry,',
    `faktura ${invoiceNumber} do zamówienia ${orderReference} jest dostępna pod adresem:`,
    `<a href="${publicUrl}" target="_blank" rel="noopener">${publicUrl}</a>`,
    'Pozdrawiamy',
  ].join('<br>');
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isBooleanishTrue(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function getPrestaShopDeliveryMetadata(value: unknown) {
  const payload = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
  const metadata = payload.kp?.prestashopInvoiceDelivery;
  return metadata && typeof metadata === 'object' ? metadata as Record<string, unknown> : null;
}

function mergePrestaShopDeliveryMetadata(value: unknown, deliveryMetadata: Record<string, unknown>) {
  const payload: Record<string, unknown> = value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : value == null
      ? {}
      : { ifirma: value };
  const kp = payload.kp && typeof payload.kp === 'object' && !Array.isArray(payload.kp)
    ? { ...(payload.kp as Record<string, unknown>) }
    : {};

  return toJson({
    ...payload,
    kp: {
      ...kp,
      prestashopInvoiceDelivery: deliveryMetadata,
    },
  });
}

async function issuePreparedInvoice(documentId: string, shopId: string, payload: Record<string, unknown>) {
  const settings = await getDecryptedIfirmaSettings(shopId);
  const client = new IfirmaClient({
    login: settings.login,
    invoiceKey: settings.invoiceKey,
  });

  try {
    const response = await client.issueDomesticInvoice(payload);
    const externalId = response.identifier;
    let pdfPath: string | null = null;
    if (externalId) {
      pdfPath = await downloadAndStoreInvoicePdf(client, documentId, externalId).catch(() => null);
    }

    return prisma.salesDocument.update({
      where: { id: documentId },
      data: {
        status: 'ISSUED',
        externalId,
        externalNumber: response.number,
        responsePayloadJson: response.raw as Prisma.InputJsonValue,
        pdfPath,
        issuedAt: new Date(),
        failedAt: null,
        errorMessage: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nie udało się wystawić faktury w iFirma';
    return prisma.salesDocument.update({
      where: { id: documentId },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorMessage: message,
      },
    });
  }
}

export async function sendOrderInvoiceEmail(orderId: string) {
  const orderInvoice = await getOrderInvoice(orderId);
  const invoice = orderInvoice.invoice;
  if (!invoice) throw new Error('Brak faktury dla zamówienia');
  return sendInvoiceEmail(invoice.id);
}

export async function sendInvoiceEmail(invoiceId: string) {
  const document = await prisma.salesDocument.findFirst({
    where: {
      id: invoiceId,
      ...(getTenantId() ? { tenantId: getTenantId() as string } : {}),
    },
    include: { order: { include: { shop: true } } },
  });

  if (!document) throw new Error('Faktura nie znaleziona');
  if (document.documentType !== 'INVOICE') {
    throw new Error('Wysyłka e-mail obsługuje tylko fakturę pierwotną');
  }
  if (!['ISSUED', 'SENT'].includes(document.status)) {
    throw new Error('Faktura musi być wystawiona przed wysyłką e-mail');
  }

  const subject = `Faktura do zamówienia ${document.order.orderReference}`;
  const log = await prisma.invoiceEmailLog.create({
    data: {
      tenantId: document.tenantId,
      salesDocumentId: document.id,
      toEmail: document.order.customerEmail,
      subject,
      status: 'PENDING',
    },
  });

  try {
    const service = await createTenantEmailService(document.tenantId);
    const result = await service.sendInvoiceEmail({
      to: document.order.customerEmail,
      customerName: document.order.customerName,
      orderReference: document.order.orderReference,
      shopName: document.order.shop.name,
      invoiceNumber: document.externalNumber,
      pdfPath: document.pdfPath,
    });

    if (!result.success) {
      throw new Error('SMTP nie zwrócił potwierdzenia wysyłki');
    }

    const now = new Date();
    await prisma.invoiceEmailLog.update({
      where: { id: log.id },
      data: {
        status: 'SENT',
        providerMessageId: result.messageId ?? null,
        sentAt: now,
      },
    });

    return prisma.salesDocument.update({
      where: { id: document.id },
      data: {
        status: 'SENT',
        sentAt: now,
      },
      include: { emailLogs: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nie udało się wysłać faktury e-mailem';
    await prisma.invoiceEmailLog.update({
      where: { id: log.id },
      data: {
        status: 'FAILED',
        errorMessage: message,
        failedAt: new Date(),
      },
    });
    throw new Error(message);
  }
}

async function downloadAndStoreInvoicePdf(client: IfirmaClient, documentId: string, externalId: string) {
  const pdf = await client.downloadDomesticInvoicePdf(externalId);
  const dir = path.join(process.cwd(), 'storage', 'invoices');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${documentId}.pdf`);
  await writeFile(filePath, pdf);
  return filePath;
}

type InvoiceOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

function getPrimaryInvoice(order: Pick<InvoiceOrder, 'salesDocuments'>) {
  return order.salesDocuments
    .filter((document) => document.documentType === 'INVOICE')
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0] ?? null;
}

function needsPrestaShopInvoiceRefresh(order: InvoiceOrder, settings?: IfirmaInvoiceSettingsSnapshot) {
  const snapshot = order.payloadJson && typeof order.payloadJson === 'object' && !Array.isArray(order.payloadJson)
    ? order.payloadJson as Record<string, unknown>
    : {};
  const snapshotItems = Array.isArray(snapshot.items) ? snapshot.items : [];
  const snapshotBundleSelections = Array.isArray(snapshot.bundleSelections) ? snapshot.bundleSelections : [];
  const bundleSelectionsFetched = snapshot.bundleSelectionsFetched === true;
  return !order.billingAddressJson ||
    snapshotItems.length === 0 ||
    !order.paymentMethod ||
    Boolean(settings?.splitBundleItems && !bundleSelectionsFetched && snapshotBundleSelections.length === 0 && getAdvancedBundleApiKey(order.shop));
}

async function ensureInvoiceSnapshot(
  order: InvoiceOrder,
  settings?: IfirmaInvoiceSettingsSnapshot,
): Promise<InvoiceOrder> {
  if (order.shop.platform !== 'PRESTASHOP' || !needsPrestaShopInvoiceRefresh(order, settings)) {
    return order;
  }

  const externalOrderId = Number(order.externalOrderId);
  if (!Number.isFinite(externalOrderId) || externalOrderId <= 0) {
    return order;
  }

  const details = await fetchPrestaShopOrderDetailsForInvoice(order.shop, externalOrderId, {
    fetchBundleSelections: Boolean(settings?.splitBundleItems),
  });
  await savePrestaShopInvoiceSnapshot(order.id, details);
  return loadOrder(order.id);
}

async function fetchPrestaShopOrderDetailsForInvoice(
  shop: InvoiceOrder['shop'],
  externalOrderId: number,
  options: { fetchBundleSelections?: boolean } = {},
) {
  const config = (shop.configJson && typeof shop.configJson === 'object' && !Array.isArray(shop.configJson))
    ? shop.configJson as Record<string, any>
    : {};
  const authType = config.authType === 'ADMIN_API' ? 'ADMIN_API' : 'WEB_SERVICE';
  const bundleApiKey = getAdvancedBundleApiKey(shop);
  const bundleConfig = config.advancedBundle ?? config.kpAdvancedBundle ?? {};
  const shouldFetchBundleSelections = options.fetchBundleSelections || Boolean(bundleConfig.enabled ?? bundleConfig.importBundles);

  const client = new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey: decrypt(shop.apiKey),
    authType,
    adminApiConfig: authType === 'ADMIN_API' ? config.adminApi : undefined,
  });

  return client.fetchOrderDetails(
    externalOrderId,
    shouldFetchBundleSelections && bundleApiKey.trim() ? { bundleApiKey } : {},
  );
}

function getAdvancedBundleApiKey(shop: InvoiceOrder['shop']) {
  const config = (shop.configJson && typeof shop.configJson === 'object' && !Array.isArray(shop.configJson))
    ? shop.configJson as Record<string, any>
    : {};
  const bundleConfig = config.advancedBundle ?? config.kpAdvancedBundle ?? {};
  return typeof bundleConfig.apiKey === 'string'
    ? bundleConfig.apiKey
    : typeof bundleConfig.token === 'string'
      ? bundleConfig.token
      : '';
}

async function savePrestaShopInvoiceSnapshot(orderId: string, details: PrestaShopOrderDetails) {
  const billingAddressJson = details.invoiceAddress ? toJson({
    ...details.invoiceAddress,
    country: details.invoiceCountry,
  }) : Prisma.JsonNull;
  const deliveryAddressJson = details.deliveryAddress ? toJson({
    ...details.deliveryAddress,
    country: details.deliveryCountry,
    carrier: details.carrier,
  }) : Prisma.JsonNull;

  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        currency: String((details.order as any).currency || 'PLN'),
        totalPaid: details.order.total_paid,
        totalShippingTaxIncl: decimalOrNull(details.order.total_shipping_tax_incl),
        totalShippingTaxExcl: decimalOrNull(details.order.total_shipping_tax_excl),
        totalDiscountsTaxIncl: decimalOrNull(details.order.total_discounts_tax_incl),
        totalDiscountsTaxExcl: decimalOrNull(details.order.total_discounts_tax_excl),
        paymentMethod: details.order.payment || details.order.module || null,
        externalStatusId: details.order.current_state == null ? null : String(details.order.current_state),
        externalStatusName: details.orderStatus?.name ?? null,
        billingAddressJson,
        deliveryAddressJson,
        payloadJson: toJson({ ...details, bundleSelectionsFetched: true }),
        syncedAt: new Date(),
      },
    });

    for (const item of details.items) {
      await tx.orderItem.updateMany({
        where: {
          orderId,
          externalItemId: String(item.id),
        },
        data: {
          unitPriceTaxIncl: decimalOrNull(item.unit_price_tax_incl),
          unitPriceTaxExcl: decimalOrNull(item.unit_price_tax_excl ?? item.product_price),
          totalPriceTaxIncl: decimalOrNull(item.total_price_tax_incl),
          totalPriceTaxExcl: decimalOrNull(item.total_price_tax_excl),
          taxRate: decimalOrNull(item.tax_rate),
          taxName: item.tax_name ?? null,
          payloadJson: item.payload ? toJson(item.payload) : Prisma.JsonNull,
        },
      });
    }
  });
}

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function decimalOrNull(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? value as any : null;
}
