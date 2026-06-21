import crypto from 'node:crypto';
import {
  CustomerReturnRequestStatus,
  CustomerReturnShippingChoice,
  Prisma,
  ReturnShippingPaymentStatus,
} from '@prisma/client';
import prisma from '../../lib/prisma';
import { WebhookRequestError } from './prestashop-order-webhook.service';

export const PRESTASHOP_RETURN_WEBHOOK_EVENT_TYPES = [
  'return_request_created',
  'return_shipping_updated',
  'return_payment_updated',
] as const;

export type PrestaShopReturnWebhookEventType = typeof PRESTASHOP_RETURN_WEBHOOK_EVENT_TYPES[number];

export interface PrestaShopReturnPaymentPayload {
  ext_order_id?: string | null;
  payu_order_id?: string | null;
  status?: string | null;
  amount?: string | number | null;
  currency?: string | null;
  package_count?: string | number | null;
  paid_at?: string | null;
}

export interface PrestaShopReturnWebhookPayload {
  eventType: PrestaShopReturnWebhookEventType;
  shopId?: string | number;
  prestashopShopId?: string | number;
  prestashopRequestId: string | number;
  externalOrderId: string | number;
  orderReference: string;
  customerEmail: string;
  customerName?: string | null;
  returnType: string;
  reason?: string | null;
  items: unknown[];
  shippingChoice?: string | null;
  packageCount?: string | number | null;
  shippingAmount?: string | number | null;
  returnAddress?: string | null;
  status?: string | null;
  payment?: PrestaShopReturnPaymentPayload | null;
  timestamp: number;
  signature: string;
}

function normalizeConfig(configJson: unknown) {
  return configJson && typeof configJson === 'object' && !Array.isArray(configJson)
    ? configJson as Record<string, any>
    : {};
}

function getWebhookConfig(configJson: unknown) {
  const shopConfig = normalizeConfig(configJson);
  const webhookConfig = normalizeConfig(shopConfig.webhook);

  return {
    enabled: webhookConfig.enabled === true,
    secret: typeof webhookConfig.secret === 'string' ? webhookConfig.secret.trim() : '',
    timestampToleranceSeconds: Number.isFinite(Number(webhookConfig.timestampToleranceSeconds))
      ? Number(webhookConfig.timestampToleranceSeconds)
      : 300,
  };
}

