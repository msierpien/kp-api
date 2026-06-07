import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { config } from '../../config';
import prisma from '../../lib/prisma';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { importPrestaShopOrder } from '../sync/sync-orders.service';
import { releaseOrderReservations } from '../admin/warehouse-reservations.service';
import { updateOrderExternalStatusFromWebhook } from '../admin/shop-order-statuses.service';

export const PRESTASHOP_ORDER_WEBHOOK_EVENT_TYPES = ['order_created', 'order_status_updated'] as const;
export type PrestaShopOrderWebhookEventType = typeof PRESTASHOP_ORDER_WEBHOOK_EVENT_TYPES[number];

export type ShopWebhookEventStatus = 'PENDING' | 'PROCESSED' | 'FAILED';

export interface PrestaShopOrderWebhookPayload {
  eventType: PrestaShopOrderWebhookEventType;
  shopId?: string | number;
  orderId: string | number;
  statusId: string | number;
  statusName?: string | null;
  timestamp: number;
  signature: string;
}

export interface ShopWebhookEventsQuery {
  page?: number;
  limit?: number;
  status?: ShopWebhookEventStatus;
}

export class WebhookRequestError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'WebhookRequestError';
    this.statusCode = statusCode;
  }
}

const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;
const DEFAULT_PAID_STATUS_IDS = ['2'];
const DEFAULT_RELEASE_STATUS_IDS = ['6', '7'];

function normalizeConfig(configJson: unknown) {
  return configJson && typeof configJson === 'object' && !Array.isArray(configJson)
    ? configJson as Record<string, any>
    : {};
}

function normalizeStatusIds(value: unknown, fallback: string[]) {
  if (Array.isArray(value)) {
    const ids = value.map((item) => String(item).trim()).filter(Boolean);
    return ids.length > 0 ? ids : fallback;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const id = String(value).trim();
    return id ? [id] : fallback;
  }

  return fallback;
}

function getWebhookConfig(configJson: unknown) {
  const shopConfig = normalizeConfig(configJson);
  const webhookConfig = normalizeConfig(shopConfig.webhook);

  return {
    enabled: webhookConfig.enabled === true,
    secret: typeof webhookConfig.secret === 'string' ? webhookConfig.secret.trim() : '',
    timestampToleranceSeconds: Number.isFinite(Number(webhookConfig.timestampToleranceSeconds))
      ? Number(webhookConfig.timestampToleranceSeconds)
      : DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
    paidStatusIds: normalizeStatusIds(
      webhookConfig.paidStatusIds ?? shopConfig.orderSync?.paidStatusIds,
      DEFAULT_PAID_STATUS_IDS
    ),
    releaseStatusIds: normalizeStatusIds(
      webhookConfig.releaseStatusIds ?? shopConfig.orderSync?.releaseStatusIds,
      DEFAULT_RELEASE_STATUS_IDS
    ),
  };
}

function buildWebhookUrl(shopId: string) {
  return `${config.app.url.replace(/\/+$/, '')}/webhooks/prestashop/${shopId}/orders`;
}

function buildSignaturePayload(input: {
  signingShopId: string;
  eventType: string;
  orderId: string;
  statusId: string;
  timestamp: string;
}) {
  return [
    input.signingShopId,
    input.eventType,
    input.orderId,
    input.statusId,
    input.timestamp,
  ].join('.');
}

