import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware, requireRole } from '../../middleware/auth.middleware';
import {
  cleanupStorage,
  MIN_FILE_AGE_MS,
  STORAGE_KIND_LABELS,
  type CleanupOptions,
} from '../../services/storage/cleanup-storage.service';
import {
  pruneJobHistory,
  COMPLETED_RETENTION_DAYS,
  FAILED_RETENTION_DAYS,
} from '../../services/maintenance/job-retention.service';
import { writeMaintenanceAuditLog } from '../../services/audit/audit-log.service';
import { InternalServerError } from '../../lib/errors';

/**
 * Usuniecie pliku jest nieodwracalne, wiec `confirm` jest OSOBNYM polem od
 * `dryRun`: samo `dryRun: false` nie wystarczy. Zadanie bez jawnego
 * potwierdzenia zawsze konczy sie symulacja - klikniecie na oslep, zly
 * skrypt czy powtorzony request niczego nie skasuja.
 */
interface CleanupBody extends CleanupOptions {
  confirm?: boolean;
}

export async function storageRoutes(fastify: FastifyInstance) {
  // Tylko SUPER_ADMIN
  const superAdminOnly = [authMiddleware(fastify), requireRole('SUPER_ADMIN')];

  // GET /admin/storage/overview - co zniknie, zanim ktokolwiek kliknie
  fastify.get(
    '/overview',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['storage'],
        summary: 'Podgląd czyszczenia: pliki i historia zadań (SUPER_ADMIN)',
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const [storage, jobs] = await Promise.all([
          cleanupStorage({ dryRun: true }),
          pruneJobHistory({ dryRun: true }),
        ]);

        return reply.send({
          storage: {
            totalFilesScanned: storage.totalFilesScanned,
            orphanedFilesFound: storage.orphanedFilesFound,
            spaceToFreeBytes: storage.spaceSavedBytes,
            skippedTooYoung: storage.skippedTooYoung,
            skippedProtected: storage.skippedProtected,
            byKind: storage.byKind.map((entry) => ({
              ...entry,
              label: STORAGE_KIND_LABELS[entry.kind],
            })),
            sample: storage.sample,
            errors: storage.errors,
          },
          jobs: {
            renderJobsToDelete: jobs.renderJobsDeleted,
            printJobsToDelete: jobs.printJobsDeleted,
          },
          rules: {
            minFileAgeHours: Math.round(MIN_FILE_AGE_MS / 3600000),
            completedRetentionDays: COMPLETED_RETENTION_DAYS,
            failedRetentionDays: FAILED_RETENTION_DAYS,
            protectedDirs: ['templates', 'fonts'],
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to get storage overview';
        throw new InternalServerError(message);
      }
    }
  );

  // POST /admin/storage/cleanup - usuniecie osieroconych plikow
  fastify.post<{ Body: CleanupBody }>(
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
            confirm: {
              type: 'boolean',
              description: 'Wymagane do faktycznego usunięcia. Bez tego zawsze symulacja.',
            },
            olderThanDays: {
              type: 'integer',
              minimum: 1,
              description: 'Dodatkowy próg wieku ponad wymuszone 24 h',
            },
          },
        },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request: FastifyRequest<{ Body: CleanupBody }>, reply: FastifyReply) => {
      try {
        const body = request.body || {};
        // Symulacja jest domyslna: usuwamy tylko na wyrazne zadanie.
        const dryRun = body.confirm !== true || body.dryRun === true;

        const stats = await cleanupStorage({ ...body, dryRun });

        if (!dryRun) {
          await writeMaintenanceAuditLog(request, 'STORAGE_CLEANUP', {
            filesDeleted: stats.orphanedFilesDeleted,
            bytesFreed: stats.spaceSavedBytes,
            byKind: stats.byKind,
            sample: stats.sample,
            olderThanDays: body.olderThanDays ?? null,
            errors: stats.errors.length,
          });
        }

        return reply.send({
          success: true,
          dryRun,
          stats,
          message: dryRun
            ? `Symulacja: do usunięcia ${stats.orphanedFilesFound} plików`
            : `Usunięto ${stats.orphanedFilesDeleted} plików`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Storage cleanup failed';
        throw new InternalServerError(message);
      }
    }
  );

  // POST /admin/storage/prune-jobs - retencja historii zadan
  fastify.post<{ Body: { confirm?: boolean } }>(
    '/prune-jobs',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['storage'],
        summary: 'Usuń starą historię zadań renderowania i druku (SUPER_ADMIN)',
        body: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', description: 'Bez tego tylko symulacja' },
          },
        },
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (request: FastifyRequest<{ Body: { confirm?: boolean } }>, reply: FastifyReply) => {
      try {
        const dryRun = request.body?.confirm !== true;
        const stats = await pruneJobHistory({ dryRun });

        if (!dryRun) {
          await writeMaintenanceAuditLog(request, 'JOB_HISTORY_PRUNE', {
            renderJobsDeleted: stats.renderJobsDeleted,
            printJobsDeleted: stats.printJobsDeleted,
            completedRetentionDays: COMPLETED_RETENTION_DAYS,
            failedRetentionDays: FAILED_RETENTION_DAYS,
          });
        }

        return reply.send({
          success: true,
          dryRun,
          stats,
          message: dryRun
            ? `Symulacja: do usunięcia ${stats.renderJobsDeleted + stats.printJobsDeleted} rekordów`
            : `Usunięto ${stats.renderJobsDeleted + stats.printJobsDeleted} rekordów`,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Job history prune failed';
        throw new InternalServerError(message);
      }
    }
  );

  // GET /admin/storage/stats - zachowane dla zgodnosci ze starszym panelem
  fastify.get(
    '/stats',
    {
      preHandler: superAdminOnly,
      schema: {
        tags: ['storage'],
        summary: 'Statystyki storage (SUPER_ADMIN)',
        response: { 200: { type: 'object', additionalProperties: true } },
      },
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
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
        throw new InternalServerError(message);
      }
    }
  );
}
