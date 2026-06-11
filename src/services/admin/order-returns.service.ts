import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { getTenantId } from '../../lib/tenant-context';
import { IfirmaClient } from '../ifirma/ifirma-client';
import { buildIfirmaDomesticInvoiceCorrectionPayload } from '../ifirma/ifirma-correction.mapper';
import { PrestaShopClient, type CreatePrestaShopOrderSlipInput } from '../prestashop/prestashop-client';
import { getDecryptedIfirmaSettings } from './ifirma-settings.service';
import { cancelDocument, confirmDocument, createDocument, deleteDocument } from './warehouse-documents.service';
import { releaseOrderReservations } from './warehouse-reservations.service';
import type { OrderCancellationActionInput, OrderReturnActionInput } from '../../schemas/admin.schema';

type OperationType = 'CANCELLATION' | 'RETURN';

interface PreparedReturnItem {
  orderItemId: string;
  externalItemId: string;
  orderDetailId: string;
  sku: string;
  productNameSnapshot: string;
  quantity: number;
  alreadyReturnedQuantity: number;
  availableQuantity: number;
  unitPriceTaxIncl: number | null;
  unitPriceTaxExcl: number | null;
  totalRefundTaxIncl: number;
  totalRefundTaxExcl: number;
  taxRate: number | null;
  warehouseProductId: string | null;
}

interface PreparedOperation {
  type: OperationType;
  reason?: string | null;
  refundShipping: boolean;
  restockItems: boolean;
  autoConfirmWarehouseDocument: boolean;
  externalStatusId: string | null;
  externalStatusName: string | null;
  items: PreparedReturnItem[];
  totalRefundTaxIncl: number;
  totalRefundTaxExcl: number;
  shippingRefundTaxIncl: number;
  shippingRefundTaxExcl: number;
}

type LoadedOrder = Awaited<ReturnType<typeof loadOrder>>;
type LoadedOrderReturn = Awaited<ReturnType<typeof loadOrderReturn>>;

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
      items: { orderBy: { createdAt: 'asc' } },
      returns: {
        where: { status: { not: 'CANCELLED' } },
        include: {
          items: true,
          salesDocument: true,
          warehouseDocument: true,
        },
        orderBy: { createdAt: 'asc' },
      },
      salesDocuments: {
        orderBy: { createdAt: 'asc' },
        include: { emailLogs: { orderBy: { createdAt: 'desc' }, take: 10 } },
      },
      warehouseDocuments: {
        include: { items: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!order) throw new Error('Zamówienie nie znalezione');
  return order;
}

async function loadOrderReturn(id: string) {
  const tenantId = getTenantId();
  const orderReturn = await prisma.orderReturn.findFirst({
    where: {
      id,
      ...(tenantId ? { tenantId } : {}),
    },
    include: {
      items: true,
      warehouseDocument: true,
      salesDocument: true,
      order: {
        include: {
          shop: true,
          items: { orderBy: { createdAt: 'asc' } },
          returns: {
            where: { status: { not: 'CANCELLED' } },
            include: { items: true, salesDocument: true, warehouseDocument: true },
            orderBy: { createdAt: 'asc' },
          },
          salesDocuments: { orderBy: { createdAt: 'asc' } },
          warehouseDocuments: { include: { items: true }, orderBy: { createdAt: 'asc' } },
        },
      },
    },
  });

  if (!orderReturn) throw new Error('Operacja zwrotu nie znaleziona');
  return orderReturn;
}

