import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as warehouseProductService from '../../../services/admin/warehouse-products.service';
import * as barcodeService from '../../../services/admin/warehouse-barcodes.service';
import * as diagnosticsService from '../../../services/admin/warehouse-diagnostics.service';
import * as sourceMappingService from '../../../services/admin/warehouse-product-source-mapping.service';
import * as reservationService from '../../../services/admin/warehouse-reservations.service';
import * as priceSyncService from '../../../services/price/price-sync.service';
import * as stockSyncService from '../../../services/stock/stock-sync.service';
import * as shopProductPublicationService from '../../../services/admin/shop-product-publication.service';
import * as pricingService from '../../../services/admin/warehouse-pricing.service';
import { pricingProductsBodySchema } from './pricing.routes';
import { getProductStock } from '../../../services/admin/warehouse-stock.service';

export async function registerWarehouseProductRoutes(fastify: FastifyInstance) {
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
          shopId: { type: 'string' },
          isActive: { type: 'boolean' },
          stockStatus: { type: 'string', enum: ['available', 'zero', 'negative', 'low'] },
          wholesaleStockStatus: { type: 'string', enum: ['available', 'unavailable', 'missingOffer'] },
          missingPrice: { type: 'string', enum: ['purchase', 'retail'] },
          stockBelow: { type: 'number' },
          hasBarcode: { type: 'boolean' },
          hasShopMapping: { type: 'boolean' },
          hasWholesaleOffer: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: warehouseProductService.ProductsQuery }>, reply: FastifyReply) => {
    try {
      const result = await warehouseProductService.getProducts(request.query);
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
          leadTimeGroupId: { type: ['string', 'null'] },
          sku: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          unit: { type: 'string', default: 'szt' },
          description: { type: 'string' },
          purchasePrice: { type: 'number', minimum: 0 },
          retailPrice: { type: 'number', minimum: 0 },
          leadTimeDaysOverride: { type: ['integer', 'null'], minimum: 0, maximum: 365 },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: warehouseProductService.CreateProductInput }>, reply: FastifyReply) => {
    try {
      const product = await warehouseProductService.createProduct(request.body);
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
          leadTimeGroupId: { type: ['string', 'null'] },
          leadTimeDaysOverride: { type: ['integer', 'null'], minimum: 0, maximum: 365 },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: warehouseProductService.BulkUpdateProductsInput }>, reply: FastifyReply) => {
    try {
      const result = await warehouseProductService.bulkUpdateProducts(request.body);
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
  }, async (request: FastifyRequest<{ Body: warehouseProductService.BulkDeleteProductsInput }>, reply: FastifyReply) => {
    try {
      const result = await warehouseProductService.bulkDeleteProducts(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd masowego usuwania produktów';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/products/bulk/update-prices', {
    schema: {
      tags: ['warehouse-pricing'],
      summary: 'Masowo ustaw reguły cenowe produktów i przelicz ceny',
      body: {
        ...pricingProductsBodySchema(),
        required: ['productIds'],
        properties: {
          ...pricingProductsBodySchema().properties,
          marginPercent: { type: ['number', 'null'], minimum: 0 },
          minProfit: { type: ['number', 'null'], minimum: 0 },
          fixedNetPrice: { type: ['number', 'null'], minimum: 0 },
          vatRate: { type: ['number', 'null'], minimum: 0 },
          roundingMode: { type: 'string', enum: ['END_99', 'TENTH', 'CENT'] },
          syncMode: { type: 'string', enum: ['AUTO', 'CONFIRM', 'MANUAL'] },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: pricingService.BulkUpdatePricesInput }>, reply: FastifyReply) => {
    try {
      const result = await pricingService.bulkUpdateProductPrices(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd masowej aktualizacji cen';
      return reply.status(400).send({ error: 'Error', message });
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

  fastify.post('/products/bulk/fill-ean-from-mappings', {
    schema: {
      tags: ['warehouse'],
      summary: 'Uzupełnij EAN produktów ze zmapowanych ofert sklepowych',
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
          shopId: { type: 'string', description: 'Opcjonalnie: ogranicz do EAN-ów z konkretnego sklepu' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (request: FastifyRequest<{ Body: { productIds: string[]; shopId?: string } }>, reply: FastifyReply) => {
    try {
      const result = await barcodeService.bulkFillEanFromShopMappings(request.body.productIds, request.body.shopId);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd uzupełniania EAN';
      return reply.status(400).send({ error: 'Error', message });
    }
  });

  fastify.post('/products/bulk/remove-from-shop', {
    schema: {
      tags: ['warehouse-shop-products'],
      summary: 'Usuń lub dezaktywuj produkty w sklepie i lokalne mapowania',
      body: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
          productIds: { type: 'array', maxItems: 500, items: { type: 'string' } },
          mappingIds: { type: 'array', maxItems: 500, items: { type: 'string' } },
          remoteAction: { type: 'string', enum: ['DELETE', 'DEACTIVATE'], default: 'DELETE' },
          deactivateLocalProduct: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: shopProductPublicationService.RemoveShopProductsInput }>, reply: FastifyReply) => {
    try {
      const result = await shopProductPublicationService.removeShopProducts(request.body ?? {});
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania produktów sklepowych';
      return reply.status(400).send({ error: 'Error', message });
    }
  });

  fastify.post('/products/bulk/sync-stock', {
    schema: {
      tags: ['stock-sync'],
      summary: 'Ręcznie wyślij stany zaznaczonych produktów do aktywnych sklepów',
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
      response: {
        202: {
          type: 'object',
          properties: {
            enqueued: { type: 'integer' },
            batchJobs: { type: 'integer' },
            scannedMappings: { type: 'integer' },
            affectedProducts: { type: 'integer' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: { productIds: string[] } }>, reply: FastifyReply) => {
    try {
      const result = await stockSyncService.syncStockForProducts(request.body.productIds, 'MANUAL');
      return reply.status(202).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd ręcznej synchronizacji stanów';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/products/shop-products/bulk-preview', {
    schema: {
      tags: ['warehouse-shop-products'],
      summary: 'Podejrzyj masowe tworzenie szkiców produktów w sklepie',
      body: {
        type: 'object',
        required: ['shopId'],
        properties: {
          shopId: { type: 'string' },
          categoryId: { type: ['string', 'null'] },
          imageLimit: { type: ['integer', 'null'], minimum: 0, maximum: 20, default: 10 },
          productIds: {
            type: 'array',
            maxItems: 50,
            items: { type: 'string' },
          },
          items: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              required: ['warehouseProductId'],
              properties: {
                warehouseProductId: { type: 'string' },
                price: { type: ['number', 'null'], minimum: 0 },
                sourceWholesaleMappingId: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: shopProductPublicationService.BulkShopProductPublicationPreviewInput }>, reply: FastifyReply) => {
    try {
      const result = await shopProductPublicationService.previewBulkShopProductPublication(request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd podglądu tworzenia produktów sklepowych';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/products/shop-products/bulk', {
    schema: {
      tags: ['warehouse-shop-products'],
      summary: 'Masowo utwórz nieaktywne szkice produktów w sklepie',
      body: {
        type: 'object',
        required: ['shopId', 'categoryId', 'items'],
        properties: {
          shopId: { type: 'string' },
          categoryId: { type: 'string', minLength: 1 },
          imageLimit: { type: ['integer', 'null'], minimum: 0, maximum: 20, default: 10 },
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 50,
            items: {
              type: 'object',
              required: ['warehouseProductId', 'price'],
              properties: {
                warehouseProductId: { type: 'string' },
                price: { type: 'number', minimum: 0 },
                sourceWholesaleMappingId: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: shopProductPublicationService.BulkShopProductPublicationInput }>, reply: FastifyReply) => {
    try {
      const result = await shopProductPublicationService.createBulkShopProductsFromWarehouseProducts(request.body);
      return reply.status(201).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd masowego tworzenia produktów sklepowych';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/shops/:shopId/sync-stock', {
    schema: {
      tags: ['stock-sync'],
      summary: 'Ręcznie wyślij stany wszystkich zmapowanych produktów wskazanego sklepu',
      params: {
        type: 'object',
        required: ['shopId'],
        properties: { shopId: { type: 'string' } },
      },
      response: {
        202: {
          type: 'object',
          properties: {
            enqueued: { type: 'integer' },
            batchJobs: { type: 'integer' },
            scannedMappings: { type: 'integer' },
            affectedProducts: { type: 'integer' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { shopId: string } }>, reply: FastifyReply) => {
    try {
      const result = await stockSyncService.syncStockForShop(request.params.shopId, 'MANUAL');
      return reply.status(202).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd ręcznej synchronizacji sklepu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  // GET /admin/warehouse/products/:id
  fastify.get('/products/:id', {
    schema: { tags: ['warehouse'], summary: 'Szczegóły produktu' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const product = await warehouseProductService.getProductById(request.params.id);
      if (!product) return reply.status(404).send({ error: 'Not Found', message: 'Produkt nie znaleziony' });
      return reply.send(product);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Błąd pobierania produktu' });
    }
  });

  fastify.get('/products/:id/reservations', {
    schema: {
      tags: ['warehouse-reservations'],
      summary: 'Lista rezerwacji produktu magazynowego',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          status: { type: 'string', enum: ['ACTIVE', 'CONSUMED', 'RELEASED', 'CANCELLED'] },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Querystring: reservationService.ReservationsQuery;
  }>, reply: FastifyReply) => {
    try {
      const result = await reservationService.getProductReservations(request.params.id, request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania rezerwacji produktu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.get('/products/:id/barcodes', {
    schema: { tags: ['warehouse'], summary: 'Lista kodów EAN produktu' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const product = await warehouseProductService.getProductById(request.params.id);
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
          leadTimeGroupId: { type: ['string', 'null'] },
          name: { type: 'string', minLength: 1 },
          unit: { type: 'string' },
          description: { type: 'string' },
          purchasePrice: { type: ['number', 'null'], minimum: 0 },
          retailPrice: { type: ['number', 'null'], minimum: 0 },
          leadTimeDaysOverride: { type: ['integer', 'null'], minimum: 0, maximum: 365 },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string }; Body: warehouseProductService.UpdateProductInput }>, reply: FastifyReply) => {
    try {
      const product = await warehouseProductService.updateProduct(request.params.id, request.body);
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
    Body: Pick<warehouseProductService.UpdateProductInput, 'purchasePrice' | 'retailPrice'>;
  }>, reply: FastifyReply) => {
    try {
      const product = await warehouseProductService.updateProduct(request.params.id, request.body);
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
          price: { type: 'number', minimum: 0 },
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

  fastify.post('/products/:id/sync-stock', {
    schema: {
      tags: ['stock-sync'],
      summary: 'Ręcznie wyślij stan produktu do aktywnych sklepów',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        202: {
          type: 'object',
          properties: {
            enqueued: { type: 'integer' },
            batchJobs: { type: 'integer' },
            scannedMappings: { type: 'integer' },
            affectedProducts: { type: 'integer' },
          },
        },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const result = await stockSyncService.syncStockToAllShops(request.params.id, 'MANUAL');
      return reply.status(202).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd synchronizacji stanu';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/products/:id/shop-products/preview', {
    schema: {
      tags: ['warehouse-shop-products'],
      summary: 'Podejrzyj utworzenie szkicu produktu sklepowego z produktu magazynowego',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['shopId'],
        properties: {
          shopId: { type: 'string' },
          categoryId: { type: ['string', 'null'] },
          price: { type: ['number', 'null'], minimum: 0 },
          sourceWholesaleMappingId: { type: ['string', 'null'] },
          imageLimit: { type: ['integer', 'null'], minimum: 0, maximum: 20, default: 10 },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: shopProductPublicationService.ShopProductPublicationInput;
  }>, reply: FastifyReply) => {
    try {
      const result = await shopProductPublicationService.previewShopProductPublication(request.params.id, request.body);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd podglądu tworzenia produktu sklepowego';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/products/:id/shop-products', {
    schema: {
      tags: ['warehouse-shop-products'],
      summary: 'Utwórz nieaktywny szkic produktu sklepowego z produktu magazynowego',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['shopId', 'categoryId', 'price'],
        properties: {
          shopId: { type: 'string' },
          categoryId: { type: 'string', minLength: 1 },
          price: { type: 'number', minimum: 0 },
          sourceWholesaleMappingId: { type: ['string', 'null'] },
          imageLimit: { type: ['integer', 'null'], minimum: 0, maximum: 20, default: 10 },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: shopProductPublicationService.ShopProductPublicationInput & { categoryId: string };
  }>, reply: FastifyReply) => {
    try {
      const result = await shopProductPublicationService.createShopProductFromWarehouseProduct(request.params.id, request.body);
      const status = result.status === 'CREATED' ? 201 : result.status === 'SKIPPED' ? 409 : 400;
      return reply.status(status).send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia produktu sklepowego';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.delete('/products/:id/shop-products', {
    schema: {
      tags: ['warehouse-shop-products'],
      summary: 'Usuń lub dezaktywuj produkt w sklepie',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          shopId: { type: 'string' },
          remoteAction: { type: 'string', enum: ['DELETE', 'DEACTIVATE'], default: 'DELETE' },
          deactivateLocalProduct: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: Omit<shopProductPublicationService.RemoveShopProductsInput, 'productIds'>;
  }>, reply: FastifyReply) => {
    try {
      const result = await shopProductPublicationService.removeShopProducts({
        ...request.body,
        productIds: [request.params.id],
      });
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania produktu sklepowego';
      return reply.status(400).send({ error: 'Error', message });
    }
  });

  // DELETE /admin/warehouse/products/:id
  fastify.delete('/products/:id', {
    schema: { tags: ['warehouse'], summary: 'Usuń produkt magazynowy' },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      await warehouseProductService.deleteProduct(request.params.id);
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

  fastify.get('/products/:id/inventory-snapshot', {
    schema: {
      tags: ['warehouse'],
      summary: 'Snapshot stanu produktu z aktywnymi rezerwacjami (na potrzeby dokumentu INW)',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      const snapshot = await warehouseProductService.getInventorySnapshot(request.params.id);
      if (!snapshot) return reply.status(404).send({ error: 'Not Found', message: 'Produkt nie znaleziony' });
      return reply.send(snapshot);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: 'Internal Server Error', message: 'Błąd pobierania snapshotu inwentaryzacji' });
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
}
