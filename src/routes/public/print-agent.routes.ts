import { createReadStream } from 'fs';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import prisma from '../../lib/prisma';
import { RATE_LIMITS } from '../../lib/rate-limits';
import { isAppError } from '../../lib/errors';
import { fileExists, resolveStorageFilePath } from '../../services/storage/local-storage.service';
import { requirePrintAgent } from '../../middleware/print-agent.middleware';
import { handleAgentHello } from '../../services/print/print-agent.service';
import {
  claimPrintJobs,
  getAgentJob,
  reportJobStatus,
  type PrintAgentContext,
} from '../../services/print/print-job.service';
import {
  printAgentClaimSchema,
  printAgentFileParamsSchema,
  printAgentHelloSchema,
  printAgentReportSchema,
} from '../../schemas/print.schema';

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
};

function agentOf(request: FastifyRequest): PrintAgentContext {
  // requirePrintAgent gwarantuje obecnosc - inaczej handler by sie nie wykonal.
  return request.printAgent as PrintAgentContext;
}

function sendAppError(reply: FastifyReply, error: unknown, fallback: string) {
  if (isAppError(error)) {
    return reply.status(error.statusCode).send({ error: error.error, message: error.message });
  }
  return reply.status(500).send({ error: 'Internal Server Error', message: fallback });
}

/**
 * Trasy lokalnego agenta druku.
 *
 * Kierunek polaczenia jest odwrotny niz zwykle: to agent w sieci klienta odpytuje
 * nas o zadania, bo serwer nie ma jak dosiegnac drukarki za NAT-em i mDNS-em.
 */
export async function printAgentRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/hello',
    {
      preHandler: requirePrintAgent({ touchLastSeen: false }),
      config: { rateLimit: RATE_LIMITS.printAgentPoll },
      schema: {
        tags: ['print-agent'],
        summary: 'Rejestracja profili agenta i heartbeat',
        security: [],
        response: {
          200: { type: 'object', additionalProperties: true },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = printAgentHelloSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }

      const agent = agentOf(request);
      const result = await handleAgentHello(agent.id, parsed.data, request.ip);
      return reply.send(result);
    }
  );

  fastify.post(
    '/jobs/claim',
    {
      preHandler: requirePrintAgent(),
      config: { rateLimit: RATE_LIMITS.printAgentPoll },
      schema: {
        tags: ['print-agent'],
        summary: 'Pobranie zadan do druku',
        security: [],
        response: {
          200: { type: 'object', additionalProperties: true },
          400: errorResponseSchema,
          401: errorResponseSchema,
          403: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const parsed = printAgentClaimSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }

      const agent = agentOf(request);
      const jobs = await claimPrintJobs(agent, parsed.data.profiles, parsed.data.max);
      return reply.send({ jobs, pollIntervalSec: 10 });
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/jobs/:id/file',
    {
      preHandler: requirePrintAgent(),
      config: { rateLimit: RATE_LIMITS.printAgentFile },
      schema: {
        tags: ['print-agent'],
        summary: 'Pobranie pliku do wydruku',
        security: [],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: {
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const params = printAgentFileParamsSchema.safeParse(request.params);
      const claimToken = request.headers['x-claim-token'] as string | undefined;

      if (!params.success || !claimToken) {
        return reply
          .status(400)
          .send({ error: 'Validation Error', message: 'Brak identyfikatora zadania lub tokenu' });
      }

      const agent = agentOf(request);

      try {
        const job = await getAgentJob(agent, params.data.id, claimToken);

        // Plik mogl zniknac przy sprzataniu magazynu - lepszy czytelny blad
        // i zamkniete zadanie niz 500 i agent probujacy w kolko.
        if (!(await fileExists(job.asset.filePath))) {
          await prisma.printJob.update({
            where: { id: job.id },
            data: {
              status: 'FAILED',
              error: 'Plik nie istnieje juz w magazynie',
              completedAt: new Date(),
              claimToken: null,
              claimExpiresAt: null,
            },
          });
          return reply
            .status(404)
            .send({ error: 'Not Found', message: 'Plik nie istnieje juz w magazynie' });
        }

        const fileName = job.asset.filePath.split('/').pop() || 'wydruk.pdf';
        reply
          .header('Content-Type', job.asset.mimeType)
          .header('Content-Length', job.asset.fileSize)
          .header('Content-Disposition', `attachment; filename="${fileName}"`)
          .header('Cache-Control', 'no-store');

        return reply.send(createReadStream(resolveStorageFilePath(job.asset.filePath)));
      } catch (error) {
        return sendAppError(reply, error, 'Nie udalo sie wydac pliku');
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/jobs/:id/status',
    {
      preHandler: requirePrintAgent(),
      config: { rateLimit: RATE_LIMITS.printAgentReport },
      schema: {
        tags: ['print-agent'],
        summary: 'Raport postepu druku',
        security: [],
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
        response: {
          200: { type: 'object', additionalProperties: true },
          401: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const params = printAgentFileParamsSchema.safeParse(request.params);
      const parsed = printAgentReportSchema.safeParse(request.body ?? {});

      if (!params.success || !parsed.success) {
        const message = params.success
          ? parsed.error!.errors[0].message
          : params.error.errors[0].message;
        return reply.status(400).send({ error: 'Validation Error', message });
      }

      const agent = agentOf(request);

      try {
        // Sam claimToken weryfikuje getAgentJob; tutaj sprawdzamy go ponownie,
        // zeby raport nie mogl przyjsc od agenta bez waznej dzierzawy.
        await getAgentJob(agent, params.data.id, parsed.data.claimToken);

        const { job, more } = await reportJobStatus(agent, params.data.id, {
          status: parsed.data.status,
          cupsJobId: parsed.data.cupsJobId,
          message: parsed.data.message,
          geometry: parsed.data.geometry as Record<string, unknown> | null,
        });

        return reply.send({ id: job.id, status: job.status, more });
      } catch (error) {
        return sendAppError(reply, error, 'Nie udalo sie zapisac raportu');
      }
    }
  );
}
