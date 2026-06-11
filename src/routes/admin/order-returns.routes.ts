import type { FastifyInstance } from 'fastify';
import * as orderReturnsService from '../../services/admin/order-returns.service';

const looseObjectResponse = {
  type: 'object',
  additionalProperties: true,
} as const;

export async function orderReturnsRoutes(fastify: FastifyInstance) {
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['orders'],
        summary: 'Usuń/anuluj zwrot i odwróć skutki magazynowe',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await orderReturnsService.deleteOrderReturn(request.params.id);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/retry',
    {
      schema: {
        tags: ['orders'],
        summary: 'Ponów nieudaną operację anulowania lub zwrotu',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await orderReturnsService.retryOrderReturn(request.params.id);
      return reply.send(result);
    },
  );
}
