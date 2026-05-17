import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as warehouseService from '../../services/admin/warehouse.service';
import * as barcodeService from '../../services/admin/warehouse-barcodes.service';
import * as scannerService from '../../services/admin/warehouse-scanner.service';
import * as diagnosticsService from '../../services/admin/warehouse-diagnostics.service';
import * as sourceMappingService from '../../services/admin/warehouse-product-source-mapping.service';
import * as priceSyncService from '../../services/price/price-sync.service';
import * as prestaReconciliationService from '../../services/prestashop/prestashop-reconciliation.service';
import { getStock, getProductStock, recalculateStockCache } from '../../services/admin/warehouse-stock.service';

export async function warehouseRoutes(fastify: FastifyInstance) {
  fastify.get('/dashboard', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Dashboard problemów i kontroli magazynu',
      querystring: {
        type: 'object',
        properties: {
          lowStockThreshold: { type: 'number', default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          failedSinceDays: { type: 'integer', minimum: 1, maximum: 90, default: 7 },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: diagnosticsService.WarehouseDashboardQuery }>, reply: FastifyReply) => {
    try {
      const result = await diagnosticsService.getWarehouseDashboard(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania dashboardu magazynu';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

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
          catalogId: { type: 'string' },
          isActive: { type: 'boolean' },
          stockStatus: { type: 'string', enum: ['available', 'zero', 'negative', 'low'] },
          missingPrice: { type: 'string', enum: ['purchase', 'retail'] },
          stockBelow: { type: 'number' },
          hasBarcode: { type: 'boolean' },
          hasShopMapping: { type: 'boolean' },
          hasWholesaleOffer: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: warehouseService.ProductsQuery }>, reply: FastifyReply) => {
    try {
      const result = await warehouseService.getProducts(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Nie udało się pobrać produktów';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      fastify.log.error(error);
      return reply.status(status).send({ error: 'Error', message });
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
          catalogId: { type: ['string', 'null'] },
          sku: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          unit: { type: 'string', default: 'szt' },
          description: { type: 'string' },
          purchasePrice: { type: 'number', minimum: 0 },
          retailPrice: { type: 'number', minimum: 0 },
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

  fastify.post('/products/bulk/update', {
    schema: {
      tags: ['warehouse'],
      summary: 'Masowo zaktualizuj produkty magazynowe',
      body: {
        type: 'object',
        required: ['productIds'],
        properties: {
          productIds: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: { type: 'string' },
          },
          isActive: { type: 'boolean' },
          catalogId: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: warehouseService.BulkUpdateProductsInput }>, reply: FastifyReply) => {
    try {
      const result = await warehouseService.bulkUpdateProducts(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd masowej aktualizacji produktów';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/products/bulk/delete', {
    schema: {
      tags: ['warehouse'],
      summary: 'Masowo usuń produkty magazynowe',
      body: {
        type: 'object',
        required: ['productIds'],
        properties: {
          productIds: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: { type: 'string' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: warehouseService.BulkDeleteProductsInput }>, reply: FastifyReply) => {
    try {
      const result = await warehouseService.bulkDeleteProducts(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd masowego usuwania produktów';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/products/bulk/auto-map-sources', {
    schema: {
      tags: ['warehouse'],
      summary: 'Masowo powiąż produkty magazynowe z mapowaniami sklepu i hurtowni',
      body: {
        type: 'object',
        required: ['productIds'],
        properties: {
          productIds: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: { type: 'string' },
          },
          sources: {
            type: 'array',
            items: { type: 'string', enum: ['SHOP', 'WHOLESALE'] },
          },
          activeOnly: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: sourceMappingService.BulkAutoMapProductSourcesInput }>, reply: FastifyReply) => {
    try {
      const result = await sourceMappingService.bulkAutoMapProductSources(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd masowego mapowania produktów';
      const status = message.includes('Brak kontekstu') ? 400 : 400;
      return reply.status(status).send({ error: 'Error', message });
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
          catalogId: { type: ['string', 'null'] },
          name: { type: 'string', minLength: 1 },
          unit: { type: 'string' },
          description: { type: 'string' },
          purchasePrice: { type: ['number', 'null'], minimum: 0 },
          retailPrice: { type: ['number', 'null'], minimum: 0 },
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

  fastify.put('/products/:id/prices', {
    schema: {
      tags: ['warehouse'],
      summary: 'Zaktualizuj ceny produktu magazynowego',
      body: {
        type: 'object',
        properties: {
          purchasePrice: { type: ['number', 'null'], minimum: 0 },
          retailPrice: { type: ['number', 'null'], minimum: 0 },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: Pick<warehouseService.UpdateProductInput, 'purchasePrice' | 'retailPrice'>;
  }>, reply: FastifyReply) => {
    try {
      const product = await warehouseService.updateProduct(request.params.id, request.body);
      return reply.send(product);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd aktualizacji cen';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/products/:id/sync-price', {
    schema: {
      tags: ['price-sync'],
      summary: 'Wyślij cenę sprzedaży produktu do aktywnych sklepów',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
        },
      },
      response: {
        202: {
          type: 'object',
          properties: {
            enqueued: { type: 'integer' },
            logs: { type: 'array', items: { type: 'object' } },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: Pick<priceSyncService.SyncProductPriceOptions, 'shopId'>;
  }>, reply: FastifyReply) => {
    try {
      const result = await priceSyncService.syncProductPrice(request.params.id, request.body ?? {});
      return reply.status(202).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd synchronizacji ceny';
      const status = message.includes('nie znalezion') ? 404 : 400;
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

  fastify.get('/products/:id/movements', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Historia ruchów magazynowych produktu',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          status: { type: 'string', enum: ['DRAFT', 'CONFIRMED', 'CANCELLED'] },
          type: { type: 'string', enum: ['PZ', 'PW', 'WZ', 'RW'] },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Querystring: diagnosticsService.ProductMovementsQuery;
  }>, reply: FastifyReply) => {
    try {
      const result = await diagnosticsService.getProductMovements(request.params.id, request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania ruchów produktu';
      const status = message.includes('nie znaleziony') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
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

  fastify.post('/documents/:id/items/merge', {
    schema: {
      tags: ['warehouse'],
      summary: 'Dodaj albo zwiększ pozycję dokumentu DRAFT',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
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
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: warehouseService.DocumentItemInput;
  }>, reply: FastifyReply) => {
    try {
      const doc = await warehouseService.mergeDocumentItem(request.params.id, request.body);
      return reply.send(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd dodawania pozycji dokumentu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.patch('/documents/:id/items/:itemId', {
    schema: {
      tags: ['warehouse'],
      summary: 'Edytuj pozycję dokumentu DRAFT',
      params: {
        type: 'object',
        required: ['id', 'itemId'],
        properties: {
          id: { type: 'string' },
          itemId: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          quantity: { type: 'number', exclusiveMinimum: 0 },
          baseQuantity: { type: ['number', 'null'], exclusiveMinimum: 0 },
          quantityMultiplier: { type: ['number', 'null'], exclusiveMinimum: 0 },
          unitPrice: { type: ['number', 'null'], minimum: 0 },
          notes: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string; itemId: string };
    Body: warehouseService.UpdateDocumentItemInput;
  }>, reply: FastifyReply) => {
    try {
      const doc = await warehouseService.updateDocumentItem(request.params.id, request.params.itemId, request.body);
      return reply.send(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji pozycji dokumentu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.delete('/documents/:id/items/:itemId', {
    schema: {
      tags: ['warehouse'],
      summary: 'Usuń pozycję dokumentu DRAFT',
      params: {
        type: 'object',
        required: ['id', 'itemId'],
        properties: {
          id: { type: 'string' },
          itemId: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string; itemId: string } }>, reply: FastifyReply) => {
    try {
      const doc = await warehouseService.deleteDocumentItem(request.params.id, request.params.itemId);
      return reply.send(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania pozycji dokumentu';
      const status = message.includes('nie znalezion') ? 404 : 400;
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

  fastify.get('/stock/discrepancies', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Rozbieżności currentStock względem dokumentów CONFIRMED',
      querystring: {
        type: 'object',
        properties: {
          includeZero: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: diagnosticsService.StockDiscrepanciesQuery }>, reply: FastifyReply) => {
    try {
      const result = await diagnosticsService.getStockDiscrepancies(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania rozbieżności stanów';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.get('/prestashop-reconciliation', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Porównaj ceny i stany magazynu z aktualnymi danymi w PrestaShop',
      querystring: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
          warehouseProductId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
          includeInSync: { type: 'boolean', default: false },
          priceTolerance: { type: 'number', minimum: 0, default: 0.01 },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Querystring: prestaReconciliationService.PrestaShopReconciliationQuery;
  }>, reply: FastifyReply) => {
    try {
      const result = await prestaReconciliationService.getPrestaShopReconciliation(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd reconciliation PrestaShop';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
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

  // ─── Stock sync diagnostics ───────────────────────────────────────────────

  fastify.get('/stock-sync-logs', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Logi synchronizacji stanów magazynowych do sklepów',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          shopId: { type: 'string' },
          warehouseProductId: { type: 'string' },
          status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'] },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: diagnosticsService.StockSyncLogsQuery }>, reply: FastifyReply) => {
    try {
      const result = await diagnosticsService.getStockSyncLogs(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania logów synchronizacji stanów';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/stock-sync-logs/:id/retry', {
    schema: {
      tags: ['warehouse-diagnostics'],
      summary: 'Ponów synchronizację stanu na podstawie logu',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const result = await diagnosticsService.retryStockSyncLog(request.params.id);
      return reply.status(201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd ponawiania synchronizacji stanu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // ─── Price sync diagnostics ───────────────────────────────────────────────

  fastify.get('/price-sync-logs', {
    schema: {
      tags: ['price-sync'],
      summary: 'Logi synchronizacji cen sprzedaży do sklepów',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          shopId: { type: 'string' },
          warehouseProductId: { type: 'string' },
          status: { type: 'string', enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'] },
          dateFrom: { type: 'string' },
          dateTo: { type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: priceSyncService.PriceSyncLogsQuery }>, reply: FastifyReply) => {
    try {
      const result = await priceSyncService.getPriceSyncLogs(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania logów synchronizacji cen';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/price-sync-logs/:id/retry', {
    schema: {
      tags: ['price-sync'],
      summary: 'Ponów synchronizację ceny na podstawie logu',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const result = await priceSyncService.retryPriceSyncLog(request.params.id);
      return reply.status(201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd ponawiania synchronizacji ceny';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });
}
