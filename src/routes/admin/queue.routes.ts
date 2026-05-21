import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware, requireRole } from '../../middleware/auth.middleware';
import {
  getAllQueuesStats,
  getQueueStats,
  getQueueJobs,
  getJobDetails,
  retryJob,
  retryAllFailed,
  deleteJob,
  cleanQueue,
  drainQueue,
  getQueueNames,
} from '../../services/queue/queue-stats.service';

const queueStatsSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    counts: {
      type: 'object',
      properties: {
        waiting: { type: 'number' },
        active: { type: 'number' },
        completed: { type: 'number' },
        failed: { type: 'number' },
        delayed: { type: 'number' },
        paused: { type: 'number' },
      },
    },
    lastJob: {
      anyOf: [
        {
          type: 'object',
          properties: {
            id: { type: 'string' },
            processedOn: { type: 'number' },
            finishedOn: { type: 'number' },
          },
        },
        { type: 'null' },
      ],
    },
  },
};

const queueListResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    queues: { type: 'array', items: queueStatsSchema },
  },
};

const queueErrorResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    message: { type: 'string' },
  },
};

export async function queueRoutes(fastify: FastifyInstance) {
  // Only SUPER_ADMIN can access queue management
  const superAdminOnly = [authMiddleware(fastify), requireRole('SUPER_ADMIN')];

  // GET /admin/queues - List all queues with stats
  fastify.get(
    '/',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['queues'],
        summary: 'Lista kolejek BullMQ ze statystykami (SUPER_ADMIN)',
        response: { 200: queueListResponseSchema, 500: queueErrorResponseSchema },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const stats = await getAllQueuesStats();
        return reply.send({
          success: true,
          queues: stats,
        });
      } catch (error) {
        fastify.log.error('[QueueRoutes] Error fetching queue stats');
        fastify.log.error(error);
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to fetch queue stats',
        });
      }
    }
  );

  // GET /admin/queues/names - Get available queue names
  fastify.get(
    '/names',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['queues'],
        summary: 'Lista nazw dostępnych kolejek',
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              queues: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const names = getQueueNames();
      return reply.send({
        success: true,
        queues: names,
      });
    }
  );

  // GET /admin/queues/:name/stats - Get stats for specific queue
  fastify.get<{ Params: { name: string } }>(
    '/:name/stats',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['queues'],
        summary: 'Statystyki konkretnej kolejki',
        params: { type: 'object', properties: { name: { type: 'string' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              stats: queueStatsSchema,
            },
          },
          404: queueErrorResponseSchema,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
      try {
        const { name } = request.params;
        const stats = await getQueueStats(name);
        return reply.send({
          success: true,
          stats,
        });
      } catch (error) {
        fastify.log.error(`[QueueRoutes] Error fetching stats for queue ${request.params.name}`);
        fastify.log.error(error);
        return reply.code(404).send({
          success: false,
          message: error instanceof Error ? error.message : 'Queue not found',
        });
      }
    }
  );

  // GET /admin/queues/:name/jobs - Get jobs from queue
  fastify.get<{
    Params: { name: string };
    Querystring: { status?: string; page?: number; limit?: number };
  }>(
    '/:name/jobs',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['queues'],
        summary: 'Lista zadań z kolejki',
        params: { type: 'object', properties: { name: { type: 'string' } } },
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'], default: 'waiting' },
            page: { type: 'integer', default: 1 },
            limit: { type: 'integer', default: 20 },
          },
        },
        response: { 200: { type: 'object' } },
      },
    },
    async (request: FastifyRequest<{
      Params: { name: string };
      Querystring: { status?: string; page?: number; limit?: number };
    }>, reply: FastifyReply) => {
      try {
        const { name } = request.params;
        const { status = 'waiting', page = 1, limit = 20 } = request.query;

        const validStatuses = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'];
        if (!validStatuses.includes(status)) {
          return reply.code(400).send({
            success: false,
            message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
          });
        }

        const start = (page - 1) * limit;
        const end = start + limit - 1;

        const jobs = await getQueueJobs(
          name,
          status as 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'paused',
          start,
          end
        );

        // Simplify job data for list view
        const simplifiedJobs = jobs.map(job => ({
          id: job.id,
          name: job.name,
          data: job.data,
          attemptsMade: job.attemptsMade,
          failedReason: job.failedReason,
          finishedOn: job.finishedOn,
          processedOn: job.processedOn,
          timestamp: job.timestamp,
        }));

        return reply.send({
          success: true,
          jobs: simplifiedJobs,
          pagination: {
            page,
            limit,
            total: jobs.length,
          },
        });
      } catch (error) {
        fastify.log.error(`[QueueRoutes] Error fetching jobs from queue ${request.params.name}:`);
        fastify.log.error(error);
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to fetch jobs',
        });
      }
    }
  );

  // GET /admin/queues/:name/jobs/:id - Get job details
  fastify.get<{ Params: { name: string; id: string } }>(
    '/:name/jobs/:id',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['queues'],
        summary: 'Szczegóły zadania w kolejce',
        params: { type: 'object', properties: { name: { type: 'string' }, id: { type: 'string' } } },
        response: { 200: { type: 'object' }, 404: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
    async (request: FastifyRequest<{ Params: { name: string; id: string } }>, reply: FastifyReply) => {
      try {
        const { name, id } = request.params;
        const job = await getJobDetails(name, id);

        if (!job) {
          return reply.code(404).send({
            success: false,
            message: `Job '${id}' not found in queue '${name}'`,
          });
        }

        return reply.send({
          success: true,
          job,
        });
      } catch (error) {
        fastify.log.error(`[QueueRoutes] Error fetching job ${request.params.id}:`);
        fastify.log.error(error);
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to fetch job details',
        });
      }
    }
  );

  // POST /admin/queues/:name/jobs/:id/retry - Retry a job
  fastify.post<{ Params: { name: string; id: string } }>(
    '/:name/jobs/:id/retry',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['queues'],
        summary: 'Ponów zadanie w kolejce',
        params: { type: 'object', properties: { name: { type: 'string' }, id: { type: 'string' } } },
        response: { 200: { type: 'object' } },
      },
    },
    async (request: FastifyRequest<{ Params: { name: string; id: string } }>, reply: FastifyReply) => {
      try {
        const { name, id } = request.params;
        await retryJob(name, id);

        return reply.send({
          success: true,
          message: `Job '${id}' has been retried`,
        });
      } catch (error) {
        fastify.log.error(`[QueueRoutes] Error retrying job ${request.params.id}:`);
        fastify.log.error(error);
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to retry job',
        });
      }
    }
  );

  // POST /admin/queues/:name/retry-failed - Retry all failed jobs
  fastify.post<{ Params: { name: string } }>(
    '/:name/retry-failed',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['queues'],
        summary: 'Ponów wszystkie nieudane zadania w kolejce',
        params: { type: 'object', properties: { name: { type: 'string' } } },
        response: { 200: { type: 'object' } },
      },
    },
    async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
      try {
        const { name } = request.params;
        const retriedCount = await retryAllFailed(name);

        return reply.send({
          success: true,
          message: `Retried ${retriedCount} failed jobs in queue '${name}'`,
          retriedCount,
        });
      } catch (error) {
        fastify.log.error(`[QueueRoutes] Error retrying failed jobs in queue ${request.params.name}:`);
        fastify.log.error(error);
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to retry failed jobs',
        });
      }
    }
  );

  // DELETE /admin/queues/:name/jobs/:id - Delete a job
  fastify.delete<{ Params: { name: string; id: string } }>(
    '/:name/jobs/:id',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['queues'],
        summary: 'Usuń zadanie z kolejki',
        params: { type: 'object', properties: { name: { type: 'string' }, id: { type: 'string' } } },
        response: { 200: { type: 'object' } },
      },
    },
    async (request: FastifyRequest<{ Params: { name: string; id: string } }>, reply: FastifyReply) => {
      try {
        const { name, id } = request.params;
        await deleteJob(name, id);

        return reply.send({
          success: true,
          message: `Job '${id}' has been deleted`,
        });
      } catch (error) {
        fastify.log.error(`[QueueRoutes] Error deleting job ${request.params.id}:`);
        fastify.log.error(error);
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to delete job',
        });
      }
    }
  );

  // POST /admin/queues/:name/drain - Remove all waiting jobs
  fastify.post<{ Params: { name: string } }>(
    '/:name/drain',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['queues'],
        summary: 'Usuń wszystkie oczekujące zadania z kolejki (waiting)',
        params: { type: 'object', properties: { name: { type: 'string' } } },
        response: { 200: { type: 'object' } },
      },
    },
    async (request: FastifyRequest<{ Params: { name: string } }>, reply: FastifyReply) => {
      try {
        const removed = await drainQueue(request.params.name);
        return reply.send({ success: true, removed });
      } catch (error) {
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to drain queue',
        });
      }
    }
  );

  // POST /admin/queues/:name/clean - Clean old jobs
  fastify.post<{
    Params: { name: string };
    Body: { grace?: number; limit?: number; type?: 'completed' | 'failed' };
  }>(
    '/:name/clean',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['queues'],
        summary: 'Wyczyść stare zadania z kolejki',
        params: { type: 'object', properties: { name: { type: 'string' } } },
        body: {
          type: 'object',
          properties: {
            grace: { type: 'integer', description: 'Czas w ms po którym zadanie jest uznane za stare' },
            limit: { type: 'integer', description: 'Maksymalna liczba zadań do usunięcia' },
            type: { type: 'string', enum: ['completed', 'failed'] },
          },
        },
        response: { 200: { type: 'object' } },
      },
    },
    async (request: FastifyRequest<{
      Params: { name: string };
      Body: { grace?: number; limit?: number; type?: 'completed' | 'failed' };
    }>, reply: FastifyReply) => {
      try {
        const { name } = request.params;
        const { grace, limit, type } = request.body || {};

        const removedJobs = await cleanQueue(name, grace, limit, type);

        return reply.send({
          success: true,
          message: `Cleaned ${removedJobs.length} jobs from queue '${name}'`,
          removedCount: removedJobs.length,
          removedJobs,
        });
      } catch (error) {
        fastify.log.error(`[QueueRoutes] Error cleaning queue ${request.params.name}:`);
        fastify.log.error(error);
        return reply.code(500).send({
          success: false,
          message: error instanceof Error ? error.message : 'Failed to clean queue',
        });
      }
    }
  );
}