export async function listOrderReturns(orderId: string) {
  const order = await loadOrder(orderId);
  return prisma.orderReturn.findMany({
    where: { orderId: order.id },
    include: {
      items: true,
      warehouseDocument: true,
      salesDocument: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function previewOrderCancellation(orderId: string, input: OrderCancellationActionInput) {
  const order = await loadOrder(orderId);
  const prepared = await prepareOperation(order, 'CANCELLATION', {
    ...input,
    items: buildFullCancellationItems(order),
    refundShipping: input.refundShipping ?? true,
  });
  return buildPreview(order, prepared);
}

export async function previewOrderReturn(orderId: string, input: OrderReturnActionInput) {
  const order = await loadOrder(orderId);
  const prepared = await prepareOperation(order, 'RETURN', input);
  return buildPreview(order, prepared);
}

export async function cancelOrder(orderId: string, input: OrderCancellationActionInput) {
  const order = await loadOrder(orderId);
  const existing = order.returns.find((item) => item.type === 'CANCELLATION' && item.status !== 'CANCELLED');
  if (existing) return retryOrderReturn(existing.id);

  const prepared = await prepareOperation(order, 'CANCELLATION', {
    ...input,
    items: buildFullCancellationItems(order),
    refundShipping: input.refundShipping ?? true,
  });
  const created = await createOrderReturnRecord(order, prepared);
  return executeOrderReturn(created.id);
}

export async function createOrderReturn(orderId: string, input: OrderReturnActionInput) {
  const order = await loadOrder(orderId);
  const prepared = await prepareOperation(order, 'RETURN', input);
  const created = await createOrderReturnRecord(order, prepared);
  return executeOrderReturn(created.id);
}

export async function retryOrderReturn(id: string) {
  const orderReturn = await loadOrderReturn(id);
  if (orderReturn.status === 'CANCELLED') throw new Error('Nie można ponowić anulowanej operacji zwrotu');
  if (orderReturn.status === 'COMPLETED') return orderReturn;
  return executeOrderReturn(orderReturn.id);
}

export async function deleteOrderReturn(id: string) {
  const orderReturn = await loadOrderReturn(id);
  if (orderReturn.status === 'CANCELLED') return orderReturn;
  if (orderReturn.type !== 'RETURN') {
    throw new Error('Pełnego anulowania zamówienia nie można usunąć tą operacją. Obsługiwane jest tylko usunięcie zwrotu.');
  }

  assertReturnHasNoExternalEffects(orderReturn);
  const keepWarehouseDocumentLink = Boolean(orderReturn.warehouseDocument && orderReturn.warehouseDocument.status !== 'DRAFT');
  await undoReturnWarehouseEffects(orderReturn);

  if (orderReturn.salesDocument && !hasIssuedSalesDocument(orderReturn.salesDocument)) {
    await prisma.salesDocument.update({
      where: { id: orderReturn.salesDocument.id },
      data: {
        status: 'CANCELLED',
        failedAt: null,
        errorMessage: 'Anulowano razem ze zwrotem przed wysłaniem korekty do iFirma.',
      },
    });
  }

  const cancelled = await prisma.orderReturn.update({
    where: { id: orderReturn.id },
    data: {
      status: 'CANCELLED',
      warehouseDocumentId: keepWarehouseDocumentLink ? orderReturn.warehouseDocumentId : null,
      ifirmaStatus: orderReturn.ifirmaStatus && orderReturn.ifirmaStatus !== 'SKIPPED' ? 'CANCELLED' : orderReturn.ifirmaStatus,
      prestashopStatus: orderReturn.prestashopStatus && orderReturn.prestashopStatus !== 'SKIPPED' ? 'CANCELLED' : orderReturn.prestashopStatus,
      completedAt: null,
      failedAt: null,
      errorMessage: null,
      ifirmaErrorMessage: null,
      prestashopErrorMessage: null,
    },
    include: { items: true, warehouseDocument: true, salesDocument: true },
  });

  await refreshOrderStatusAfterReturnDeletion(orderReturn.orderId);
  return cancelled;
}

async function createOrderReturnRecord(order: LoadedOrder, prepared: PreparedOperation) {
  return prisma.$transaction(async (tx) => {
    return tx.orderReturn.create({
      data: {
        tenantId: order.shop.tenantId,
        shopId: order.shopId,
        orderId: order.id,
        externalOrderId: order.externalOrderId,
        type: prepared.type,
        status: 'PENDING',
        reason: prepared.reason?.trim() || null,
        refundShipping: prepared.refundShipping,
        restockItems: prepared.restockItems,
        autoConfirmWarehouseDocument: prepared.autoConfirmWarehouseDocument,
        totalRefundTaxIncl: prepared.totalRefundTaxIncl,
        totalRefundTaxExcl: prepared.totalRefundTaxExcl,
        shippingRefundTaxIncl: prepared.shippingRefundTaxIncl,
        shippingRefundTaxExcl: prepared.shippingRefundTaxExcl,
        externalStatusId: prepared.externalStatusId,
        externalStatusName: prepared.externalStatusName,
        items: {
          create: prepared.items.map((item) => ({
            tenantId: order.shop.tenantId,
            orderItemId: item.orderItemId,
            externalItemId: item.externalItemId,
            sku: item.sku,
            productNameSnapshot: item.productNameSnapshot,
            quantity: item.quantity,
            unitPriceTaxIncl: item.unitPriceTaxIncl,
            unitPriceTaxExcl: item.unitPriceTaxExcl,
            totalRefundTaxIncl: item.totalRefundTaxIncl,
            totalRefundTaxExcl: item.totalRefundTaxExcl,
            taxRate: item.taxRate,
            warehouseProductId: item.warehouseProductId,
          })),
        },
      },
      include: {
        items: true,
        warehouseDocument: true,
        salesDocument: true,
      },
    });
  });
}

function assertReturnHasNoExternalEffects(orderReturn: LoadedOrderReturn) {
  const externalIssues: string[] = [];

  if (orderReturn.salesDocument && hasIssuedSalesDocument(orderReturn.salesDocument)) {
    externalIssues.push('korekta iFirma została już wystawiona');
  }
  if (orderReturn.ifirmaStatus === 'ISSUED') {
    externalIssues.push('status iFirma jest ISSUED');
  }
  if (orderReturn.prestashopOrderSlipId || orderReturn.prestashopStatus === 'COMPLETED') {
    externalIssues.push('refund/order slip PrestaShop został już utworzony');
  }

  if (externalIssues.length > 0) {
    throw new Error(
      `Nie można usunąć zwrotu, bo ma skutki zewnętrzne: ${externalIssues.join(', ')}. ` +
      'Najpierw obsłuż korektę/refund w systemach zewnętrznych, a lokalnie pozostaw ślad dokumentowy.',
    );
  }
}

function hasIssuedSalesDocument(document: { status: string; externalId?: string | null; externalNumber?: string | null }) {
  return ['ISSUED', 'SENT'].includes(document.status) || Boolean(document.externalId || document.externalNumber);
}

async function undoReturnWarehouseEffects(orderReturn: LoadedOrderReturn) {
  if (!orderReturn.warehouseDocumentId || !orderReturn.warehouseDocument) return;

  const reason = `Usunięcie zwrotu ${orderReturn.order.orderReference}`;
  if (orderReturn.warehouseDocument.status === 'DRAFT') {
    await deleteDocument(orderReturn.warehouseDocumentId);
    return;
  }

  if (orderReturn.warehouseDocument.status === 'CONFIRMED') {
    await cancelDocument(orderReturn.warehouseDocumentId, { reason });
  }
}

async function refreshOrderStatusAfterReturnDeletion(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      returns: {
        where: { status: { not: 'CANCELLED' } },
        include: { items: true },
      },
    },
  });
  if (!order) return;

  if (order.returns.some((item) => item.type === 'CANCELLATION')) {
    await prisma.order.update({ where: { id: orderId }, data: { operationalStatus: 'CANCELLED' } });
    return;
  }

  const activeReturns = order.returns.filter((item) => item.type === 'RETURN');
  if (activeReturns.length > 0) {
    const returned = returnedQuantitiesByOrderItemId(activeReturns);
    const fullyReturned = order.items.every((item) => {
      const returnedQuantity = returned.get(item.id) ?? 0;
      return returnedQuantity + 0.0001 >= Number(item.quantity);
    });
    await prisma.order.update({
      where: { id: orderId },
      data: { operationalStatus: fullyReturned ? 'RETURNED' : 'PARTIALLY_RETURNED' },
    });
    return;
  }

  if (['RETURNED', 'PARTIALLY_RETURNED'].includes(order.operationalStatus)) {
    await prisma.order.update({ where: { id: orderId }, data: { operationalStatus: 'PROCESSING' } });
  }
}

async function executeOrderReturn(id: string) {
  await prisma.orderReturn.update({
    where: { id },
    data: {
      status: 'PENDING',
      errorMessage: null,
      failedAt: null,
    },
  });

  try {
    let current = await loadOrderReturn(id);
    await performWarehouseStep(current);

    current = await loadOrderReturn(id);
    await performIfirmaStep(current);

    current = await loadOrderReturn(id);
    await performPrestaShopStep(current);

    current = await loadOrderReturn(id);
    await updateFinalOrderStatus(current);

    return prisma.orderReturn.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        failedAt: null,
        errorMessage: null,
      },
      include: { items: true, warehouseDocument: true, salesDocument: true },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nie udało się wykonać operacji zwrotu';
    return prisma.orderReturn.update({
      where: { id },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorMessage: message,
      },
      include: { items: true, warehouseDocument: true, salesDocument: true },
    });
  }
}

