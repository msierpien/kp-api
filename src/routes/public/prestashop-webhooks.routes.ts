import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  handlePrestaShopOrderWebhook,
  PRESTASHOP_ORDER_WEBHOOK_EVENT_TYPES,
  WebhookRequestError,
  type PrestaShopOrderWebhookPayload,
} from '../../services/webhooks/prestashop-order-webhook.service';
import {
  handlePrestaShopReturnWebhook,
  PRESTASHOP_RETURN_WEBHOOK_EVENT_TYPES,
  type PrestaShopReturnWebhookPayload,
} from '../../services/webhooks/prestashop-return-request.service';
import { RATE_LIMITS } from '../../lib/rate-limits';

const webhookParamsSchema = z.object({
  shopId: z.string().min(1),
});

const webhookPayloadSchema = z.object({
  eventType: z.enum(PRESTASHOP_ORDER_WEBHOOK_EVENT_TYPES),
  shopId: z.union([z.string(), z.number()]).optional(),
  orderId: z.union([z.string(), z.number()]),
  statusId: z.union([z.string(), z.number()]),
  statusName: z.string().optional().nullable(),
  timestamp: z.coerce.number().int().positive(),
  signature: z.string().min(1),
});

const returnWebhookPayloadSchema = z.object({
  eventType: z.enum(PRESTASHOP_RETURN_WEBHOOK_EVENT_TYPES),
  shopId: z.union([z.string(), z.number()]).optional(),
  prestashopShopId: z.union([z.string(), z.number()]).optional(),
  prestashopRequestId: z.union([z.string(), z.number()]),
  externalOrderId: z.union([z.string(), z.number()]),
  orderReference: z.string().min(1),
  customerEmail: z.string().email(),
  customerName: z.string().optional().nullable(),
  returnType: z.string().min(1),
  reason: z.string().optional().nullable(),
  items: z.array(z.unknown()),
  shippingChoice: z.string().optional().nullable(),
  packageCount: z.union([z.string(), z.number()]).optional().nullable(),
  shippingAmount: z.union([z.string(), z.number()]).optional().nullable(),
  returnAddress: z.string().optional().nullable(),
  status: z.string().optional().nullable(),
  payment: z.object({
    ext_order_id: z.string().optional().nullable(),
    payu_order_id: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    amount: z.union([z.string(), z.number()]).optional().nullable(),
    currency: z.string().optional().nullable(),
    package_count: z.union([z.string(), z.number()]).optional().nullable(),
    paid_at: z.string().optional().nullable(),
  }).passthrough().optional().nullable(),
  timestamp: z.coerce.number().int().positive(),
  signature: z.string().min(1),
});

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
};

export async function prestashopWebhooksRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { shopId: string }; Body: PrestaShopOrderWebhookPayload }>(
    '/:shopId/orders',
    {
      config: {
        rateLimit: RATE_LIMITS.prestashopWebhook,
      },
      schema: {
        tags: ['webhooks'],
        summary: 'Webhook zamówień PrestaShop',
        security: [],
        params: {
          type: 'object',
          required: ['shopId'],
          properties: {
            shopId: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: ['eventType', 'orderId', 'statusId', 'timestamp', 'signature'],
          properties: {
            eventType: { type: 'string', enum: [...PRESTASHOP_ORDER_WEBHOOK_EVENT_TYPES] },
            shopId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            orderId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            statusId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            statusName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            timestamp: { type: 'integer' },
            signature: { type: 'string' },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { shopId: string }; Body: PrestaShopOrderWebhookPayload }>,
      reply: FastifyReply
    ) => {
      const paramsParsed = webhookParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      const bodyParsed = webhookPayloadSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: bodyParsed.error.errors[0].message,
        });
      }

      try {
        const result = await handlePrestaShopOrderWebhook(paramsParsed.data.shopId, bodyParsed.data);
        return reply.send(result);
      } catch (error) {
        if (error instanceof WebhookRequestError) {
          return reply.status(error.statusCode).send({
            error: 'Webhook Error',
            message: error.message,
          });
        }

        request.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Webhook processing failed',
        });
      }
    }
  );

  fastify.post<{ Params: { shopId: string }; Body: PrestaShopReturnWebhookPayload }>(
    '/:shopId/return-requests',
    {
      config: {
        rateLimit: RATE_LIMITS.prestashopWebhook,
      },
      schema: {
        tags: ['webhooks'],
        summary: 'Webhook zgłoszeń zwrotów klientów z PrestaShop',
        security: [],
        params: {
          type: 'object',
          required: ['shopId'],
          properties: {
            shopId: { type: 'string' },
          },
        },
        body: {
          type: 'object',
          required: [
            'eventType',
            'prestashopRequestId',
            'externalOrderId',
            'orderReference',
            'customerEmail',
            'returnType',
            'items',
            'timestamp',
            'signature',
          ],
          properties: {
            eventType: { type: 'string', enum: [...PRESTASHOP_RETURN_WEBHOOK_EVENT_TYPES] },
            shopId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            prestashopShopId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            prestashopRequestId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            externalOrderId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
            orderReference: { type: 'string' },
            customerEmail: { type: 'string' },
            customerName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            returnType: { type: 'string' },
            reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            items: { type: 'array' },
            shippingChoice: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            packageCount: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
            shippingAmount: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] },
            returnAddress: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            status: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            payment: { type: 'object', additionalProperties: true },
            timestamp: { type: 'integer' },
            signature: { type: 'string' },
          },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: { shopId: string }; Body: PrestaShopReturnWebhookPayload }>,
      reply: FastifyReply
    ) => {
      const paramsParsed = webhookParamsSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      const bodyParsed = returnWebhookPayloadSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: bodyParsed.error.errors[0].message,
        });
      }

      try {
        const result = await handlePrestaShopReturnWebhook(paramsParsed.data.shopId, bodyParsed.data);
        return reply.send(result);
      } catch (error) {
        if (error instanceof WebhookRequestError) {
          return reply.status(error.statusCode).send({
            error: 'Webhook Error',
            message: error.message,
          });
        }

        request.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Webhook processing failed',
        });
      }
    }
  );
}
