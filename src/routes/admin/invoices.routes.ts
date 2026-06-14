import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import * as invoicesService from '../../services/admin/invoices.service';

const looseObjectResponse = {
  type: 'object',
  additionalProperties: true,
} as const;

export async function invoicesRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/:id/pdf',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Pobierz zapisany lokalnie PDF faktury',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const pdf = await invoicesService.getInvoicePdf(request.params.id);
      reply
        .type('application/pdf')
        .header('Content-Disposition', `inline; filename="${pdf.filename}"`);
      return reply.send(createReadStream(pdf.path));
    },
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/publish-prestashop',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Przekaż link PDF faktury do zamówienia PrestaShop',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await invoicesService.publishInvoiceToPrestaShop(request.params.id);
      return reply.send(result);
    },
  );

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

  fastify.post<{ Params: { id: string } }>(
    '/:id/cancel',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Anuluj lokalny dokument faktury bez zmiany w iFirma',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await invoicesService.cancelInvoice(request.params.id);
      return reply.send(result);
    },
  );
}
