import prisma from '../../lib/prisma';
import type { StatsResponse } from '../../types';

export async function getStats(): Promise<StatsResponse> {
  const [newCases, waitingCases, submittedCases, readyForPrintCases, totalCases] = await Promise.all([
    prisma.personalizationCase.count({
      where: { status: 'NEW' },
    }),
    prisma.personalizationCase.count({
      where: { status: 'WAITING_FOR_CUSTOMER' },
    }),
    prisma.personalizationCase.count({
      where: { status: 'SUBMITTED' },
    }),
    prisma.personalizationCase.count({
      where: { status: 'READY_FOR_PRINT' },
    }),
    prisma.personalizationCase.count(),
  ]);

  return {
    newCases,
    waitingCases,
    submittedCases,
    readyForPrintCases,
    totalCases,
  };
}
