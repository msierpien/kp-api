import prisma from '../../lib/prisma';
import { PRINT_JOB_FINAL_STATUSES } from '../../lib/print-job-statuses';

/**
 * Retencja historii zadan.
 *
 * `RenderJob` i `PrintJob` rosly bez zadnego ograniczenia - nic ich nie
 * kasowalo. Przy setkach sztuk na zamowienie tabele pucznieja szybciej niz
 * cokolwiek innego w bazie, a wartosc rekordu sprzed pol roku jest zerowa.
 *
 * Zadania nieukonczone zostaja ZAWSZE, niezaleznie od wieku: zalegly
 * `QUEUED` sprzed miesiaca to sygnal, ze cos nie dziala, a nie smiec.
 */

/** Ile trzymamy zakonczone pomyslnie - tyle, ile realnie ktos patrzy wstecz. */
export const COMPLETED_RETENTION_DAYS = 30;

/** Bledy trzymamy dluzej - z nich sie diagnozuje. */
export const FAILED_RETENTION_DAYS = 90;

export interface JobRetentionStats {
  renderJobsDeleted: number;
  printJobsDeleted: number;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Kasuje historie zadan starsza niz progi retencji.
 *
 * `dryRun` liczy, ile rekordow poszloby do usuniecia, ale niczego nie rusza -
 * ta sama umowa co przy czyszczeniu plikow.
 */
export async function pruneJobHistory(options: { dryRun?: boolean } = {}): Promise<JobRetentionStats> {
  const { dryRun = false } = options;

  const completedBefore = daysAgo(COMPLETED_RETENTION_DAYS);
  const failedBefore = daysAgo(FAILED_RETENTION_DAYS);

  const renderWhere = {
    OR: [
      { status: 'COMPLETED', createdAt: { lt: completedBefore } },
      { status: 'FAILED', createdAt: { lt: failedBefore } },
    ],
  };

  // Tylko statusy koncowe - zadanie w kolejce albo drukujace sie zostaje.
  const printWhere = {
    OR: [
      {
        status: { in: PRINT_JOB_FINAL_STATUSES.filter((status) => status !== 'FAILED') },
        createdAt: { lt: completedBefore },
      },
      { status: 'FAILED', createdAt: { lt: failedBefore } },
    ],
  };

  if (dryRun) {
    const [renderJobsDeleted, printJobsDeleted] = await Promise.all([
      prisma.renderJob.count({ where: renderWhere }),
      prisma.printJob.count({ where: printWhere }),
    ]);
    return { renderJobsDeleted, printJobsDeleted };
  }

  const [renderResult, printResult] = await Promise.all([
    prisma.renderJob.deleteMany({ where: renderWhere }),
    prisma.printJob.deleteMany({ where: printWhere }),
  ]);

  return {
    renderJobsDeleted: renderResult.count,
    printJobsDeleted: printResult.count,
  };
}
