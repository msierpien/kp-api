import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware, requireRole } from '../../middleware/auth.middleware';
import * as tenantsService from '../../services/admin/tenants.service';
import type { CreateTenantInput, UpdateTenantInput } from '../../services/admin/tenants.service';

export async function tenantsRoutes(fastify: FastifyInstance) {
  // All routes require SUPER_ADMIN role
  const superAdminOnly = [authMiddleware(fastify), requireRole('SUPER_ADMIN')];

  // GET /admin/tenants - list all tenants
  fastify.get(
    '/',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['tenants'],
        summary: 'Lista tenantów (SUPER_ADMIN)',
        response: { 200: { type: 'array', items: { type: 'object' } } },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const tenants = await tenantsService.getAllTenants();
        return reply.send(tenants);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd pobierania tenantów';
        return reply.status(500).send({ error: 'Internal Server Error', message });
      }
    }
  );

  // GET /admin/tenants/:id - get single tenant
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['tenants'],
        summary: 'Szczegóły tenanta',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 200: { type: 'object' }, 404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const tenant = await tenantsService.getTenantById(request.params.id);
        return reply.send(tenant);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd pobierania tenant';
        return reply.status(404).send({ error: 'Not Found', message });
      }
    }
  );

  // POST /admin/tenants - create new tenant
  fastify.post<{ Body: CreateTenantInput }>(
    '/',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['tenants'],
        summary: 'Utwórz nowego tenanta',
        body: {
          type: 'object',
          required: ['name', 'slug'],
          properties: {
            name: { type: 'string' },
            slug: { type: 'string' },
          },
        },
        response: { 201: { type: 'object' }, 400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
    async (request: FastifyRequest<{ Body: CreateTenantInput }>, reply: FastifyReply) => {
      try {
        const tenant = await tenantsService.createTenant(request.body);
        return reply.status(201).send(tenant);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd tworzenia tenant';
        return reply.status(400).send({ error: 'Bad Request', message });
      }
    }
  );

  // PATCH /admin/tenants/:id - update tenant
  fastify.patch<{ Params: { id: string }; Body: UpdateTenantInput }>(
    '/:id',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['tenants'],
        summary: 'Zaktualizuj tenanta',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        body: { type: 'object' },
        response: { 200: { type: 'object' }, 400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: UpdateTenantInput }>,
      reply: FastifyReply
    ) => {
      try {
        const tenant = await tenantsService.updateTenant(request.params.id, request.body);
        return reply.send(tenant);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd aktualizacji tenant';
        return reply.status(400).send({ error: 'Bad Request', message });
      }
    }
  );

  // DELETE /admin/tenants/:id - soft delete tenant
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['tenants'],
        summary: 'Soft delete tenanta',
        params: { type: 'object', properties: { id: { type: 'string' } } },
        response: { 204: { type: 'null' }, 400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await tenantsService.deleteTenant(request.params.id);
        return reply.status(204).send();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd usuwania tenant';
        return reply.status(400).send({ error: 'Bad Request', message });
      }
    }
  );
}