async function performWarehouseStep(orderReturn: LoadedOrderReturn) {
  if (orderReturn.type === 'CANCELLATION') {
    await releaseOrderReservations(orderReturn.orderId);
    const activeWz = orderReturn.order.warehouseDocuments.filter((document) => document.type === 'WZ' && document.status !== 'CANCELLED');
    for (const document of activeWz) {
      await cancelDocument(document.id, {
        reason: orderReturn.reason || `Anulowanie zamowienia ${orderReturn.order.orderReference}`,
      });
    }
    return;
  }

  if (!orderReturn.restockItems) return;

  const existingDocument = orderReturn.warehouseDocumentId
    ? await prisma.warehouseDocument.findUnique({ where: { id: orderReturn.warehouseDocumentId } })
    : null;

  if (existingDocument) {
    if (orderReturn.autoConfirmWarehouseDocument && existingDocument.status === 'DRAFT') {
      await confirmDocument(existingDocument.id);
    }
    return;
  }

  const items = orderReturn.items
    .filter((item) => item.warehouseProductId && Number(item.quantity) > 0)
    .map((item) => ({
      productId: item.warehouseProductId as string,
      quantity: Number(item.quantity),
      notes: `Zwrot ${orderReturn.order.orderReference}`,
    }));

  if (items.length === 0) return;

  const document = await createDocument({
    type: 'ZW',
    orderId: orderReturn.orderId,
    isAutoGenerated: true,
    description: `Zwrot od klienta do zamowienia ${orderReturn.order.orderReference}`,
    metadataJson: { orderReturnId: orderReturn.id },
    items,
  });

  await prisma.orderReturn.update({
    where: { id: orderReturn.id },
    data: { warehouseDocumentId: document.id },
  });

  if (orderReturn.autoConfirmWarehouseDocument) {
    await confirmDocument(document.id);
  }
}

