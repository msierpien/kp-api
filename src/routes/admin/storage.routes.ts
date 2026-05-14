import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware, requireRole } from '../../middleware/auth.middleware';
import { cleanupStorage, type CleanupOptions } from '../../services/storage/cleanup-storage.service';

export async function storageRoutes(fastify: FastifyInstance) {
  // Tylko SUPER_ADMIN
  const superAdminOnly = [authMiddleware(fastify), requireRole('SUPER_ADMIN')];

  // POST /admin/storage/cleanup - manual cleanup
  fastify.post<{ Body: CleanupOptions }>(
    '/cleanup',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['storage'],
        summary: 'Wyczyść osierocone pliki z storage (SUPER_ADMIN)',
        body: {
          type: 'object',
          properties: {
            dryRun: { type: 'boolean', description: 'Tylko symulacja — nie usuwa plików' },
          },
        },
        response: { 200: { type: 'object' } },
      },
    },
    async (request: FastifyRequest<{ Body: CleanupOptions }>, reply: FastifyReply) => {
      try {
        const options = request.body || {};
        const stats = await cleanupStorage(options);
        
        return reply.send({
          success: true,
          stats,
          message: options.dryRun
            ? `Dry run complete: ${stats.orphanedFilesFound} orphaned files found`
            : `Cleanup complete: ${stats.orphanedFilesDeleted} files deleted`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Storage cleanup failed';
        return reply.status(500).send({ error: 'Internal Server Error', message });
      }
    }
  );

  // GET /admin/storage/stats - storage statistics
  fastify.get(
    '/stats',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['storage'],
        summary: 'Statystyki storage (SUPER_ADMIN)',
        response: { 200: { type: 'object' } },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        // Dry run aby zobaczyć statystyki bez usuwania
        const stats = await cleanupStorage({ dryRun: true });
        
        return reply.send({
          storage: {
            totalFiles: stats.totalFilesScanned,
            orphanedFiles: stats.orphanedFilesFound,
            potentialSavings: `${(stats.spaceSavedBytes / 1024 / 1024).toFixed(2)} MB`,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get storage stats';
        return reply.status(500).send({ error: 'Internal Server Error', message });
      }
    }
  );
}
