import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  handlePrestaShopOrderWebhook,
  PRESTASHOP_ORDER_WEBHOOK_EVENT_TYPES,
  WebhookRequestError,
  type PrestaShopOrderWebhookPayload,
} from '../../services/webhooks/prestashop-order-webhook.service';
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
}
