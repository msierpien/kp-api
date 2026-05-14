import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as warehouseService from '../../services/admin/warehouse.service';
import * as barcodeService from '../../services/admin/warehouse-barcodes.service';
import { getStock, getProductStock, recalculateStockCache } from '../../services/admin/warehouse-stock.service';

export async function warehouseRoutes(fastify: FastifyInstance) {
  // ─── Barcodes / scanner ──────────────────────────────────────────────────

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

  // ─── Products ─────────────────────────────────────────────────────────────

  // GET /admin/warehouse/products
  fastify.get('/products', {
    schema: {
      tags: ['warehouse'],
      summary: 'Lista produktów magazynowych',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          search: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: warehouseService.ProductsQuery }>, reply: FastifyReply) => {
    try {
      const result = await warehouseService.getProducts(request.query);
      return reply.send(result);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Nie udało się pobrać produktów' });
    }
  });

  // POST /admin/warehouse/products
  fastify.post('/products', {
    schema: {
      tags: ['warehouse'],
      summary: 'Utwórz produkt magazynowy',
      body: {
        type: 'object',
        required: ['sku', 'name'],
        properties: {
          sku: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          unit: { type: 'string', default: 'szt' },
          description: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: warehouseService.CreateProductInput }>, reply: FastifyReply) => {
    try {
      const product = await warehouseService.createProduct(request.body);
      return reply.status(201).send(product);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia produktu';
      return reply.status(400).send({ error: 'Bad Request', message });
    }
  });

  // GET /admin/warehouse/products/:id
  fastify.get('/products/:id', {
    schema: { tags: ['warehouse'], summary: 'Szczegóły produktu' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const product = await warehouseService.getProductById(request.params.id);
      if (!product) return reply.status(404).send({ error: 'Not Found', message: 'Produkt nie znaleziony' });
      return reply.send(product);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Błąd pobierania produktu' });
    }
  });

  fastify.get('/products/:id/barcodes', {
    schema: { tags: ['warehouse'], summary: 'Lista kodów EAN produktu' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const product = await warehouseService.getProductById(request.params.id);
      if (!product) return reply.status(404).send({ error: 'Not Found', message: 'Produkt nie znaleziony' });
      const barcodes = await barcodeService.getProductBarcodes(request.params.id);
      return reply.send(barcodes);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Błąd pobierania kodów EAN' });
    }
  });

  fastify.post('/products/:id/barcodes', {
    schema: {
      tags: ['warehouse'],
      summary: 'Dodaj kod EAN do produktu',
      body: {
        type: 'object',
        required: ['ean'],
        properties: {
          ean: { type: 'string', minLength: 1 },
          label: { type: 'string' },
          quantityMultiplier: { type: 'number', exclusiveMinimum: 0, default: 1 },
          isPrimary: { type: 'boolean', default: false },
          isActive: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: barcodeService.CreateBarcodeInput }>, reply: FastifyReply) => {
    try {
      const barcode = await barcodeService.createBarcode(request.params.id, request.body);
      return reply.status(201).send(barcode);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd dodawania EAN';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // PUT /admin/warehouse/products/:id
  fastify.put('/products/:id', {
    schema: {
      tags: ['warehouse'],
      summary: 'Edytuj produkt magazynowy',
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          unit: { type: 'string' },
          description: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: warehouseService.UpdateProductInput }>, reply: FastifyReply) => {
    try {
      const product = await warehouseService.updateProduct(request.params.id, request.body);
      return reply.send(product);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji produktu';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // DELETE /admin/warehouse/products/:id
  fastify.delete('/products/:id', {
    schema: { tags: ['warehouse'], summary: 'Usuń produkt magazynowy' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      await warehouseService.deleteProduct(request.params.id);
      return reply.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania produktu';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.put('/barcodes/:id', {
    schema: {
      tags: ['warehouse'],
      summary: 'Edytuj kod EAN',
      body: {
        type: 'object',
        properties: {
          ean: { type: 'string', minLength: 1 },
          label: { type: ['string', 'null'] },
          quantityMultiplier: { type: 'number', exclusiveMinimum: 0 },
          isPrimary: { type: 'boolean' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: barcodeService.UpdateBarcodeInput }>, reply: FastifyReply) => {
    try {
      const barcode = await barcodeService.updateBarcode(request.params.id, request.body);
      return reply.send(barcode);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji EAN';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.delete('/barcodes/:id', {
    schema: { tags: ['warehouse'], summary: 'Usuń lub dezaktywuj kod EAN' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const result = await barcodeService.deleteBarcode(request.params.id);
      if (result.action === 'deactivated') return reply.send(result.barcode);
      return reply.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania EAN';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // GET /admin/warehouse/products/:id/stock
  fastify.get('/products/:id/stock', {
    schema: { tags: ['warehouse'], summary: 'Aktualny stan produktu' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const stock = await getProductStock(request.params.id);
      if (!stock) return reply.status(404).send({ error: 'Not Found', message: 'Produkt nie znaleziony' });
      return reply.send(stock);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Błąd pobierania stanu' });
    }
  });

  // ─── Documents ────────────────────────────────────────────────────────────

  // GET /admin/warehouse/documents
  fastify.get('/documents', {
    schema: {
      tags: ['warehouse'],
      summary: 'Lista dokumentów magazynowych',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          type: { type: 'string', enum: ['PZ', 'PW', 'WZ', 'RW'] },
          status: { type: 'string', enum: ['DRAFT', 'CONFIRMED', 'CANCELLED'] },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: warehouseService.DocumentsQuery }>, reply: FastifyReply) => {
    try {
      const result = await warehouseService.getDocuments(request.query);
      return reply.send(result);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Nie udało się pobrać dokumentów' });
    }
  });

  // POST /admin/warehouse/documents
  fastify.post('/documents', {
    schema: {
      tags: ['warehouse'],
      summary: 'Utwórz dokument magazynowy (DRAFT)',
      body: {
        type: 'object',
        required: ['type', 'items'],
        properties: {
          type: { type: 'string', enum: ['PZ', 'PW', 'WZ', 'RW'] },
          date: { type: 'string' },
          description: { type: 'string' },
          orderId: { type: 'string' },
          isAutoGenerated: { type: 'boolean' },
          metadataJson: { type: 'object', additionalProperties: true },
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['productId'],
              properties: {
                productId: { type: 'string' },
                quantity: { type: 'number', exclusiveMinimum: 0 },
                barcodeId: { type: 'string' },
                scannedEan: { type: 'string' },
                baseQuantity: { type: 'number', exclusiveMinimum: 0 },
                quantityMultiplier: { type: 'number', exclusiveMinimum: 0 },
                unitPrice: { type: 'number', minimum: 0 },
                notes: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: warehouseService.CreateDocumentInput }>, reply: FastifyReply) => {
    try {
      const doc = await warehouseService.createDocument(request.body);
      return reply.status(201).send(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia dokumentu';
      return reply.status(400).send({ error: 'Bad Request', message });
    }
  });

  // GET /admin/warehouse/documents/:id
  fastify.get('/documents/:id', {
    schema: { tags: ['warehouse'], summary: 'Szczegóły dokumentu' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const doc = await warehouseService.getDocumentById(request.params.id);
      if (!doc) return reply.status(404).send({ error: 'Not Found', message: 'Dokument nie znaleziony' });
      return reply.send(doc);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Błąd pobierania dokumentu' });
    }
  });

  // PUT /admin/warehouse/documents/:id
  fastify.put('/documents/:id', {
    schema: {
      tags: ['warehouse'],
      summary: 'Edytuj dokument (tylko DRAFT)',
      body: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          description: { type: 'string' },
          orderId: { type: ['string', 'null'] },
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['productId'],
              properties: {
                productId: { type: 'string' },
                quantity: { type: 'number', exclusiveMinimum: 0 },
                barcodeId: { type: 'string' },
                scannedEan: { type: 'string' },
                baseQuantity: { type: 'number', exclusiveMinimum: 0 },
                quantityMultiplier: { type: 'number', exclusiveMinimum: 0 },
                unitPrice: { type: 'number', minimum: 0 },
                notes: { type: 'string' },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: warehouseService.UpdateDocumentInput }>, reply: FastifyReply) => {
    try {
      const doc = await warehouseService.updateDocument(request.params.id, request.body);
      return reply.send(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji dokumentu';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // POST /admin/warehouse/documents/:id/confirm
  fastify.post('/documents/:id/confirm', {
    schema: { tags: ['warehouse'], summary: 'Zatwierdź dokument (DRAFT → CONFIRMED)' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const doc = await warehouseService.confirmDocument(request.params.id);
      return reply.send(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd zatwierdzania dokumentu';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // POST /admin/warehouse/documents/:id/cancel
  fastify.post('/documents/:id/cancel', {
    schema: {
      tags: ['warehouse'],
      summary: 'Anuluj dokument',
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: warehouseService.CancelDocumentInput }>, reply: FastifyReply) => {
    try {
      const doc = await warehouseService.cancelDocument(request.params.id, request.body ?? {});
      return reply.send(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd anulowania dokumentu';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // DELETE /admin/warehouse/documents/:id
  fastify.delete('/documents/:id', {
    schema: { tags: ['warehouse'], summary: 'Usuń dokument (tylko DRAFT)' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      await warehouseService.deleteDocument(request.params.id);
      return reply.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania dokumentu';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // ─── Stock ────────────────────────────────────────────────────────────────

  // GET /admin/warehouse/stock
  fastify.get('/stock', {
    schema: { tags: ['warehouse'], summary: 'Aktualny stan magazynowy wszystkich produktów' },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const stock = await getStock();
      return reply.send(stock);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Błąd pobierania stanów' });
    }
  });

  fastify.post('/recalculate-stock', {
    schema: { tags: ['warehouse'], summary: 'Przelicz cache currentStock z dokumentów CONFIRMED' },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = await recalculateStockCache();
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd przeliczania stanów';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });
}
