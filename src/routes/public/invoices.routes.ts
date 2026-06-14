import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import * as invoicesService from '../../services/admin/invoices.service';

export async function publicInvoicesRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/:id/pdf',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Publiczny podpisany link PDF faktury',
        security: [],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          required: ['token'],
          properties: { token: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      try {
        const pdf = await invoicesService.getPublicInvoicePdf(request.params.id, request.query.token ?? '');
        reply
          .type('application/pdf')
          .header('Content-Disposition', `inline; filename="${pdf.filename}"`)
          .header('Referrer-Policy', 'no-referrer')
          .header('Cache-Control', 'private, max-age=300');
        return reply.send(createReadStream(pdf.path));
      } catch (error) {
        return reply.status(404).send({
          error: 'Invoice PDF Error',
          message: error instanceof Error ? error.message : 'Nie udało się pobrać PDF faktury',
        });
      }
    },
  );
}
