import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../lib/prisma';
import { createManualOrder, deleteOrder } from '../../services/admin/orders.service';
import * as reservationService from '../../services/admin/warehouse-reservations.service';
import { createManualOrderSchema, type CreateManualOrderInput } from '../../schemas/admin.schema';

interface OrderParams {
  id: string;
}

const looseObjectResponse = {
  type: 'object',
  additionalProperties: true,
} as const;

export async function ordersRoutes(fastify: FastifyInstance) {
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
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      return reply.send(orders);
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
                  },
                },
              },
            },
          },
        });

        if (!order) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Zamówienie nie zostało znalezione',
          });
        }

        return reply.send(order);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać zamówienia',
        });
      }
    }
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
