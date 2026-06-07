import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { getTenantId } from '../../lib/tenant-context';
import { IfirmaClient } from '../ifirma/ifirma-client';
import { buildIfirmaDomesticInvoicePayload } from '../ifirma/ifirma-invoice.mapper';
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
        where: { documentType: 'INVOICE' },
        orderBy: { createdAt: 'desc' },
        take: 1,
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
  return {
    orderId: order.id,
    orderReference: order.orderReference,
    invoice: order.salesDocuments[0] ?? null,
    warehouseDocuments: order.warehouseDocuments,
  };
}

export async function previewOrderInvoice(orderId: string) {
  const order = await ensureInvoiceSnapshot(await loadOrder(orderId));
  const settings = await getDecryptedIfirmaSettings(order.shopId);
  const preview = buildIfirmaDomesticInvoicePayload(order, settings);

  return {
    orderId: order.id,
    orderReference: order.orderReference,
    existingInvoice: order.salesDocuments[0] ?? null,
    ...preview,
  };
}

export async function issueOrderInvoice(orderId: string) {
  const order = await ensureInvoiceSnapshot(await loadOrder(orderId));
  const existing = order.salesDocuments[0];
  if (existing && ['ISSUED', 'SENT'].includes(existing.status)) {
    throw new Error('Faktura dla tego zamówienia została już wystawiona');
  }

  const settings = await getDecryptedIfirmaSettings(order.shopId);
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

function needsPrestaShopInvoiceRefresh(order: InvoiceOrder) {
  const snapshot = order.payloadJson && typeof order.payloadJson === 'object' && !Array.isArray(order.payloadJson)
    ? order.payloadJson as Record<string, unknown>
    : {};
  const snapshotItems = Array.isArray(snapshot.items) ? snapshot.items : [];
  return !order.billingAddressJson || snapshotItems.length === 0 || !order.paymentMethod;
}

async function ensureInvoiceSnapshot(order: InvoiceOrder): Promise<InvoiceOrder> {
  if (order.shop.platform !== 'PRESTASHOP' || !needsPrestaShopInvoiceRefresh(order)) {
    return order;
  }

  const externalOrderId = Number(order.externalOrderId);
  if (!Number.isFinite(externalOrderId) || externalOrderId <= 0) {
    return order;
  }

  const details = await fetchPrestaShopOrderDetailsForInvoice(order.shop, externalOrderId);
  await savePrestaShopInvoiceSnapshot(order.id, details);
  return loadOrder(order.id);
}

async function fetchPrestaShopOrderDetailsForInvoice(shop: InvoiceOrder['shop'], externalOrderId: number) {
  const config = (shop.configJson && typeof shop.configJson === 'object' && !Array.isArray(shop.configJson))
    ? shop.configJson as Record<string, any>
    : {};
  const authType = config.authType === 'ADMIN_API' ? 'ADMIN_API' : 'WEB_SERVICE';
  const bundleConfig = config.advancedBundle ?? config.kpAdvancedBundle ?? {};
  const bundleImportEnabled = Boolean(bundleConfig.enabled ?? bundleConfig.importBundles);
  const bundleApiKey = typeof bundleConfig.apiKey === 'string'
    ? bundleConfig.apiKey
    : typeof bundleConfig.token === 'string'
      ? bundleConfig.token
      : '';

  const client = new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey: decrypt(shop.apiKey),
    authType,
    adminApiConfig: authType === 'ADMIN_API' ? config.adminApi : undefined,
  });

  return client.fetchOrderDetails(
    externalOrderId,
    bundleImportEnabled && bundleApiKey.trim() ? { bundleApiKey } : {},
  );
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
        payloadJson: toJson(details),
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
