import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../lib/prisma';
import { getQueueStats, retryJob, getRenderQueue } from '../../services/queue/render.queue';

export async function renderJobsRoutes(fastify: FastifyInstance) {
  // GET /admin/render-jobs/stats - Statystyki RenderJobs (z BullMQ + bazy)
  fastify.get(
    '/stats',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Statystyki z BullMQ
        const queueStats = await getQueueStats();

        // Statystyki z bazy danych
        const dbStats = await prisma.renderJob.groupBy({
          by: ['status'],
          _count: {
            id: true,
          },
        });

        const dbStatsByStatus: Record<string, number> = {};
        for (const stat of dbStats) {
          dbStatsByStatus[stat.status] = stat._count.id;
        }

        return reply.send({
          queue: queueStats,
          database: dbStatsByStatus,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać statystyk',
        });
      }
    }
  );

  // GET /admin/render-jobs - Lista wszystkich RenderJobs
  fastify.get(
    '/',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const jobs = await prisma.renderJob.findMany({
          include: {
            case: {
              select: {
                id: true,
                status: true,
                orderItem: {
                  select: {
                    productNameSnapshot: true,
                    order: {
                      select: {
                        orderReference: true,
                      },
                    },
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 100,
        });

        return reply.send(jobs);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać listy jobów',
        });
      }
    }
  );

  // POST /admin/render-jobs/retry/:id - Retry pojedynczego joba
  fastify.post<{ Params: { id: string } }>(
    '/retry/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        // Pobierz job z bazy
        const dbJob = await prisma.renderJob.findUnique({
          where: { id: request.params.id },
        });

        if (!dbJob) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'RenderJob nie znaleziony',
          });
        }

        // Sprawdź czy ma bullmqJobId
        const metadata = dbJob.metadata as { bullmqJobId?: string } | null;
        const bullmqJobId = metadata?.bullmqJobId;

        if (bullmqJobId) {
          // Retry w BullMQ
          const success = await retryJob(bullmqJobId);
          if (success) {
            // Zaktualizuj status w bazie
            await prisma.renderJob.update({
              where: { id: request.params.id },
              data: { status: 'PENDING' },
            });

            return reply.send({
              message: 'Job został ponownie uruchomiony',
              jobId: request.params.id,
              bullmqJobId,
            });
          }
        }

        return reply.status(400).send({
          error: 'Bad Request',
          message: 'Nie można ponownie uruchomić tego joba',
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się ponownie uruchomić joba',
        });
      }
    }
  );

  // POST /admin/render-jobs/retry-failed - Retry wszystkich failed jobs
  fastify.post(
    '/retry-failed',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Pobierz wszystkie failed joby z bazy
        const failedJobs = await prisma.renderJob.findMany({
          where: { status: 'FAILED' },
        });

        let retried = 0;
        for (const dbJob of failedJobs) {
          const metadata = dbJob.metadata as { bullmqJobId?: string } | null;
          const bullmqJobId = metadata?.bullmqJobId;

          if (bullmqJobId) {
            const success = await retryJob(bullmqJobId);
            if (success) {
              await prisma.renderJob.update({
                where: { id: dbJob.id },
                data: { status: 'PENDING' },
              });
              retried++;
            }
          }
        }

        return reply.send({
          message: `Ponownie uruchomiono ${retried} jobów`,
          count: retried,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się ponownie uruchomić jobów',
        });
      }
    }
  );

  // GET /admin/render-jobs/:id - Szczegóły pojedynczego RenderJob
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const job = await prisma.renderJob.findUnique({
          where: { id: request.params.id },
          include: {
            case: {
              include: {
                orderItem: {
                  include: {
                    order: true,
                  },
                },
                assets: true,
              },
            },
          },
        });

        if (!job) {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'RenderJob nie znaleziony',
          });
        }

        // Pobierz status z BullMQ jeśli dostępny
        const metadata = job.metadata as { bullmqJobId?: string } | null;
        const bullmqJobId = metadata?.bullmqJobId;
        let queueStatus = null;

        if (bullmqJobId) {
          try {
            const queue = getRenderQueue();
            const bullmqJob = await queue.getJob(bullmqJobId);
            if (bullmqJob) {
              queueStatus = {
                state: await bullmqJob.getState(),
                progress: bullmqJob.progress,
                attemptsMade: bullmqJob.attemptsMade,
                failedReason: bullmqJob.failedReason,
              };
            }
          } catch {
            // Ignoruj błędy BullMQ
          }
        }

        return reply.send({
          ...job,
          queueStatus,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          error: 'Internal Server Error',
          message: 'Nie udało się pobrać danych joba',
        });
      }
    }
  );
}
