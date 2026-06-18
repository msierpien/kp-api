import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { PrestaShopClient } from '../prestashop/prestashop-client';
import type { ShopOrderStatusMappingInput, UpdateOrderStatusInput } from '../../schemas/admin.schema';
import {
  assertOrderOperationalStatus,
  inferOperationalStatusFromShopStatus,
} from '../../lib/order-statuses';
import type { OrderOperationalStatus } from '../../lib/order-statuses';
import {
  findShopOrderStatusRecord,
  listShopOrderStatusRecords,
  updateShopOrderStatusMappingRecord,
  upsertShopOrderStatusRecord,
} from '../shop-order-statuses.repository';

function tenantScopedWhere(id: string) {
  const tenantId = getTenantId();
  const context = getTenantContext();
  if (!tenantId && context?.role !== 'SUPER_ADMIN') {
    throw new Error('Brak kontekstu tenanta');
  }

  return {
    id,
    ...(tenantId ? { tenantId } : {}),
  };
}

async function getShop(shopId: string) {
  const shop = await prisma.shop.findFirst({ where: tenantScopedWhere(shopId) });
  if (!shop) throw new Error('Sklep nie znaleziony');
  if (shop.platform !== 'PRESTASHOP') throw new Error('Statusy obsługiwane są tylko dla PrestaShop');
  return shop;
}

function createClient(shop: any) {
  const config = (shop.configJson as any) || {};
  const authType = config.authType === 'ADMIN_API' ? 'ADMIN_API' : 'WEB_SERVICE';
  return new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey: decrypt(shop.apiKey),
    authType,
    adminApiConfig: authType === 'ADMIN_API' ? config.adminApi : undefined,
  });
}

async function findMappedExternalStatusId(shopId: string, operationalStatus: OrderOperationalStatus) {
  const statuses = await listShopOrderStatusRecords(shopId);
  const mappedStatus = statuses.find((status) => inferOperationalStatusFromShopStatus(status) === operationalStatus);
  return mappedStatus?.externalStatusId ?? null;
}

export async function listShopOrderStatuses(shopId: string) {
  const shop = await getShop(shopId);
  return listShopOrderStatusRecords(shop.id);
}

export async function syncShopOrderStatuses(shopId: string) {
  const shop = await getShop(shopId);
  const statuses = await createClient(shop).fetchOrderStates();
  const now = new Date();

  for (const status of statuses) {
    const operationalStatus = inferOperationalStatusFromShopStatus({
      externalStatusId: status.id,
      name: status.name,
      isPaid: status.paid,
      isCancelled: status.deleted,
      shipped: status.shipped,
      delivery: status.delivery,
    });
    await upsertShopOrderStatusRecord({
      tenantId: shop.tenantId,
      shopId: shop.id,
      externalStatusId: status.id,
      name: status.name,
      color: status.color ?? null,
      operationalStatus,
      isPaid: status.paid,
      isCancelled: status.deleted,
      sortOrder: Number(status.id) || 0,
      payloadJson: status.payload as Prisma.InputJsonValue,
      lastSyncedAt: now,
    });
  }

  return listShopOrderStatuses(shop.id);
}

export async function updateShopOrderStatusMappings(shopId: string, input: ShopOrderStatusMappingInput) {
  const shop = await getShop(shopId);

  for (const status of input.statuses) {
    await updateShopOrderStatusMappingRecord({
      shopId: shop.id,
      externalStatusId: status.externalStatusId,
      operationalStatus: status.operationalStatus,
      isPaid: status.isPaid,
      isCancelled: status.isCancelled,
      isReadyForInvoice: status.isReadyForInvoice,
      isInvoiceTarget: status.isInvoiceTarget,
    });
  }

  return listShopOrderStatuses(shop.id);
}

export async function updateOrderExternalStatusFromWebhook(input: {
  shopId: string;
  externalOrderId: string;
  externalStatusId: string;
  externalStatusName?: string | null;
}) {
  const status = await findShopOrderStatusRecord(input.shopId, input.externalStatusId);
  const operationalStatus = inferOperationalStatusFromShopStatus(status ?? {
    externalStatusId: input.externalStatusId,
    name: input.externalStatusName,
  });

  const result = await prisma.order.updateMany({
    where: {
      shopId: input.shopId,
      externalOrderId: input.externalOrderId,
    },
    data: {
      externalStatusId: input.externalStatusId,
      externalStatusName: input.externalStatusName ?? status?.name ?? null,
      operationalStatus,
      statusSyncedAt: new Date(),
    },
  });

  return {
    updatedCount: result.count,
    operationalStatus,
  };
}

export async function updateOrderStatus(orderId: string, input: UpdateOrderStatusInput) {
  const tenantId = getTenantId();
  const order = await prisma.order.findFirst({
    where: {
      id: orderId,
      ...(tenantId ? { shop: { tenantId } } : {}),
    },
    include: { shop: true },
  });

  if (!order) throw new Error('Zamówienie nie znalezione');

  const localUpdate: any = {};
  const operationalStatus = input.operationalStatus
    ? assertOrderOperationalStatus(input.operationalStatus)
    : null;

  if (operationalStatus) localUpdate.operationalStatus = operationalStatus;

  if (Object.keys(localUpdate).length > 0) {
    await prisma.order.update({ where: { id: order.id }, data: localUpdate });
  }

  let externalStatusId = input.externalStatusId ?? null;
  if (!externalStatusId && operationalStatus && order.shop.platform === 'PRESTASHOP') {
    externalStatusId = await findMappedExternalStatusId(order.shopId, operationalStatus);
  }

  if (!externalStatusId || order.shop.platform !== 'PRESTASHOP') {
    return prisma.order.findUnique({ where: { id: order.id } });
  }

  const status = await findShopOrderStatusRecord(order.shopId, externalStatusId);

  try {
    await createClient(order.shop).createOrderHistory({
      orderId: order.externalOrderId,
      orderStateId: externalStatusId,
    });

    return prisma.order.update({
      where: { id: order.id },
      data: {
        externalStatusId,
        externalStatusName: status?.name ?? null,
        ...(status ? { operationalStatus: inferOperationalStatusFromShopStatus(status) } : {}),
        statusSyncedAt: new Date(),
        statusSyncError: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nie udało się zsynchronizować statusu z PrestaShop';
    return prisma.order.update({
      where: { id: order.id },
      data: {
        statusSyncError: message,
      },
    });
  }
}