function signWebhookPayload(secret: string, payload: string) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function safeCompareSignature(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function payloadHash(payload: unknown) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function buildEventKey(shopId: string, eventType: string, externalOrderId: string, statusId: string) {
  return `${shopId}:${eventType}:${externalOrderId}:${statusId}`;
}

function getAdminShopWhere(shopId: string) {
  const tenantId = getTenantId();
  const context = getTenantContext();

  if (!tenantId && context?.role !== 'SUPER_ADMIN') {
    throw new Error('Brak kontekstu tenanta');
  }

  return {
    id: shopId,
    ...(tenantId ? { tenantId } : {}),
  };
}

export async function handlePrestaShopOrderWebhook(shopId: string, payload: PrestaShopOrderWebhookPayload) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) {
    throw new WebhookRequestError(404, 'Shop not found');
  }

  if (shop.platform !== 'PRESTASHOP') {
    throw new WebhookRequestError(400, 'Shop is not a PrestaShop integration');
  }

  const webhookConfig = getWebhookConfig(shop.configJson);
  if (!webhookConfig.enabled) {
    throw new WebhookRequestError(403, 'Webhook is disabled for this shop');
  }

  if (!webhookConfig.secret) {
    throw new WebhookRequestError(403, 'Webhook secret is not configured');
  }

  verifyWebhookSignature(shop.id, webhookConfig.secret, webhookConfig.timestampToleranceSeconds, payload);

  const externalOrderId = String(payload.orderId).trim();
  const orderStatusId = String(payload.statusId).trim();
  const prestashopShopId = payload.shopId === undefined || payload.shopId === null
    ? null
    : String(payload.shopId).trim() || null;
  const eventKey = buildEventKey(shop.id, payload.eventType, externalOrderId, orderStatusId);
  const hash = payloadHash(payload);

  const existing = await prisma.shopWebhookEvent.findUnique({ where: { eventKey } });
  if (existing?.status === 'PROCESSED') {
    return {
      accepted: true,
      duplicate: true,
      eventId: existing.id,
      status: existing.status,
    };
  }

  const event = existing
    ? await prisma.shopWebhookEvent.update({
        where: { id: existing.id },
        data: {
          payloadHash: hash,
          payloadJson: payload as unknown as Prisma.InputJsonValue,
          orderStatusName: payload.statusName ?? null,
          errorMessage: null,
          status: 'PENDING',
          failedAt: null,
        },
      })
    : await prisma.shopWebhookEvent.create({
        data: {
          shopId: shop.id,
          eventKey,
          eventType: payload.eventType,
          externalOrderId,
          prestashopShopId,
          orderStatusId,
          orderStatusName: payload.statusName ?? null,
          payloadHash: hash,
          payloadJson: payload as unknown as Prisma.InputJsonValue,
        },
      });

  return processShopWebhookEvent(event.id);
}

function verifyWebhookSignature(
  apiShopId: string,
  secret: string,
  toleranceSeconds: number,
  payload: PrestaShopOrderWebhookPayload
) {
  const eventType = String(payload.eventType).trim();
  const orderId = String(payload.orderId).trim();
  const statusId = String(payload.statusId).trim();
  const timestamp = String(payload.timestamp).trim();
  const signingShopId = payload.shopId === undefined || payload.shopId === null
    ? apiShopId
    : String(payload.shopId).trim();

  if (!orderId || !statusId || !timestamp || !signingShopId || !payload.signature) {
    throw new WebhookRequestError(400, 'Missing required webhook signature fields');
  }

  const timestampSeconds = Number(payload.timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    throw new WebhookRequestError(401, 'Webhook timestamp is outside the accepted window');
  }

  const signaturePayload = buildSignaturePayload({
    signingShopId,
    eventType,
    orderId,
    statusId,
    timestamp,
  });
  const expected = signWebhookPayload(secret, signaturePayload);

  if (!safeCompareSignature(String(payload.signature).trim().toLowerCase(), expected)) {
    throw new WebhookRequestError(401, 'Invalid webhook signature');
  }
}

export async function processShopWebhookEvent(eventId: string) {
  const event = await prisma.shopWebhookEvent.findUnique({
    where: { id: eventId },
    include: { shop: true },
  });

  if (!event) {
    throw new Error('Webhook event not found');
  }

  const webhookConfig = getWebhookConfig(event.shop.configJson);
  const paidStatusIds = new Set(webhookConfig.paidStatusIds);
  const releaseStatusIds = new Set(webhookConfig.releaseStatusIds);
  const shouldReserve = paidStatusIds.has(event.orderStatusId);
  const shouldRelease = releaseStatusIds.has(event.orderStatusId);

  try {
    const errors: string[] = [];

    await updateOrderExternalStatusFromWebhook({
      shopId: event.shopId,
      externalOrderId: event.externalOrderId,
      externalStatusId: event.orderStatusId,
      externalStatusName: event.orderStatusName,
    });

    if (shouldReserve) {
      const imported = await importPrestaShopOrder(event.shopId, event.externalOrderId, {
        reserveStock: true,
        autoCreateWz: true,
        sendPersonalizationEmail: true,
      });
      errors.push(...imported.errors);
    }

    if (shouldRelease) {
      const order = await prisma.order.findUnique({
        where: {
          shopId_externalOrderId: {
            shopId: event.shopId,
            externalOrderId: event.externalOrderId,
          },
        },
        select: { id: true },
      });

      if (order) {
        await releaseOrderReservations(order.id);
      }
    }

    if (errors.length > 0) {
      const message = errors.join('; ');
      await markWebhookEventFailed(event.id, message);
      return {
        accepted: true,
        duplicate: false,
        eventId: event.id,
        status: 'FAILED' as const,
        errorMessage: message,
      };
    }

    await prisma.shopWebhookEvent.update({
      where: { id: event.id },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        failedAt: null,
        errorMessage: null,
      },
    });

    return {
      accepted: true,
      duplicate: false,
      eventId: event.id,
      status: 'PROCESSED' as const,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown webhook processing error';
    await markWebhookEventFailed(event.id, message);

    return {
      accepted: true,
      duplicate: false,
      eventId: event.id,
      status: 'FAILED' as const,
      errorMessage: message,
    };
  }
}

