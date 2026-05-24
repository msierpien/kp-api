import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as leadTimeGroupService from '../../../services/admin/warehouse-lead-time-groups.service';

export async function registerWarehouseLeadTimeGroupRoutes(fastify: FastifyInstance) {
  fastify.get('/lead-time-groups', {
    schema: {
      tags: ['warehouse-lead-time-groups'],
      summary: 'Lista grup czasu wysyłki produktów',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          search: { type: 'string' },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Querystring: leadTimeGroupService.LeadTimeGroupsQuery }>, reply: FastifyReply) => {
    try {
      const result = await leadTimeGroupService.getLeadTimeGroups(request.query);
      return reply.send(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd pobierania grup czasu wysyłki';
      const status = message.includes('Brak kontekstu') ? 400 : 500;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.post('/lead-time-groups', {
    schema: {
      tags: ['warehouse-lead-time-groups'],
      summary: 'Utwórz grupę czasu wysyłki',
      body: {
        type: 'object',
        required: ['code', 'name', 'leadTimeDays'],
        properties: {
          code: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          leadTimeDays: { type: 'integer', minimum: 0, maximum: 365 },
          isActive: { type: 'boolean', default: true },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: leadTimeGroupService.CreateLeadTimeGroupInput }>, reply: FastifyReply) => {
    try {
      const group = await leadTimeGroupService.createLeadTimeGroup(request.body);
      return reply.status(201).send(group);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd tworzenia grupy czasu wysyłki';
      return reply.status(400).send({ error: 'Error', message });
    }
  });

  fastify.put('/lead-time-groups/:id', {
    schema: {
      tags: ['warehouse-lead-time-groups'],
      summary: 'Edytuj grupę czasu wysyłki',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          code: { type: 'string', minLength: 1 },
          name: { type: 'string', minLength: 1 },
          leadTimeDays: { type: 'integer', minimum: 0, maximum: 365 },
          isActive: { type: 'boolean' },
        },
      },
    },
  }, async (request: FastifyRequest<{
    Params: { id: string };
    Body: leadTimeGroupService.UpdateLeadTimeGroupInput;
  }>, reply: FastifyReply) => {
    try {
      const group = await leadTimeGroupService.updateLeadTimeGroup(request.params.id, request.body);
      return reply.send(group);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd edycji grupy czasu wysyłki';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });

  fastify.delete('/lead-time-groups/:id', {
    schema: {
      tags: ['warehouse-lead-time-groups'],
      summary: 'Usuń grupę czasu wysyłki',
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
    },
  }, async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    try {
      await leadTimeGroupService.deleteLeadTimeGroup(request.params.id);
      return reply.status(204).send();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Błąd usuwania grupy czasu wysyłki';
      const status = message.includes('nie znalezion') ? 404 : 400;
      return reply.status(status).send({ error: 'Error', message });
    }
  });
}
