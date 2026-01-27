import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../lib/prisma';
import { createManualOrder, deleteOrder } from '../../services/admin/orders.service';
import { createManualOrderSchema, type CreateManualOrderInput } from '../../schemas/admin.schema';

interface OrderParams {
  id: string;
}

export async function ordersRoutes(fastify: FastifyInstance) {
  // GET /admin/orders - List all orders
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
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

  // POST /admin/orders/manual - Create manual order
  fastify.post<{ Body: CreateManualOrderInput }>(
    '/manual',
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