function safeCompareSignature(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');

  if (actualBuffer.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function sign(secret: string, value: string) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function verifySignature(apiShopId: string, secret: string, toleranceSeconds: number, payload: PrestaShopReturnWebhookPayload) {
  const timestamp = String(payload.timestamp).trim();
  const timestampSeconds = Number(payload.timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    throw new WebhookRequestError(401, 'Webhook timestamp is outside the accepted window');
  }

  const signingShopId = payload.shopId === undefined || payload.shopId === null
    ? apiShopId
    : String(payload.shopId).trim();
  const signed = [
    signingShopId,
    String(payload.eventType).trim(),
    String(payload.prestashopRequestId).trim(),
    String(payload.externalOrderId).trim(),
    timestamp,
  ].join('.');
  const expected = sign(secret, signed);

  if (!safeCompareSignature(String(payload.signature).trim().toLowerCase(), expected)) {
    throw new WebhookRequestError(401, 'Invalid webhook signature');
  }
}

function mapRequestStatus(value: string | null | undefined): CustomerReturnRequestStatus {
  switch (value) {
    case 'SHIPPING_SELECTED':
      return CustomerReturnRequestStatus.SHIPPING_SELECTED;
    case 'PAYMENT_PENDING':
      return CustomerReturnRequestStatus.PAYMENT_PENDING;
    case 'PAYMENT_COMPLETED':
      return CustomerReturnRequestStatus.PAYMENT_COMPLETED;
    case 'CANCELLED':
    case 'CANCELED':
      return CustomerReturnRequestStatus.CANCELLED;
    case 'CLOSED':
      return CustomerReturnRequestStatus.CLOSED;
    default:
      return CustomerReturnRequestStatus.NEW;
  }
}

function mapShippingChoice(value: string | null | undefined): CustomerReturnShippingChoice {
  if (value === 'MANUAL') return CustomerReturnShippingChoice.MANUAL;
  if (value === 'INPOST_PAYU') return CustomerReturnShippingChoice.INPOST_PAYU;
  if (value === 'INPOST_CUSTOMER_PAID') return CustomerReturnShippingChoice.INPOST_CUSTOMER_PAID;
  return CustomerReturnShippingChoice.UNDECIDED;
}

function mapPaymentStatus(value: string | null | undefined): ReturnShippingPaymentStatus {
  if (value === 'COMPLETED') return ReturnShippingPaymentStatus.COMPLETED;
  if (value === 'CANCELED' || value === 'CANCELLED') return ReturnShippingPaymentStatus.CANCELED;
  if (value === 'FAILED') return ReturnShippingPaymentStatus.FAILED;
  if (value === 'PENDING') return ReturnShippingPaymentStatus.PENDING;
  return ReturnShippingPaymentStatus.NEW;
}

function decimal(value: unknown) {
  const number = Number(value ?? 0);
  return new Prisma.Decimal(Number.isFinite(number) ? number : 0);
}

function dateOrNull(value: unknown) {
  if (!value || typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function handlePrestaShopReturnWebhook(shopId: string, payload: PrestaShopReturnWebhookPayload) {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw new WebhookRequestError(404, 'Shop not found');
  if (shop.platform !== 'PRESTASHOP') throw new WebhookRequestError(400, 'Shop is not a PrestaShop integration');

  const webhookConfig = getWebhookConfig(shop.configJson);
  if (!webhookConfig.enabled) throw new WebhookRequestError(403, 'Webhook is disabled for this shop');
  if (!webhookConfig.secret) throw new WebhookRequestError(403, 'Webhook secret is not configured');

  verifySignature(shop.id, webhookConfig.secret, webhookConfig.timestampToleranceSeconds, payload);

  const externalOrderId = String(payload.externalOrderId).trim();
  const prestashopRequestId = String(payload.prestashopRequestId).trim();
  const order = await prisma.order.findUnique({
    where: {
      shopId_externalOrderId: {
        shopId: shop.id,
        externalOrderId,
      },
    },
    select: { id: true },
  });

  const data = {
    tenantId: shop.tenantId,
    shopId: shop.id,
    orderId: order?.id ?? null,
    externalOrderId,
    prestashopRequestId,
    orderReference: payload.orderReference,
    customerEmail: payload.customerEmail,
    customerName: payload.customerName ?? null,
    returnType: payload.returnType,
    reason: payload.reason ?? null,
    itemsJson: payload.items as Prisma.InputJsonValue,
    shippingChoice: mapShippingChoice(payload.shippingChoice),
    packageCount: Number(payload.packageCount ?? 0) || 0,
    shippingAmount: decimal(payload.shippingAmount),
    returnAddress: payload.returnAddress ?? null,
    status: mapRequestStatus(payload.status),
    lastPayloadJson: payload as unknown as Prisma.InputJsonValue,
  };

  const request = await prisma.customerReturnRequest.upsert({
    where: {
      shopId_prestashopRequestId: {
        shopId: shop.id,
        prestashopRequestId,
      },
    },
    create: data,
    update: data,
  });

  const payment = payload.payment;
  if (payment?.ext_order_id || payment?.payu_order_id) {
    const extOrderId = payment.ext_order_id ? String(payment.ext_order_id) : null;
    const paymentData = {
      tenantId: shop.tenantId,
      shopId: shop.id,
      customerReturnRequestId: request.id,
      provider: 'PAYU',
      status: mapPaymentStatus(payment.status ?? null),
      extOrderId,
      payuOrderId: payment.payu_order_id ? String(payment.payu_order_id) : null,
      amount: decimal(payment.amount),
      currency: payment.currency ? String(payment.currency) : 'PLN',
      packageCount: Number(payment.package_count ?? payload.packageCount ?? 0) || 0,
      payloadJson: payment as unknown as Prisma.InputJsonValue,
      paidAt: dateOrNull(payment.paid_at),
    };

    if (extOrderId) {
      await prisma.returnShippingPayment.upsert({
        where: { extOrderId },
        create: paymentData,
        update: paymentData,
      });
    } else {
      await prisma.returnShippingPayment.create({ data: paymentData });
    }
  }

  return prisma.customerReturnRequest.findUnique({
    where: { id: request.id },
    include: {
      shop: { select: { id: true, name: true, platform: true } },
      order: { select: { id: true, orderReference: true, externalOrderId: true } },
      payments: { orderBy: { createdAt: 'desc' } },
    },
  });
}
