import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../lib/prisma';

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
}
