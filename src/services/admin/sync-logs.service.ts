import prisma from '../../lib/prisma';
import type { SyncLogItem } from '../../types';

export async function getSyncLogs(limit: number): Promise<SyncLogItem[]> {
  const logs = await (prisma as any).syncLog.findMany({
    take: limit,
    orderBy: { startedAt: 'desc' },
    include: {
      shop: {
        select: {
          name: true,
        },
      },
    },
  });

  return logs.map((log: any) => ({
    id: log.id,
    shopName: log.shop.name,
    syncType: log.syncType,
    status: log.status,
    ordersFetched: log.ordersFetched,
    ordersCreated: log.ordersCreated,
    ordersSkipped: log.ordersSkipped,
    errorMessage: log.errorMessage,
    startedAt: log.startedAt,
    finishedAt: log.finishedAt,
  }));
}
