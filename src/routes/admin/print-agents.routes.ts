import { FastifyInstance } from 'fastify';
import { isAppError, ValidationError } from '../../lib/errors';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { requireRole } from '../../middleware/auth.middleware';
import {
  createPrintAgent,
  deletePrintAgent,
  listPrintAgents,
  revealPrintAgentToken,
  rotatePrintAgentToken,
  updatePrintAgent,
} from '../../services/print/print-agent.service';
import {
  createPrintAgentSchema,
  printIdParamsSchema,
  updatePrintAgentSchema,
} from '../../schemas/print.schema';

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
};

const objectResponse = { type: 'object', additionalProperties: true } as const;

function sendError(reply: any, error: unknown) {
  if (isAppError(error)) {
    return reply.status(error.statusCode).send({ error: error.error, message: error.message });
  }
  throw error;
}

export async function printAgentsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/',
    {
      schema: {
        tags: ['print'],
        summary: 'Lista agentow druku',
        response: { 200: objectResponse },
      },
    },
    async (_request, reply) => {
      return reply.send({ items: await listPrintAgents() });
    }
  );

  fastify.post(
    '/',
    {
      // Token daje prawo drukowania w imieniu firmy - nadawanie go zostawiamy adminom.
      preHandler: requireRole('ADMIN', 'SUPER_ADMIN'),
      schema: {
        tags: ['print'],
        summary: 'Dodanie agenta druku (zwraca token jeden jedyny raz)',
        response: { 201: objectResponse, 400: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const parsed = createPrintAgentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Validation Error', message: parsed.error.errors[0].message });
      }

      // SUPER_ADMIN nie ma tenanta w kontekscie, wiec musi go wskazac jawnie.
      const tenantId = parsed.data.tenantId ?? getTenantId() ?? getTenantContext()?.tenantId;
      if (!tenantId) {
        return sendError(reply, new ValidationError('Wskaz tenanta dla nowego agenta'));
      }

      try {
        const { agent, token } = await createPrintAgent(parsed.data.name, tenantId);
        return reply.status(201).send({
          agent: { id: agent.id, name: agent.name, tokenPrefix: agent.tokenPrefix },
          token,
        });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.get<{ Params: { id: string } }>(
    '/:id/token',
    {
      preHandler: requireRole('ADMIN', 'SUPER_ADMIN'),
      schema: {
        tags: ['print'],
        summary: 'Podglad tokenu agenta',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: objectResponse, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const params = printIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Brak identyfikatora' });
      }
      try {
        return reply.send(await revealPrintAgentToken(params.data.id));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.post<{ Params: { id: string } }>(
    '/:id/token/rotate',
    {
      preHandler: requireRole('ADMIN', 'SUPER_ADMIN'),
      schema: {
        tags: ['print'],
        summary: 'Rotacja tokenu — stary przestaje dzialac natychmiast',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: objectResponse, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const params = printIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Brak identyfikatora' });
      }
      try {
        const { token } = await rotatePrintAgentToken(params.data.id);
        return reply.send({ token });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: requireRole('ADMIN', 'SUPER_ADMIN'),
      schema: {
        tags: ['print'],
        summary: 'Zmiana nazwy lub stanu agenta',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 200: objectResponse, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const params = printIdParamsSchema.safeParse(request.params);
      const body = updatePrintAgentSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Nieprawidlowe dane' });
      }
      try {
        const agent = await updatePrintAgent(params.data.id, body.data);
        return reply.send({ agent: { id: agent.id, name: agent.name, status: agent.status } });
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: requireRole('ADMIN', 'SUPER_ADMIN'),
      schema: {
        tags: ['print'],
        summary: 'Usuniecie agenta druku',
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        response: { 204: { type: 'null' }, 404: errorResponseSchema, 409: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const params = printIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: 'Validation Error', message: 'Brak identyfikatora' });
      }
      try {
        await deletePrintAgent(params.data.id);
        return reply.status(204).send();
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );
}
