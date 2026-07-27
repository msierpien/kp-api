import { FastifyInstance } from 'fastify';
import prisma from '../../lib/prisma';
import { isAppError } from '../../lib/errors';
import {
  cancelPrintJob,
  createPrintJob,
  listPrintJobs,
  resolveStaleJob,
  retryPrintJob,
  toPrintJobDto,
} from '../../services/print/print-job.service';
import {
  createPrintJobSchema,
  printIdParamsSchema,
  printJobsQuerySchema,
  resolveStaleSchema,
} from '../../schemas/print.schema';

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
};

const objectResponse = { type: 'object', additionalProperties: true } as const;

/** Kod bledu jest znany dopiero w czasie dzialania, wiec reply nie da sie tu zwezic. */
function sendError(reply: any, error: unknown) {
  if (isAppError(error)) {
    return reply.status(error.statusCode).send({ error: error.error, message: error.message });
  }
  throw error;
}

export async function printJobsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['print'],
        summary: 'Lista zlecen druku',
        response: { 200: objectResponse, 400: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const parsed = printJobsQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }
      return reply.send(await listPrintJobs(parsed.data));
    }
  );

  fastify.post(
    '/',
    {
      schema: {
        tags: ['print'],
        summary: 'Utworzenie pojedynczego zlecenia druku',
        response: { 201: objectResponse, 400: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const parsed = createPrintJobSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }

      try {
        const job = await createPrintJob({
          ...parsed.data,
          requestedById: request.user?.userId ?? null,
        });
        return reply.status(201).send({ job: toPrintJobDto(job) });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/cancel',
    {
      schema: {
        tags: ['print'],
        summary: 'Anulowanie zlecenia druku',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: objectResponse, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const params = printIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Brak identyfikatora' });
      }

      try {
        const job = await cancelPrintJob(params.data.id);
        return reply.send({ job: toPrintJobDto(job) });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/retry',
    {
      schema: {
        tags: ['print'],
        summary: 'Ponowienie zlecenia druku (tworzy nowe, stare zostaje w historii)',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 201: objectResponse, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const params = printIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Brak identyfikatora' });
      }

      try {
        const job = await retryPrintJob(params.data.id, request.user?.userId ?? null);
        return reply.status(201).send({ job: toPrintJobDto(job) });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/resolve-stale',
    {
      schema: {
        tags: ['print'],
        summary: 'Rozstrzygniecie zadania, ktore stracilo kontakt w trakcie druku',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: objectResponse, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const params = printIdParamsSchema.safeParse(request.params);
      const body = resolveStaleSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply
          .status(400)
          .send({ error: 'Validation Error', message: 'Podaj, czy wydruk wyszedl' });
      }

      try {
        const job = await resolveStaleJob(params.data.id, body.data.printed);
        return reply.send({ job: toPrintJobDto(job) });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['print'],
        summary: 'Szczegoly zlecenia druku',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: objectResponse, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const params = printIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Brak identyfikatora' });
      }

      const job = await prisma.printJob.findFirst({
        where: { id: params.data.id },
        include: {
          agent: { select: { id: true, name: true } },
          case: { select: { id: true, order: { select: { orderReference: true } } } },
        },
      });

      if (!job) {
        return reply.status(404).send({ error: 'Not Found', message: 'Nie ma takiego zadania' });
      }
      return reply.send({ job: toPrintJobDto(job) });
    }
  );
}
