import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSyncLogs } from '../../services/admin/sync-logs.service';
import { syncLogsQuerySchema, SyncLogsQueryInput } from '../../schemas/admin.schema';

export async function syncLogsRoutes(fastify: FastifyInstance) {
  // GET /admin/sync-logs
  fastify.get<{ Querystring: SyncLogsQueryInput }>(
    '/',
    {
      schema: {
        tags: ['sync-logs'],
        summary: 'Historia synchronizacji zamówień',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', default: 50, description: 'Maksymalna liczba logów' },
            shopId: { type: 'string', description: 'Filtruj po ID sklepu' },
          },
        },
        response: { 200: { type: 'array', items: { type: 'object' } } },
      },
    },
    async (request: FastifyRequest<{ Querystring: SyncLogsQueryInput }>, reply: FastifyReply) => {
      try {
        const parsed = syncLogsQuerySchema.safeParse(request.query);

        if (!parsed.success) {
          return reply.status(400).send({
            error: 'Validation Error',
            message: parsed.error.errors[0].message,
          });
        }

        const logs = await getSyncLogs(parsed.data.limit, parsed.data.shopId);
        return reply.send(logs);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać logów synchronizacji',
        });
      }
    }
  );
}
