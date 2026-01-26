import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getStats } from '../../services/admin/stats.service';

export async function statsRoutes(fastify: FastifyInstance) {
  // GET /admin/stats
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const stats = await getStats();
      return reply.send(stats);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Nie udało się pobrać statystyk',
      });
    }
  });
}
