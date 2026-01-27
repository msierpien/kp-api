import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  listAutomations,
  getAutomationById,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  toggleAutomation,
} from '../../services/admin/automation.service';

// Schemas
const automationIdSchema = z.object({
  id: z.string().cuid(),
});

const createAutomationSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: z.enum(['CASE_CREATED', 'CASE_STATUS_CHANGED', 'CASE_SUBMITTED', 'CASE_TIME_ELAPSED']),
  conditions: z.array(z.any()), // JSON array of conditions
  actions: z.array(z.any()), // JSON array of actions
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
});

const updateAutomationSchema = createAutomationSchema.partial();

const toggleAutomationSchema = z.object({
  isActive: z.boolean(),
});

export async function automationsRoutes(fastify: FastifyInstance) {
  // GET /admin/automations
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const automations = await listAutomations();
      return reply.send(automations);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Nie udało się pobrać listy automatyzacji',
      });
    }
  });

  // GET /admin/automations/:id
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const paramsParsed = automationIdSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        const automation = await getAutomationById(paramsParsed.data.id);
        return reply.send(automation);
      } catch (error: any) {
        fastify.log.error(error);
        if (error.message === 'Automation not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Automatyzacja nie została znaleziona',
          });
        }
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać automatyzacji',
        });
      }
    }
  );

  // POST /admin/automations
  fastify.post<{ Body: any }>(
    '/',
    async (request: FastifyRequest<{ Body: any }>, reply: FastifyReply) => {
      const bodyParsed = createAutomationSchema.safeParse(request.body);
      if (!bodyParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: bodyParsed.error.errors[0].message,
        });
      }

      try {
        const automation = await createAutomation(bodyParsed.data);
        return reply.status(201).send(automation);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się utworzyć automatyzacji',
        });
      }
    }
  );

  // PUT /admin/automations/:id
  fastify.put<{ Params: { id: string }; Body: any }>(
    '/:id',
    async (request: FastifyRequest<{ Params: { id: string }; Body: any }>, reply: FastifyReply) => {
      const paramsParsed = automationIdSchema.safeParse(request.params);
      const bodyParsed = updateAutomationSchema.safeParse(request.body);

      if (!paramsParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: !paramsParsed.success
            ? paramsParsed.error.errors[0].message
            : bodyParsed.error.errors[0].message,
        });
      }

      try {
        const automation = await updateAutomation(paramsParsed.data.id, bodyParsed.data);
        return reply.send(automation);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zaktualizować automatyzacji',
        });
      }
    }
  );

  // DELETE /admin/automations/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const paramsParsed = automationIdSchema.safeParse(request.params);
      if (!paramsParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: paramsParsed.error.errors[0].message,
        });
      }

      try {
        await deleteAutomation(paramsParsed.data.id);
        return reply.status(204).send();
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się usunąć automatyzacji',
        });
      }
    }
  );

  // POST /admin/automations/:id/toggle
  fastify.post<{ Params: { id: string }; Body: any }>(
    '/:id/toggle',
    async (request: FastifyRequest<{ Params: { id: string }; Body: any }>, reply: FastifyReply) => {
      const paramsParsed = automationIdSchema.safeParse(request.params);
      const bodyParsed = toggleAutomationSchema.safeParse(request.body);

      if (!paramsParsed.success || !bodyParsed.success) {
        return reply.status(400).send({
          error: 'Validation Error',
          message: !paramsParsed.success
            ? paramsParsed.error.errors[0].message
            : bodyParsed.error.errors[0].message,
        });
      }

      try {
        const automation = await toggleAutomation(paramsParsed.data.id, bodyParsed.data.isActive);
        return reply.send(automation);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się zmienić statusu automatyzacji',
        });
      }
    }
  );
}
