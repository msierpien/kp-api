import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware, requireRole } from '../../middleware/auth.middleware';
import * as usersService from '../../services/admin/users.service';
import type { CreateUserInput, UpdateUserInput } from '../../services/admin/users.service';

export async function usersRoutes(fastify: FastifyInstance) {
  // All routes require at least ADMIN role
  const adminOrSuper = [authMiddleware(fastify), requireRole('ADMIN', 'SUPER_ADMIN')];

  // GET /admin/users - list users
  // Query param: ?tenantId=xxx (SUPER_ADMIN only)
  fastify.get<{ Querystring: { tenantId?: string } }>(
    '/',
    { preHandler: adminOrSuper },
    async (request: FastifyRequest<{ Querystring: { tenantId?: string } }>, reply: FastifyReply) => {
      try {
        const tenantIdFilter = request.query.tenantId;
        const users = await usersService.getAllUsers(tenantIdFilter);
        return reply.send(users);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd pobierania użytkowników';
        return reply.status(500).send({ error: 'Internal Server Error', message });
      }
    }
  );

  // GET /admin/users/:id - get single user
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: adminOrSuper },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const user = await usersService.getUserById(request.params.id);
        return reply.send(user);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd pobierania użytkownika';
        return reply.status(404).send({ error: 'Not Found', message });
      }
    }
  );

  // POST /admin/users - create new user
  fastify.post<{ Body: CreateUserInput }>(
    '/',
    { preHandler: adminOrSuper },
    async (request: FastifyRequest<{ Body: CreateUserInput }>, reply: FastifyReply) => {
      try {
        const user = await usersService.createUser(request.body);
        return reply.status(201).send(user);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd tworzenia użytkownika';
        return reply.status(400).send({ error: 'Bad Request', message });
      }
    }
  );

  // PATCH /admin/users/:id - update user
  fastify.patch<{ Params: { id: string }; Body: UpdateUserInput }>(
    '/:id',
    { preHandler: adminOrSuper },
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: UpdateUserInput }>,
      reply: FastifyReply
    ) => {
      try {
        const user = await usersService.updateUser(request.params.id, request.body);
        return reply.send(user);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd aktualizacji użytkownika';
        return reply.status(400).send({ error: 'Bad Request', message });
      }
    }
  );

  // DELETE /admin/users/:id - deactivate user
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: adminOrSuper },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await usersService.deleteUser(request.params.id);
        return reply.status(204).send();
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Błąd usuwania użytkownika';
        return reply.status(400).send({ error: 'Bad Request', message });
      }
    }
  );
}
