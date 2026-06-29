import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../lib/prisma';
import {
  createManualOrder,
  deleteOrder,
  getOrderCounts,
  getOrdersList,
} from '../../services/admin/orders.service';
import * as reservationService from '../../services/admin/warehouse-reservations.service';
import { createWzForOrder } from '../../services/admin/warehouse-documents.service';
import * as invoicesService from '../../services/admin/invoices.service';
import * as orderShipmentsService from '../../services/admin/order-shipments.service';
import * as orderReturnsService from '../../services/admin/order-returns.service';
import * as shopOrderStatusesService from '../../services/admin/shop-order-statuses.service';
import { extractOrderShippingInfo } from '../../services/orders/order-shipping-info.service';
import {
  createManualOrderSchema,
  orderCancellationActionSchema,
  ordersCountsQuerySchema,
  ordersListQuerySchema,
  orderReturnActionSchema,
  updateOrderStatusSchema,
  type CreateManualOrderInput,
  type OrdersCountsQueryInput,
  type OrdersListQueryInput,
} from '../../schemas/admin.schema';

interface OrderParams {
  id: string;
}

const looseObjectResponse = {
  type: 'object',
  additionalProperties: true,
} as const;

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function snapshotImageUrl(payload: unknown) {
  const root = toRecord(payload);
  const media = toRecord(root.media);
  const images = Array.isArray(media.images) ? media.images : [];
  const cover = images.find((item) => {
    const image = toRecord(item);
    return (image.isCover === true || image.cover === true) && stringValue(image.url);
  }) ?? images[0];
  const image = toRecord(cover);
  return stringValue(image.url ?? image.src ?? image.thumbnailUrl ?? image.mediumUrl);
}

type ProductSnapshotForImage = {
  shopId: string;
  payloadJson: unknown;
};

type WarehouseProductForOrder = {
  productChannelSnapshots?: ProductSnapshotForImage[];
  imageUrl?: string | null;
};

function productImageUrl(product: WarehouseProductForOrder, shopId?: string | null) {
  if (product.imageUrl) return product.imageUrl;
  const snapshots = product.productChannelSnapshots ?? [];
  const snapshot = shopId
    ? snapshots.find((item) => item.shopId === shopId) ?? snapshots[0]
    : snapshots[0];
  return snapshot ? snapshotImageUrl(snapshot.payloadJson) : null;
}

function withOrderComputedFields<T extends { payloadJson: unknown; currency?: string; shopId?: string; items?: unknown }>(order: T) {
  const items = Array.isArray(order.items)
    ? order.items.map((item) => {
      const itemRecord = toRecord(item);
      const warehouseProduct = toRecord(itemRecord.warehouseProduct);
      if (!warehouseProduct.id) return item;
      const { productChannelSnapshots: _snapshots, ...productWithoutSnapshots } = warehouseProduct;
      return {
        ...itemRecord,
        warehouseProduct: {
          ...productWithoutSnapshots,
          imageUrl: productImageUrl(warehouseProduct as WarehouseProductForOrder, order.shopId),
        },
      };
    })
    : order.items;

  return {
    ...order,
    ...(Array.isArray(order.items) ? { items } : {}),
    shippingInfo: extractOrderShippingInfo(order.payloadJson, order.currency),
  };
}

