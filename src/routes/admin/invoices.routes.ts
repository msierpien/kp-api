import type { FastifyInstance } from 'fastify';
import * as invoicesService from '../../services/admin/invoices.service';

const looseObjectResponse = {
  type: 'object',
  additionalProperties: true,
} as const;

export async function invoicesRoutes(fastify: FastifyInstance) {
  fastify.post<{ Params: { id: string } }>(
    '/:id/retry',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Ponów wystawienie faktury po błędzie',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await invoicesService.retryInvoice(request.params.id);
      return reply.send(result);
    },
  );
}