async function performIfirmaStep(orderReturn: LoadedOrderReturn) {
  const sourceInvoice = getPrimaryInvoice(orderReturn.order);
  if (!sourceInvoice) {
    await prisma.orderReturn.update({
      where: { id: orderReturn.id },
      data: { ifirmaStatus: 'SKIPPED', ifirmaErrorMessage: null },
    });
    return;
  }

  if (!sourceInvoice.externalId) {
    if (['ISSUED', 'SENT', 'CANCELLED'].includes(sourceInvoice.status)) {
      throw new Error('Faktura pierwotna nie ma identyfikatora iFirma, więc nie można wystawić korekty.');
    }
    await prisma.orderReturn.update({
      where: { id: orderReturn.id },
      data: { ifirmaStatus: 'SKIPPED', ifirmaErrorMessage: null },
    });
    return;
  }

  const existingCorrection = orderReturn.salesDocument;
  if (existingCorrection && ['ISSUED', 'SENT'].includes(existingCorrection.status)) {
    await prisma.orderReturn.update({
      where: { id: orderReturn.id },
      data: { ifirmaStatus: 'ISSUED', ifirmaErrorMessage: null },
    });
    return;
  }

  const settings = await getDecryptedIfirmaSettings(orderReturn.shopId);
  const sourcePayload = sourceInvoice.requestPayloadJson && typeof sourceInvoice.requestPayloadJson === 'object'
    ? sourceInvoice.requestPayloadJson as Record<string, unknown>
    : null;
  const preview = buildIfirmaDomesticInvoiceCorrectionPayload({
    sourceInvoicePayload: sourcePayload,
    settings,
    orderReference: orderReturn.order.orderReference,
    correctionType: orderReturn.type,
    reason: orderReturn.reason,
    returnedItems: orderReturn.items.map((item) => ({
      productName: item.productNameSnapshot,
      quantity: Number(item.quantity),
      unitPriceTaxIncl: item.unitPriceTaxIncl == null ? null : Number(item.unitPriceTaxIncl),
      totalRefundTaxIncl: Number(item.totalRefundTaxIncl),
      taxRate: item.taxRate == null ? null : Number(item.taxRate),
    })),
    refundShipping: orderReturn.refundShipping,
  });

  if (preview.errors.length > 0) {
    throw new Error(preview.errors.join('; '));
  }

  const correction = existingCorrection
    ? await prisma.salesDocument.update({
        where: { id: existingCorrection.id },
        data: {
          status: 'PENDING',
          requestPayloadJson: preview.payload as Prisma.InputJsonValue,
          responsePayloadJson: Prisma.JsonNull,
          parentDocumentId: sourceInvoice.id,
          failedAt: null,
          errorMessage: null,
        },
      })
    : await prisma.salesDocument.create({
        data: {
          tenantId: orderReturn.tenantId,
          shopId: orderReturn.shopId,
          orderId: orderReturn.orderId,
          externalOrderId: orderReturn.externalOrderId,
          documentType: 'CORRECTION',
          documentKey: orderReturn.id,
          parentDocumentId: sourceInvoice.id,
          orderReturnId: orderReturn.id,
          status: 'PENDING',
          requestPayloadJson: preview.payload as Prisma.InputJsonValue,
        },
      });

  await prisma.orderReturn.update({
    where: { id: orderReturn.id },
    data: {
      ifirmaStatus: 'PENDING',
      ifirmaRequestPayloadJson: preview.payload as Prisma.InputJsonValue,
      ifirmaErrorMessage: null,
    },
  });

  const client = new IfirmaClient({
    login: settings.login,
    invoiceKey: settings.invoiceKey,
  });

  try {
    const response = await client.issueDomesticInvoiceCorrection(sourceInvoice.externalId, preview.payload);
    const externalId = response.identifier;
    const pdfPath = externalId
      ? await downloadAndStoreCorrectionPdf(client, correction.id, externalId).catch(() => null)
      : null;

    await prisma.salesDocument.update({
      where: { id: correction.id },
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

    await prisma.orderReturn.update({
      where: { id: orderReturn.id },
      data: {
        ifirmaStatus: 'ISSUED',
        ifirmaResponsePayloadJson: response.raw as Prisma.InputJsonValue,
        ifirmaErrorMessage: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nie udało się wystawić korekty iFirma';
    await prisma.salesDocument.update({
      where: { id: correction.id },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        errorMessage: message,
      },
    });
    await prisma.orderReturn.update({
      where: { id: orderReturn.id },
      data: {
        ifirmaStatus: 'FAILED',
        ifirmaErrorMessage: message,
      },
    });
    throw new Error(message);
  }
}

async function performPrestaShopStep(orderReturn: LoadedOrderReturn) {
  if (orderReturn.order.shop.platform !== 'PRESTASHOP') {
    await prisma.orderReturn.update({
      where: { id: orderReturn.id },
      data: { prestashopStatus: 'SKIPPED', prestashopErrorMessage: null },
    });
    return;
  }

  const client = createPrestaShopClient(orderReturn.order.shop);
  const orderSlipInput = buildOrderSlipInput(orderReturn);
  if (!orderSlipInput) {
    await prisma.orderReturn.update({
      where: { id: orderReturn.id },
      data: { prestashopStatus: 'SKIPPED', prestashopErrorMessage: null },
    });
    return;
  }

  await prisma.orderReturn.update({
    where: { id: orderReturn.id },
    data: {
      prestashopStatus: 'PENDING',
      prestashopRequestPayloadJson: orderSlipInput as unknown as Prisma.InputJsonValue,
      prestashopErrorMessage: null,
    },
  });

  try {
    if (!orderReturn.prestashopOrderSlipId) {
      const response = await client.createOrderSlip(orderSlipInput);
      const orderSlipId = response.id ?? 'CREATED_WITHOUT_ID';
      await prisma.orderReturn.update({
        where: { id: orderReturn.id },
        data: {
          prestashopOrderSlipId: orderSlipId,
          prestashopResponsePayloadJson: { id: response.id, raw: response.raw } as Prisma.InputJsonValue,
        },
      });
    }

    if (orderReturn.externalStatusId) {
      await client.createOrderHistory({
        orderId: orderReturn.externalOrderId,
        orderStateId: orderReturn.externalStatusId,
      });
      await prisma.order.update({
        where: { id: orderReturn.orderId },
        data: {
          externalStatusId: orderReturn.externalStatusId,
          externalStatusName: orderReturn.externalStatusName,
          statusSyncedAt: new Date(),
          statusSyncError: null,
        },
      });
    }

    await prisma.orderReturn.update({
      where: { id: orderReturn.id },
      data: {
        prestashopStatus: 'COMPLETED',
        prestashopErrorMessage: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nie udało się zsynchronizować zwrotu z PrestaShop';
    await prisma.orderReturn.update({
      where: { id: orderReturn.id },
      data: {
        prestashopStatus: 'FAILED',
        prestashopErrorMessage: message,
      },
    });
    throw new Error(message);
  }
}

async function updateFinalOrderStatus(orderReturn: LoadedOrderReturn) {
  const status = orderReturn.type === 'CANCELLATION'
    ? 'CANCELLED'
    : await isOrderFullyReturned(orderReturn.orderId)
      ? 'RETURNED'
      : 'PARTIALLY_RETURNED';

  await prisma.order.update({
    where: { id: orderReturn.orderId },
    data: { operationalStatus: status },
  });
}

async function isOrderFullyReturned(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      returns: {
        where: { status: { not: 'CANCELLED' } },
        include: { items: true },
      },
    },
  });
  if (!order) return false;

  const returned = returnedQuantitiesByOrderItemId(order.returns);
  return order.items.every((item) => {
    const returnedQuantity = returned.get(item.id) ?? 0;
    return returnedQuantity + 0.0001 >= Number(item.quantity);
  });
}

async function buildPreview(order: LoadedOrder, prepared: PreparedOperation) {
  const invoiceCorrection = await buildIfirmaPreview(order, prepared);
  const prestashop = buildPrestaShopPreview(order, prepared);
  const activeWz = order.warehouseDocuments.filter((document) => document.type === 'WZ' && document.status !== 'CANCELLED');

  return {
    orderId: order.id,
    orderReference: order.orderReference,
    type: prepared.type,
    reason: prepared.reason,
    refundShipping: prepared.refundShipping,
    restockItems: prepared.restockItems,
    autoConfirmWarehouseDocument: prepared.autoConfirmWarehouseDocument,
    externalStatusId: prepared.externalStatusId,
    externalStatusName: prepared.externalStatusName,
    items: prepared.items,
    totalRefundTaxIncl: prepared.totalRefundTaxIncl,
    totalRefundTaxExcl: prepared.totalRefundTaxExcl,
    shippingRefundTaxIncl: prepared.shippingRefundTaxIncl,
    shippingRefundTaxExcl: prepared.shippingRefundTaxExcl,
    warehouse: {
      releaseReservations: prepared.type === 'CANCELLATION',
      cancelWarehouseDocuments: activeWz.map((document) => ({
        id: document.id,
        number: document.number,
        status: document.status,
      })),
      createReturnDocument: prepared.type === 'RETURN' && prepared.restockItems,
      returnDocumentItems: prepared.items.filter((item) => item.warehouseProductId),
    },
    invoiceCorrection,
    prestashop,
  };
}

async function buildIfirmaPreview(order: LoadedOrder, prepared: PreparedOperation) {
  const sourceInvoice = getPrimaryInvoice(order);
  if (!sourceInvoice) {
    return { status: 'SKIPPED', invoice: null, payload: null, errors: [], warnings: ['Brak faktury iFirma do korekty.'] };
  }
  if (!sourceInvoice.externalId) {
    return {
      status: 'FAILED',
      invoice: sourceInvoice,
      payload: null,
      errors: ['Faktura pierwotna nie ma identyfikatora iFirma, więc nie można wystawić korekty.'],
      warnings: [],
    };
  }

  try {
    const settings = await getDecryptedIfirmaSettings(order.shopId);
    const sourcePayload = sourceInvoice.requestPayloadJson && typeof sourceInvoice.requestPayloadJson === 'object'
      ? sourceInvoice.requestPayloadJson as Record<string, unknown>
      : null;
    const preview = buildIfirmaDomesticInvoiceCorrectionPayload({
      sourceInvoicePayload: sourcePayload,
      settings,
      orderReference: order.orderReference,
      correctionType: prepared.type,
      reason: prepared.reason,
      returnedItems: prepared.items.map((item) => ({
        productName: item.productNameSnapshot,
        quantity: item.quantity,
        unitPriceTaxIncl: item.unitPriceTaxIncl,
        totalRefundTaxIncl: item.totalRefundTaxIncl,
        taxRate: item.taxRate,
      })),
      refundShipping: prepared.refundShipping,
    });

    return {
      status: preview.errors.length > 0 ? 'FAILED' : 'READY',
      invoice: sourceInvoice,
      payload: preview.payload,
      errors: preview.errors,
      warnings: preview.warnings,
    };
  } catch (error) {
    return {
      status: 'FAILED',
      invoice: sourceInvoice,
      payload: null,
      errors: [error instanceof Error ? error.message : 'Nie udało się zbudować korekty iFirma'],
      warnings: [],
    };
  }
}

function buildPrestaShopPreview(order: LoadedOrder, prepared: PreparedOperation) {
  const orderReturn = {
    ...prepared,
    id: 'preview',
    order,
    orderId: order.id,
    externalOrderId: order.externalOrderId,
    prestashopOrderSlipId: null,
  } as unknown as LoadedOrderReturn;

  try {
    const payload = buildOrderSlipInput(orderReturn);
    return { status: payload ? 'READY' : 'SKIPPED', payload, errors: [], warnings: [] };
  } catch (error) {
    return {
      status: 'FAILED',
      payload: null,
      errors: [error instanceof Error ? error.message : 'Nie udało się zbudować refundu PrestaShop'],
      warnings: [],
    };
  }
}

async function prepareOperation(
  order: LoadedOrder,
  type: OperationType,
  input: OrderReturnActionInput | (OrderCancellationActionInput & { items: OrderReturnActionInput['items'] }),
): Promise<PreparedOperation> {
  const externalStatus = await resolveExternalStatus(order, type, input.externalStatusId ?? null);
  const rawItems = input.items ?? [];
  if (type === 'RETURN' && rawItems.length === 0 && !input.refundShipping) {
    throw new Error('Zwrot wymaga co najmniej jednej pozycji albo zwrotu kosztu wysyłki.');
  }

  const items = prepareReturnItems(order, rawItems);
  const shippingRefundTaxIncl = input.refundShipping ? roundMoney(numberOrZero(order.totalShippingTaxIncl)) : 0;
  const shippingRefundTaxExcl = input.refundShipping ? roundMoney(numberOrZero(order.totalShippingTaxExcl)) : 0;
  const totalRefundTaxIncl = roundMoney(items.reduce((sum, item) => sum + item.totalRefundTaxIncl, 0) + shippingRefundTaxIncl);
  const totalRefundTaxExcl = roundMoney(items.reduce((sum, item) => sum + item.totalRefundTaxExcl, 0) + shippingRefundTaxExcl);

  return {
    type,
    reason: input.reason,
    refundShipping: input.refundShipping ?? false,
    restockItems: input.restockItems ?? true,
    autoConfirmWarehouseDocument: input.autoConfirmWarehouseDocument ?? true,
    externalStatusId: externalStatus?.externalStatusId ?? null,
    externalStatusName: externalStatus?.name ?? null,
    items,
    totalRefundTaxIncl,
    totalRefundTaxExcl,
    shippingRefundTaxIncl,
    shippingRefundTaxExcl,
  };
}

function prepareReturnItems(order: LoadedOrder, rawItems: OrderReturnActionInput['items']) {
  const returned = returnedQuantitiesByOrderItemId(order.returns);
  const orderItemById = new Map(order.items.map((item) => [item.id, item]));

  return rawItems.map((raw) => {
    const orderItem = orderItemById.get(raw.orderItemId);
    if (!orderItem) throw new Error(`Pozycja zamówienia ${raw.orderItemId} nie istnieje`);

    const alreadyReturnedQuantity = returned.get(orderItem.id) ?? 0;
    const availableQuantity = Number(orderItem.quantity) - alreadyReturnedQuantity;
    const quantity = Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`Ilość zwrotu dla pozycji "${orderItem.productNameSnapshot}" jest nieprawidłowa`);
    }
    if (quantity > availableQuantity + 0.0001) {
      throw new Error(`Nie można zwrócić ${quantity} szt. pozycji "${orderItem.productNameSnapshot}". Pozostało ${availableQuantity}.`);
    }

    const unitGross = unitPrice(orderItem.unitPriceTaxIncl, orderItem.totalPriceTaxIncl, orderItem.quantity);
    const unitNet = unitPrice(orderItem.unitPriceTaxExcl, orderItem.totalPriceTaxExcl, orderItem.quantity);
    const gross = roundMoney(quantity * (unitGross ?? 0));
    const net = roundMoney(quantity * (unitNet ?? gross));

    return {
      orderItemId: orderItem.id,
      externalItemId: orderItem.externalItemId,
      orderDetailId: resolveOrderDetailId(orderItem.externalItemId, orderItem.bundleExternalItemId),
      sku: orderItem.sku,
      productNameSnapshot: orderItem.productNameSnapshot,
      quantity,
      alreadyReturnedQuantity,
      availableQuantity,
      unitPriceTaxIncl: unitGross,
      unitPriceTaxExcl: unitNet,
      totalRefundTaxIncl: gross,
      totalRefundTaxExcl: net,
      taxRate: numberOrNull(orderItem.taxRate),
      warehouseProductId: orderItem.warehouseProductId,
    } satisfies PreparedReturnItem;
  });
}

function buildFullCancellationItems(order: LoadedOrder) {
  const returned = returnedQuantitiesByOrderItemId(order.returns);
  return order.items
    .map((item) => ({
      orderItemId: item.id,
      quantity: Math.max(0, Number(item.quantity) - (returned.get(item.id) ?? 0)),
    }))
    .filter((item) => item.quantity > 0);
}

function returnedQuantitiesByOrderItemId(returns: Array<{ status: string; items: Array<{ orderItemId: string; quantity: Prisma.Decimal | number | string }> }>) {
  const result = new Map<string, number>();
  for (const orderReturn of returns) {
    if (orderReturn.status === 'CANCELLED') continue;
    for (const item of orderReturn.items) {
      result.set(item.orderItemId, (result.get(item.orderItemId) ?? 0) + Number(item.quantity));
    }
  }
  return result;
}

function buildOrderSlipInput(orderReturn: LoadedOrderReturn): CreatePrestaShopOrderSlipInput | null {
  const customerId = resolvePrestaShopCustomerId(orderReturn.order.payloadJson);
  if (!customerId) throw new Error('Brak ID klienta PrestaShop w snapshotcie zamówienia.');

  const grouped = new Map<string, { quantity: number; gross: number; net: number; synthetic: boolean }>();
  for (const item of orderReturn.items) {
    const detailId = resolveOrderDetailId(item.externalItemId, null);
    if (!detailId) continue;
    const current = grouped.get(detailId) ?? { quantity: 0, gross: 0, net: 0, synthetic: item.externalItemId.includes(':') };
    current.quantity += Number(item.quantity);
    current.gross += Number(item.totalRefundTaxIncl);
    current.net += Number(item.totalRefundTaxExcl);
    current.synthetic = current.synthetic || item.externalItemId.includes(':');
    grouped.set(detailId, current);
  }

  const details = Array.from(grouped.entries()).map(([idOrderDetail, row]) => ({
    idOrderDetail,
    productQuantity: row.synthetic ? 1 : row.quantity,
    amountTaxExcl: roundMoney(row.net),
    amountTaxIncl: roundMoney(row.gross),
  }));
  const productGross = roundMoney(details.reduce((sum, item) => sum + item.amountTaxIncl, 0));
  const productNet = roundMoney(details.reduce((sum, item) => sum + item.amountTaxExcl, 0));
  const shippingGross = roundMoney(Number(orderReturn.shippingRefundTaxIncl));
  const shippingNet = roundMoney(Number(orderReturn.shippingRefundTaxExcl));

  if (details.length === 0 && shippingGross <= 0) return null;

  return {
    orderId: orderReturn.externalOrderId,
    customerId,
    conversionRate: 1,
    totalProductsTaxExcl: productNet,
    totalProductsTaxIncl: productGross,
    totalShippingTaxExcl: shippingNet,
    totalShippingTaxIncl: shippingGross,
    amount: roundMoney(productGross + shippingGross),
    shippingCost: shippingGross > 0,
    shippingCostAmount: shippingGross,
    partial: orderReturn.type === 'RETURN',
    details,
  };
}

function resolvePrestaShopCustomerId(payload: unknown) {
  const snapshot = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as any : {};
  return firstString(snapshot.order?.id_customer, snapshot.customer?.id, snapshot.id_customer);
}

async function resolveExternalStatus(order: LoadedOrder, type: OperationType, externalStatusId?: string | null) {
  if (externalStatusId) {
    return prisma.shopOrderStatus.findUnique({
      where: {
        shopId_externalStatusId: {
          shopId: order.shopId,
          externalStatusId,
        },
      },
    });
  }

  if (type === 'CANCELLATION') {
    return prisma.shopOrderStatus.findFirst({
      where: { shopId: order.shopId, isCancelled: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  return prisma.shopOrderStatus.findFirst({
    where: {
      shopId: order.shopId,
      OR: [
        { name: { contains: 'zwrot', mode: 'insensitive' } },
        { name: { contains: 'zwr', mode: 'insensitive' } },
        { name: { contains: 'refund', mode: 'insensitive' } },
        { name: { contains: 'return', mode: 'insensitive' } },
      ],
    },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
}

function getPrimaryInvoice<T extends { documentType: string; createdAt: Date }>(order: { salesDocuments: T[] }): T | null {
  return order.salesDocuments
    .filter((document) => document.documentType === 'INVOICE')
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))[0] ?? null;
}

function createPrestaShopClient(shop: LoadedOrder['shop']) {
  const config = shop.configJson && typeof shop.configJson === 'object' && !Array.isArray(shop.configJson)
    ? shop.configJson as any
    : {};
  const authType = config.authType === 'ADMIN_API' ? 'ADMIN_API' : 'WEB_SERVICE';
  return new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey: decrypt(shop.apiKey),
    authType,
    adminApiConfig: authType === 'ADMIN_API' ? config.adminApi : undefined,
  });
}

async function downloadAndStoreCorrectionPdf(client: IfirmaClient, documentId: string, externalId: string) {
  const pdf = await client.downloadDomesticInvoiceCorrectionPdf(externalId);
  const dir = path.join(process.cwd(), 'storage', 'invoices');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${documentId}.correction.pdf`);
  await writeFile(filePath, pdf);
  return filePath;
}

function resolveOrderDetailId(externalItemId: string, bundleExternalItemId?: string | null) {
  if (bundleExternalItemId) return bundleExternalItemId;
  return String(externalItemId).split(':')[0];
}

function unitPrice(unitPriceValue: unknown, totalValue: unknown, quantityValue: unknown) {
  const unit = numberOrNull(unitPriceValue);
  if (unit !== null) return unit;
  const total = numberOrNull(totalValue);
  const quantity = Number(quantityValue);
  if (total !== null && Number.isFinite(quantity) && quantity > 0) return roundMoney(total / quantity);
  return null;
}

function numberOrNull(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value: unknown) {
  return numberOrNull(value) ?? 0;
}

function roundMoney(value: number) {
  return Number((Math.round((value + Number.EPSILON) * 100) / 100).toFixed(2));
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}
