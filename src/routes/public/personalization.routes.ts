import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../lib/prisma';

interface PersonalizationParams {
  token: string;
}

interface SaveDesignBody {
  answers: Record<string, string | any>;
}

export async function personalizationRoutes(fastify: FastifyInstance) {
  // GET /personalization/:token - Get personalization case by access token
  fastify.get<{ Params: PersonalizationParams }>(
    '/:token',
    async (request: FastifyRequest<{ Params: PersonalizationParams }>, reply: FastifyReply) => {
      try {
        const personalizationCase = await prisma.personalizationCase.findUnique({
          where: { customerTokenHash: request.params.token },
          include: {
            orderItem: {
              include: {
                order: {
                  select: {
                    orderReference: true,
                    customerEmail: true,
                    customerName: true,
                  },
                },
                personalizedProduct: {
                  include: {
                    template: {
                      select: {
                        id: true,
                        code: true,
                        name: true,
                        description: true,
                        version: true,
                      },
                    },
                  },
                },
              },
            },
            answers: {
              include: {
                field: true,
              },
            },
          },
        });

        if (!personalizationCase) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Nie znaleziono personalizacji',
          });
        }

        // Check if token is active
        if (!personalizationCase.tokenActive) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Token jest nieaktywny',
          });
        }

        return reply.send(personalizationCase);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać personalizacji',
        });
      }
    }
  );

  // PUT /personalization/:token/answers - Save personalization answers
  fastify.put<{ Params: PersonalizationParams; Body: SaveDesignBody }>(
    '/:token/answers',
    async (
      request: FastifyRequest<{ Params: PersonalizationParams; Body: SaveDesignBody }>,
      reply: FastifyReply
    ) => {
      try {
        const personalizationCase = await prisma.personalizationCase.findUnique({
          where: { customerTokenHash: request.params.token },
        });

        if (!personalizationCase) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Nie znaleziono personalizacji',
          });
        }

        // Check if token is active
        if (!personalizationCase.tokenActive) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Token jest nieaktywny',
          });
        }

        // Save answers - upsert each answer
        const answers = request.body.answers;
        for (const [fieldId, value] of Object.entries(answers)) {
          await prisma.personalizationAnswer.upsert({
            where: {
              caseId_fieldId: {
                caseId: personalizationCase.id,
                fieldId,
              },
            },
            update: {
              valueText: typeof value === 'string' ? value : null,
              valueJson: typeof value !== 'string' ? value : null,
            },
            create: {
              caseId: personalizationCase.id,
              fieldId,
              valueText: typeof value === 'string' ? value : null,
              valueJson: typeof value !== 'string' ? value : null,
            },
          });
        }

        // Update case status
        const updated = await prisma.personalizationCase.update({
          where: { customerTokenHash: request.params.token },
          data: {
            status: 'WAITING_FOR_CUSTOMER',
          },
          include: {
            answers: {
              include: { field: true },
            },
          },
        });

        return reply.send(updated);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zapisać odpowiedzi',
        });
      }
    }
  );

  // POST /personalization/:token/submit - Submit personalization for production
  fastify.post<{ Params: PersonalizationParams }>(
    '/:token/submit',
    async (request: FastifyRequest<{ Params: PersonalizationParams }>, reply: FastifyReply) => {
      try {
        const personalizationCase = await prisma.personalizationCase.findUnique({
          where: { customerTokenHash: request.params.token },
          include: {
            answers: true,
          },
        });

        if (!personalizationCase) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Nie znaleziono personalizacji',
          });
        }

        // Check if token is active
        if (!personalizationCase.tokenActive) {
          return reply.status(403).send({
            error: 'Forbidden',
            message: 'Token jest nieaktywny',
          });
        }

        if (personalizationCase.answers.length === 0) {
          return reply.status(400).send({
            error: 'Bad Request',
            message: 'Brak wypełnionych pól personalizacji',
          });
        }

        const updated = await prisma.personalizationCase.update({
          where: { customerTokenHash: request.params.token },
          data: {
            status: 'SUBMITTED',
            submittedAt: new Date(),
          },
        });

        // TODO: Generate PDF
        // TODO: Send notification to admin

        return reply.send(updated);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zatwierdzić projektu',
        });
      }
    }
  );
}
