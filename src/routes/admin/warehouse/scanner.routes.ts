import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as barcodeService from '../../../services/admin/warehouse-barcodes.service';
import * as scannerService from '../../../services/admin/warehouse-scanner.service';

export async function registerWarehouseScannerRoutes(fastify: FastifyInstance) {
  fastify.get('/barcodes/:ean/lookup', {
    schema: { tags: ['warehouse'], summary: 'Znajdź produkt magazynowy po kodzie EAN' },
  }, async (request: FastifyRequest<{ Params: { ean: string } }>, reply: FastifyReply) => {
    try {
      const barcode = await barcodeService.lookupBarcode(request.params.ean);
      if (!barcode) return reply.status(404).send({ error: 'Not Found', message: 'Kod EAN nie znaleziony' });
      return reply.send({
        barcode: {
          id: barcode.id,
          ean: barcode.ean,
          label: barcode.label,
          quantityMultiplier: barcode.quantityMultiplier,
          isPrimary: barcode.isPrimary,
        },
        product: barcode.warehouseProduct,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd wyszukiwania EAN';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/scan/resolve', {
    schema: {
      tags: ['warehouse'],
      summary: 'Rozpoznaj skan EAN w magazynie albo hurtowniach',
      body: {
        type: 'object',
        required: ['ean'],
        properties: {
          ean: { type: 'string', minLength: 1 },
          includeWholesalePrice: { type: 'boolean' },
          providerIds: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: scannerService.ResolveWarehouseScanInput }>, reply: FastifyReply) => {
    try {
      const result = await scannerService.resolveWarehouseScan(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd rozpoznawania skanu EAN';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/scan/wholesale/:mappingId/accept', {
    schema: {
      tags: ['warehouse'],
      summary: 'Utwórz albo podepnij produkt z oferty hurtowni znalezionej skanerem',
      params: {
        type: 'object',
        required: ['mappingId'],
        properties: { mappingId: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          catalogId: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { mappingId: string };
    Body: scannerService.AcceptWholesaleScanInput;
  }>, reply: FastifyReply) => {
    try {
      const result = await scannerService.acceptWholesaleScanMapping(request.params.mappingId, request.body ?? {});
      return reply.status(201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd akceptacji produktu z hurtowni';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });
}