export async function ordersRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: OrdersListQueryInput }>(
    '/list',
    {
      schema: {
        tags: ['orders'],
        summary: 'Lekka lista zamówień z paginacją i filtrami',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            q: { type: 'string' },
            statusGroup: { type: 'string', enum: ['active', 'cancelled', 'returned', 'all', ''] },
            operationalStatus: { type: 'string' },
            shopId: { type: 'string' },
            payment: { type: 'string', enum: ['all', 'paid', 'unpaid', ''], default: 'all' },
            invoice: { type: 'string', enum: ['all', 'issued', 'missing', ''], default: 'all' },
            personalization: { type: 'string', enum: ['all', 'required', 'waiting', 'ready', ''], default: 'all' },
            datePreset: { type: 'string', enum: ['all', '7d', '30d', '90d', ''], default: 'all' },
            dateFrom: { type: 'string' },
            dateTo: { type: 'string' },
            shipBy: { type: 'string', enum: ['overdue', 'today', 'tomorrow', 'future', 'shipped', ''] },
            sortBy: { type: 'string', enum: ['createdAtShop', 'totalPaid', 'maxShippingDate', 'orderReference'], default: 'createdAtShop' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          },
        },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = ordersListQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
          details: parsed.error.errors,
        });
      }

      try {
        const result = await getOrdersList(parsed.data);
        return reply.send(result);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać listy zamówień',
        });
      }
    },
  );

  fastify.get<{ Querystring: OrdersCountsQueryInput }>(
    '/counts',
    {
      schema: {
        tags: ['orders'],
        summary: 'Liczniki statusów zamówień',
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            shopId: { type: 'string' },
            payment: { type: 'string', enum: ['all', 'paid', 'unpaid', ''], default: 'all' },
            invoice: { type: 'string', enum: ['all', 'issued', 'missing', ''], default: 'all' },
            personalization: { type: 'string', enum: ['all', 'required', 'waiting', 'ready', ''], default: 'all' },
            datePreset: { type: 'string', enum: ['all', '7d', '30d', '90d', ''], default: 'all' },
            dateFrom: { type: 'string' },
            dateTo: { type: 'string' },
            shipBy: { type: 'string', enum: ['overdue', 'today', 'tomorrow', 'future', 'shipped', ''] },
            sortBy: { type: 'string', enum: ['createdAtShop', 'totalPaid', 'maxShippingDate', 'orderReference'], default: 'createdAtShop' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
            scope: { type: 'string', enum: ['sidebar', 'list', ''], default: 'sidebar' },
          },
        },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = ordersCountsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
          details: parsed.error.errors,
        });
      }

      try {
        const result = await getOrderCounts(parsed.data);
        return reply.send(result);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać liczników zamówień',
        });
      }
    },
  );

  // GET /admin/orders - List all orders
  fastify.get('/', {
    schema: {
      tags: ['orders'],
      summary: 'Lista zamówień z pozycjami',
      response: { 200: { type: 'array', items: looseObjectResponse } },
    },
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const orders = await prisma.order.findMany({
        include: {
          shop: {
            select: {
              id: true,
              name: true,
              platform: true,
            },
          },
          items: {
            include: {
              personalizedProduct: {
                select: {
                  id: true,
                  name: true,
                  identifierType: true,
                  identifierValue: true,
                },
              },
              personalizationCase: {
                select: {
                  id: true,
                  status: true,
                  customerTokenHash: true,
                  tokenActive: true,
                  submittedAt: true,
                  notesInternal: true,
                  createdAt: true,
                  updatedAt: true,
                },
              },
              warehouseProduct: {
                select: {
                  id: true,
                  sku: true,
                  name: true,
                  unit: true,
                  currentStock: true,
                },
              },
            },
          },
          salesDocuments: {
            where: { documentType: 'INVOICE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      return reply.send(orders.map(withOrderComputedFields));
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Nie udało się pobrać zamówień',
      });
    }
  });

  // GET /admin/orders/:id - Get order details
  fastify.get<{ Params: OrderParams }>(
    '/:id',
    {
      schema: {
        tags: ['orders'],
        summary: 'Szczegóły zamówienia',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: looseObjectResponse,
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: OrderParams }>, reply: FastifyReply) => {
      try {
        const order = await prisma.order.findUnique({
          where: { id: request.params.id },
          include: {
            shop: {
              select: {
                id: true,
                name: true,
                platform: true,
                baseUrl: true,
              },
            },
            items: {
              include: {
                personalizedProduct: {
                  include: {
                    template: {
                      select: {
                        id: true,
                        code: true,
                        name: true,
                        version: true,
                      },
                    },
                  },
                },
                personalizationCase: {
                  select: {
                    id: true,
                    status: true,
                    customerTokenHash: true,
                    tokenActive: true,
                    submittedAt: true,
                    notesInternal: true,
                    createdAt: true,
                    updatedAt: true,
                  },
                },
                warehouseProduct: {
                  select: {
                    id: true,
                    sku: true,
                    name: true,
                    unit: true,
                    currentStock: true,
                    productChannelSnapshots: {
                      select: {
                        shopId: true,
                        payloadJson: true,
                      },
                      orderBy: { fetchedAt: 'desc' },
                      take: 5,
                    },
                    wholesaleMappings: {
                      where: {
                        isActive: true,
                        provider: { isActive: true },
                      },
                      select: {
                        id: true,
                        providerId: true,
                        externalSku: true,
                        externalEan: true,
                        externalName: true,
                        lastKnownPrice: true,
                        lastKnownStock: true,
                        payloadJson: true,
                        isActive: true,
                        lastSyncAt: true,
                        updatedAt: true,
                        provider: {
                          select: {
                            id: true,
                            name: true,
                            configJson: true,
                          },
                        },
                      },
                      orderBy: [{ lastSyncAt: 'desc' }, { updatedAt: 'desc' }],
                      take: 10,
                    },
                  },
                },
              },
          },
          salesDocuments: {
            orderBy: { createdAt: 'desc' },
            include: { emailLogs: { orderBy: { createdAt: 'desc' }, take: 10 } },
          },
          warehouseDocuments: true,
        },
      });

        if (!order) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Zamówienie nie zostało znalezione',
          });
        }

        return reply.send(withOrderComputedFields(order));
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać zamówienia',
        });
      }
    }
  );

  fastify.get<{ Params: OrderParams }>(
    '/:id/invoice',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Status faktury dla zamówienia',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await invoicesService.getOrderInvoice(request.params.id);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: OrderParams; Body: { saveAsDraft?: boolean } }>(
    '/:id/invoice/preview',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Walidacja i podgląd payloadu faktury iFirma',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await invoicesService.previewOrderInvoice(request.params.id);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: OrderParams; Body: { saveAsDraft?: boolean } }>(
    '/:id/invoice/issue',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Ręcznie wystaw fakturę iFirma dla zamówienia',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await invoicesService.issueOrderInvoice(request.params.id);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: OrderParams }>(
    '/:id/invoice/send-email',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Wyślij fakturę e-mailem przez SMTP KP Admin',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await invoicesService.sendOrderInvoiceEmail(request.params.id);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: OrderParams }>(
    '/:id/invoice/cancel',
    {
      schema: {
        tags: ['ifirma'],
        summary: 'Anuluj lokalną fakturę dla zamówienia bez zmiany w iFirma',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const result = await invoicesService.cancelOrderInvoice(request.params.id);
      return reply.send(result);
    },
  );

  fastify.get<{ Params: OrderParams }>(
    '/:id/shipment',
    {
      schema: {
        tags: ['orders'],
        summary: 'Status przesyłki InPost dla zamówienia przez PrestaShop connector',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      try {
        const result = await orderShipmentsService.getOrderShipment(request.params.id);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się pobrać statusu przesyłki';
        return reply.status(400).send({ error: 'Shipment Error', message });
      }
    },
  );

  fastify.post<{ Params: OrderParams; Body: unknown }>(
    '/:id/shipment',
    {
      schema: {
        tags: ['orders'],
        summary: 'Utwórz przesyłkę InPost dla zamówienia przez PrestaShop connector',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? request.body as orderShipmentsService.CreateOrderShipmentInput
          : {};
        const result = await orderShipmentsService.createOrderShipment(request.params.id, body);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się utworzyć przesyłki';
        return reply.status(400).send({ error: 'Shipment Error', message });
      }
    },
  );

  fastify.get<{ Params: OrderParams; Querystring: orderShipmentsService.OrderShipmentLabelQuery }>(
    '/:id/shipment/label',
    {
      schema: {
        tags: ['orders'],
        summary: 'Pobierz etykietę InPost PDF dla zamówienia',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request, reply) => {
      try {
        const file = await orderShipmentsService.downloadOrderShipmentLabel(request.params.id, request.query);
        reply.header('Content-Type', file.contentType);
        reply.header('Content-Disposition', `inline; filename="${file.filename.replace(/"/g, '')}"`);
        return reply.send(file.buffer);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się pobrać etykiety';
        return reply.status(400).send({ error: 'Shipment Error', message });
      }
    },
  );

  fastify.post<{ Params: OrderParams; Body: unknown }>(
    '/:id/shipment/refresh',
    {
      schema: {
        tags: ['orders'],
        summary: 'Odśwież status przesyłki InPost przez PrestaShop connector',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
          ? request.body as orderShipmentsService.RefreshOrderShipmentInput
          : {};
        const result = await orderShipmentsService.refreshOrderShipment(request.params.id, body);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Nie udało się odświeżyć statusu przesyłki';
        return reply.status(400).send({ error: 'Shipment Error', message });
      }
    },
  );

  fastify.patch<{ Params: OrderParams; Body: unknown }>(
    '/:id/status',
    {
      schema: {
        tags: ['orders'],
        summary: 'Zmień lokalny status zamówienia i opcjonalnie status PrestaShop',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = updateOrderStatusSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: parsed.error.errors[0].message,
          details: parsed.error.errors,
        });
      }
      const result = await shopOrderStatusesService.updateOrderStatus(request.params.id, parsed.data);
      return reply.send(result);
    },
  );

  fastify.get<{ Params: OrderParams }>(
    '/:id/returns',
    {
      schema: {
        tags: ['orders'],
        summary: 'Lista anulowań i zwrotów zamówienia',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: { type: 'array', items: looseObjectResponse } },
      },
    },
    async (request, reply) => {
      const result = await orderReturnsService.listOrderReturns(request.params.id);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: OrderParams; Body: unknown }>(
    '/:id/cancel/preview',
    {
      schema: {
        tags: ['orders'],
        summary: 'Podgląd dokumentowego anulowania zamówienia',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = orderCancellationActionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: parsed.error.errors[0].message, details: parsed.error.errors });
      }
      const result = await orderReturnsService.previewOrderCancellation(request.params.id, parsed.data);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: OrderParams; Body: unknown }>(
    '/:id/cancel',
    {
      schema: {
        tags: ['orders'],
        summary: 'Anuluj zamówienie z dokumentami magazynu, iFirma i PrestaShop',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = orderCancellationActionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: parsed.error.errors[0].message, details: parsed.error.errors });
      }
      const result = await orderReturnsService.cancelOrder(request.params.id, parsed.data);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: OrderParams; Body: unknown }>(
    '/:id/returns/preview',
    {
      schema: {
        tags: ['orders'],
        summary: 'Podgląd zwrotu zamówienia',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = orderReturnActionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: parsed.error.errors[0].message, details: parsed.error.errors });
      }
      const result = await orderReturnsService.previewOrderReturn(request.params.id, parsed.data);
      return reply.send(result);
    },
  );

  fastify.post<{ Params: OrderParams; Body: unknown }>(
    '/:id/returns',
    {
      schema: {
        tags: ['orders'],
        summary: 'Utwórz zwrot zamówienia z dokumentami magazynu, iFirma i PrestaShop',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: { type: 'object', additionalProperties: true },
        response: { 200: looseObjectResponse },
      },
    },
    async (request, reply) => {
      const parsed = orderReturnActionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Validation Error', message: parsed.error.errors[0].message, details: parsed.error.errors });
      }
      const result = await orderReturnsService.createOrderReturn(request.params.id, parsed.data);
      return reply.send(result);
    },
  );

  fastify.get<{ Params: OrderParams; Querystring: reservationService.ReservationsQuery }>(
    '/:id/reservations',
    {
      schema: {
        tags: ['warehouse-reservations'],
        summary: 'Lista rezerwacji zamówienia',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status: { type: 'string', enum: ['ACTIVE', 'CONSUMED', 'RELEASED', 'CANCELLED'] },
          },
        },
      },
    },
    async (request: FastifyRequest<{
      Params: OrderParams;
      Querystring: reservationService.ReservationsQuery;
    }>, reply: FastifyReply) => {
      try {
        const result = await reservationService.getOrderReservations(request.params.id, request.query);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd pobierania rezerwacji zamówienia';
        const status = message.includes('nie znalezion') ? 404 : 400;
        return reply.status(status).send({ error: 'Error', message });
      }
    }
  );

  fastify.post<{ Params: OrderParams }>(
    '/:id/reserve',
    {
      schema: {
        tags: ['warehouse-reservations'],
        summary: 'Utwórz lub uzupełnij rezerwacje magazynowe zamówienia',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request: FastifyRequest<{ Params: OrderParams }>, reply: FastifyReply) => {
      try {
        const result = await reservationService.reserveOrder(request.params.id);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd rezerwacji zamówienia';
        const status = message.includes('nie znalezion') ? 404 : 400;
        return reply.status(status).send({ error: 'Error', message });
      }
    }
  );

  fastify.post<{ Params: OrderParams }>(
    '/:id/release-reservations',
    {
      schema: {
        tags: ['warehouse-reservations'],
        summary: 'Zwolnij aktywne rezerwacje magazynowe zamówienia',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      },
    },
    async (request: FastifyRequest<{ Params: OrderParams }>, reply: FastifyReply) => {
      try {
        const result = await reservationService.releaseOrderReservations(request.params.id);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd zwalniania rezerwacji zamówienia';
        const status = message.includes('nie znalezion') ? 404 : 400;
        return reply.status(status).send({ error: 'Error', message });
      }
    }
  );

  fastify.post<{ Params: OrderParams; Body: { saveAsDraft?: boolean } }>(
    '/:id/wz',
    {
      schema: {
        tags: ['warehouse'],
        summary: 'Utwórz dokument WZ z aktywnych rezerwacji zamówienia',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            saveAsDraft: { type: 'boolean' },
          },
        },
        response: { 200: looseObjectResponse },
      },
    },
    async (request: FastifyRequest<{
      Params: OrderParams;
      Body: { saveAsDraft?: boolean };
    }>, reply: FastifyReply) => {
      try {
        const result = await createWzForOrder(request.params.id, {
          saveAsDraft: request.body?.saveAsDraft === true,
          forceConfirm: request.body?.saveAsDraft !== true,
        });
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd tworzenia WZ dla zamówienia';
        const status = message.includes('nie znalezion') ? 404 : 400;
        return reply.status(status).send({ error: 'Error', message });
      }
    }
  );

  // POST /admin/orders/manual - Create manual order
  fastify.post<{ Body: CreateManualOrderInput }>(
    '/manual',
    {
      schema: {
        tags: ['orders'],
        summary: 'Utwórz ręczne zamówienie testowe',
        body: {
          type: 'object',
          required: ['shopId', 'customerEmail', 'orderReference'],
          properties: {
            shopId: { type: 'string' },
            customerEmail: { type: 'string', format: 'email' },
            customerName: { type: 'string' },
            orderReference: { type: 'string' },
            items: { type: 'array', items: { type: 'object' } },
          },
        },
        response: {
          201: { type: 'object' },
          400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Body: CreateManualOrderInput }>, reply: FastifyReply) => {
      const bodyParsed = createManualOrderSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: bodyParsed.error.errors[0].message,
          details: bodyParsed.error.errors,
        });
      }

      try {
        const result = await createManualOrder(bodyParsed.data);
        return reply.status(201).send(result);
      } catch (error: any) {
        fastify.log.error(error);
        return reply.status(400).send({
          error: 'Create Failed',
          message: error.message || 'Nie udało się utworzyć zamówienia',
        });
      }
    }
  );

  // DELETE /admin/orders/:id - Delete order
  fastify.delete<{ Params: OrderParams }>(
    '/:id',
    {
      schema: {
        tags: ['orders'],
        summary: 'Usuń zamówienie',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: OrderParams }>, reply: FastifyReply) => {
      try {
        await deleteOrder(request.params.id);
        return reply.status(200).send({
          success: true,
          message: 'Zamówienie zostało usunięte',
        });
      } catch (error: any) {
        fastify.log.error(error);
        
        if (error.message === 'Zamówienie nie istnieje') {
          return reply.status(404).send({
            error: 'Not Found',
            message: error.message,
          });
        }
        
        return reply.status(500).send({
          error: 'Delete Failed',
          message: error.message || 'Nie udało się usunąć zamówienia',
        });
      }
    }
  );
}
