import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CustomerReturnRequestStatus } from '@prisma/client';
import * as service from '../../services/admin/customer-return-requests.service';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(['ALL', 'NEW', 'SHIPPING_SELECTED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CLOSED', 'CANCELLED', '']).optional(),
  shopId: z.string().optional(),
  q: z.string().optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['NEW', 'SHIPPING_SELECTED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CLOSED', 'CANCELLED']),
});

const looseObjectResponse = {
  type: 'object',
  additionalProperties: true,
} as const;

export async function customerReturnRequestsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['customer-return-requests'],
        summary: 'Lista zgłoszeń zwrotów klientów',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            status: { type: 'string', enum: ['ALL', 'NEW', 'SHIPPING_SELECTED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CLOSED', 'CANCELLED', ''] },
            shopId: { type: 'string' },
            q: { type: 'string' },
          },
        },
        response: { 200: looseObjectResponse, 400: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      const result = await service.listCustomerReturnRequests(parsed.data);
      return reply.send(result);
    },
  );

  fastify.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['customer-return-requests'],
        summary: 'Szczegóły zgłoszenia zwrotu klienta',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: looseObjectResponse, 400: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await service.getCustomerReturnRequest(request.params.id);
      return reply.send(result);
    },
  );

  fastify.patch<{ Params: { id: string }; Body: { status: CustomerReturnRequestStatus } }>(
    '/:id/status',
    {
      schema: {
        tags: ['customer-return-requests'],
        summary: 'Zmień status zgłoszenia zwrotu klienta',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { type: 'string', enum: ['NEW', 'SHIPPING_SELECTED', 'PAYMENT_PENDING', 'PAYMENT_COMPLETED', 'CLOSED', 'CANCELLED'] },
          },
        },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = updateStatusSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
        });
      }

      const result = await service.updateCustomerReturnRequestStatus(request.params.id, parsed.data.status);
      return reply.send(result);
    },
  );
}
