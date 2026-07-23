import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  getCases,
  getCaseById,
  updateCaseAnswers,
  updateCaseStatus,
  addCaseNote,
  resendPersonalizationEmail,
} from '../../services/admin/cases.service';
import {
  casesQuerySchema,
  caseIdParamsSchema,
  updateCaseAnswersSchema,
  updateCaseStatusSchema,
  addCaseNoteSchema,
  CasesQueryInput,
  CaseIdParams,
  UpdateCaseAnswersInput,
  UpdateCaseStatusInput,
  AddCaseNoteInput,
} from '../../schemas/admin.schema';
import prisma from '../../lib/prisma';
import { config } from '../../config';
import { decrypt } from '../../lib/encryption';

export async function casesRoutes(fastify: FastifyInstance) {
  // GET /admin/cases
  fastify.get<{ Querystring: CasesQueryInput }>(
    '/',
    {
      schema: {
        tags: ['cases'],
        summary: 'Lista case\'ów personalizacji',
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', default: 1 },
            limit: { type: 'integer', default: 20 },
            status: { type: 'string', description: 'Filtr po statusie' },
            search: { type: 'string', description: 'Szukaj po referencji zamówienia lub emailu' },
            shopId: { type: 'string' },
            sortBy: { type: 'string', default: 'createdAt' },
            sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'array', items: { type: 'object' } },
              total: { type: 'integer' },
              page: { type: 'integer' },
              limit: { type: 'integer' },
            },
          },
        },
      },
    },
    async (request: FastifyRequest<{ Querystring: CasesQueryInput }>, reply: FastifyReply) => {
      try {
        const parsed = casesQuerySchema.safeParse(request.query);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const result = await getCases(parsed.data);
        return reply.send(result);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać listy case',
        });
      }
    }
  );

  // GET /admin/cases/:id
  fastify.get<{ Params: CaseIdParams }>(
    '/:id',
    {
      schema: {
        tags: ['cases'],
        summary: 'Szczegóły case\'u',
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
        response: {
          200: { type: 'object' },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      try {
        const parsed = caseIdParamsSchema.safeParse(request.params);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const caseItem = await getCaseById(parsed.data.id);
        return reply.send(caseItem);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać szczegółów case',
        });
      }
    }
  );

  // PUT /admin/cases/:id/answers
  fastify.put<{ Params: CaseIdParams; Body: UpdateCaseAnswersInput }>(
    '/:id/answers',
    {
      schema: {
        tags: ['cases'],
        summary: 'Aktualizuj odpowiedzi case\'u (korekta sprzedawcy)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            answers: { type: 'object', description: 'Stara płaska mapa klucz pola → wartość' },
            sharedAnswers: { type: 'object', description: 'Odpowiedzi wspólne dla całej pozycji' },
            items: {
              type: 'array',
              description: 'Odpowiedzi indywidualne per sztuka',
              items: { type: 'object' },
            },
          },
        },
        response: {
          200: { type: 'object' },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: CaseIdParams; Body: UpdateCaseAnswersInput }>,
      reply: FastifyReply
    ) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);
        const bodyValidation = updateCaseAnswersSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: !paramsValidation.success
              ? paramsValidation.error.errors[0].message
              : (bodyValidation as any).error.errors[0].message,
          });
        }

        const updated = await updateCaseAnswers(
          paramsValidation.data.id,
          bodyValidation.data
        );
        return reply.send(updated);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zaktualizować odpowiedzi',
        });
      }
    }
  );

  // PUT /admin/cases/:id/status
  fastify.put<{ Params: CaseIdParams; Body: UpdateCaseStatusInput }>(
    '/:id/status',
    {
      schema: {
        tags: ['cases'],
        summary: 'Zmień status case\'u',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['status'],
          properties: {
            status: {
              type: 'string',
              enum: ['PENDING', 'WAITING_FOR_CUSTOMER', 'DRAFT', 'PREVIEW_READY', 'SUBMITTED', 'IN_PRODUCTION', 'COMPLETED', 'CANCELLED'],
            },
          },
        },
        response: {
          200: { type: 'object' },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: CaseIdParams; Body: UpdateCaseStatusInput }>,
      reply: FastifyReply
    ) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);
        const bodyValidation = updateCaseStatusSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: !paramsValidation.success
              ? paramsValidation.error.errors[0].message
              : (bodyValidation as any).error.errors[0].message,
          });
        }

        const updated = await updateCaseStatus(
          paramsValidation.data.id,
          bodyValidation.data.status
        );
        return reply.send(updated);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zaktualizować statusu',
        });
      }
    }
  );

  // POST /admin/cases/:id/notes
  fastify.post<{ Params: CaseIdParams; Body: AddCaseNoteInput }>(
    '/:id/notes',
    {
      schema: {
        tags: ['cases'],
        summary: 'Dodaj notatkę wewnętrzną do case\'u',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: {
          type: 'object',
          required: ['note'],
          properties: {
            note: { type: 'string', minLength: 1 },
          },
        },
        response: {
          200: { type: 'object' },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (
      request: FastifyRequest<{ Params: CaseIdParams; Body: AddCaseNoteInput }>,
      reply: FastifyReply
    ) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);
        const bodyValidation = addCaseNoteSchema.safeParse(request.body);

        if (!paramsValidation.success || !bodyValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: !paramsValidation.success
              ? paramsValidation.error.errors[0].message
              : (bodyValidation as any).error.errors[0].message,
          });
        }

        const updated = await addCaseNote(paramsValidation.data.id, bodyValidation.data.note);
        return reply.send(updated);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się dodać notatki',
        });
      }
    }
  );

  // POST /admin/cases/:id/resend-email
  fastify.post<{ Params: CaseIdParams }>(
    '/:id/resend-email',
    {
      schema: {
        tags: ['cases'],
        summary: 'Ponownie wyślij email personalizacji do klienta',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: { type: 'object' },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
          503: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);

        if (!paramsValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: paramsValidation.error.errors[0].message,
          });
        }

        const result = await resendPersonalizationEmail(paramsValidation.data.id);
        return reply.send(result);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Case not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }
        if (error.message === 'Email service not configured') {
          return reply.status(503).send({
            error: 'Service Unavailable',
            message: 'Serwis email nie jest skonfigurowany',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się wysłać emaila',
        });
      }
    }
  );

  // GET /admin/cases/:id/token - Get personalization token for case
  fastify.get<{ Params: CaseIdParams }>(
    '/:id/token',
    {
      schema: {
        tags: ['cases'],
        summary: 'Pobierz token klienta i URL personalizacji',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              token: { type: 'string' },
              url: { type: 'string' },
            },
          },
          404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        },
      },
    },
    async (request: FastifyRequest<{ Params: CaseIdParams }>, reply: FastifyReply) => {
      try {
        const paramsValidation = caseIdParamsSchema.safeParse(request.params);

        if (!paramsValidation.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: paramsValidation.error.errors[0].message,
          });
        }

        const caseItem = await prisma.personalizationCase.findUnique({
          where: { id: paramsValidation.data.id },
          select: {
            id: true,
            customerTokenEncrypted: true,
          },
        });

        if (!caseItem) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Case o podanym ID nie istnieje',
          });
        }

        if (!caseItem.customerTokenEncrypted) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Token nie został jeszcze wygenerowany',
          });
        }

        // Odszyfruj token
        const token = decrypt(caseItem.customerTokenEncrypted);

        return reply.send({
          token,
          url: `${config.frontend.portalUrl}/${token}`,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać tokena',
        });
      }
    }
  );
}