async function markWebhookEventFailed(eventId: string, message: string) {
  await prisma.shopWebhookEvent.update({
    where: { id: eventId },
    data: {
      status: 'FAILED',
      errorMessage: message,
      failedAt: new Date(),
    },
  });
}

export async function getShopWebhookSettings(shopId: string) {
  const shop = await prisma.shop.findFirst({
    where: getAdminShopWhere(shopId),
  });

  if (!shop) {
    throw new Error('Shop not found');
  }

  const webhookConfig = getWebhookConfig(shop.configJson);

  return {
    enabled: webhookConfig.enabled,
    webhookUrl: buildWebhookUrl(shop.id),
    secret: webhookConfig.secret || null,
    timestampToleranceSeconds: webhookConfig.timestampToleranceSeconds,
    paidStatusIds: webhookConfig.paidStatusIds,
    releaseStatusIds: webhookConfig.releaseStatusIds,
    signaturePayload: '{shopId}.{eventType}.{orderId}.{statusId}.{timestamp}',
    eventTypes: PRESTASHOP_ORDER_WEBHOOK_EVENT_TYPES,
  };
}

export async function updateShopWebhookSettings(shopId: string, input: { enabled?: boolean }) {
  const shop = await prisma.shop.findFirst({
    where: getAdminShopWhere(shopId),
  });

  if (!shop) {
    throw new Error('Shop not found');
  }

  const currentConfig = normalizeConfig(shop.configJson);
  const currentWebhook = normalizeConfig(currentConfig.webhook);
  const nextWebhook = {
    ...currentWebhook,
    ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
  };

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      configJson: {
        ...currentConfig,
        webhook: nextWebhook,
      } as Prisma.InputJsonValue,
    },
  });

  return getShopWebhookSettings(shop.id);
}

export async function rotateShopWebhookSecret(shopId: string) {
  const shop = await prisma.shop.findFirst({
    where: getAdminShopWhere(shopId),
  });

  if (!shop) {
    throw new Error('Shop not found');
  }

  const currentConfig = normalizeConfig(shop.configJson);
  const currentWebhook = normalizeConfig(currentConfig.webhook);
  const secret = crypto.randomBytes(32).toString('hex');

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      configJson: {
        ...currentConfig,
        webhook: {
          ...currentWebhook,
          enabled: true,
          secret,
          secretRotatedAt: new Date().toISOString(),
          timestampToleranceSeconds: currentWebhook.timestampToleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
        },
      } as Prisma.InputJsonValue,
    },
  });

  return getShopWebhookSettings(shop.id);
}

export async function listShopWebhookEvents(shopId: string, query: ShopWebhookEventsQuery = {}) {
  const shop = await prisma.shop.findFirst({
    where: getAdminShopWhere(shopId),
    select: { id: true },
  });

  if (!shop) {
    throw new Error('Shop not found');
  }

  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit || 20)));
  const where = {
    shopId: shop.id,
    ...(query.status ? { status: query.status } : {}),
  };

  const [total, data] = await Promise.all([
    prisma.shopWebhookEvent.count({ where }),
    prisma.shopWebhookEvent.findMany({
      where,
      orderBy: { receivedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function reprocessShopWebhookEvent(shopId: string, eventId: string) {
  const shop = await prisma.shop.findFirst({
    where: getAdminShopWhere(shopId),
    select: { id: true },
  });

  if (!shop) {
    throw new Error('Shop not found');
  }

  const event = await prisma.shopWebhookEvent.findFirst({
    where: {
      id: eventId,
      shopId: shop.id,
    },
  });

  if (!event) {
    throw new Error('Webhook event not found');
  }

  await prisma.shopWebhookEvent.update({
    where: { id: event.id },
    data: {
      status: 'PENDING',
      errorMessage: null,
      failedAt: null,
    },
  });

  return processShopWebhookEvent(event.id);
}
