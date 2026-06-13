import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import type { StatsResponse } from '../../types';

type IntegrationHealth = NonNullable<StatsResponse['integrationHealth']>[number]['health'];

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function tenantCaseWhere(tenantId: string | null, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    ...(tenantId ? { order: { shop: { tenantId } } } : {}),
  };
}

function tenantOrderWhere(tenantId: string | null, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    ...(tenantId ? { shop: { tenantId } } : {}),
  };
}

function tenantDirectWhere(tenantId: string | null, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    ...(tenantId ? { tenantId } : {}),
  };
}

export async function getStats(): Promise<StatsResponse> {
  const tenantId = getTenantId();
  const today = startOfToday();
  const staleCaseDate = new Date(Date.now() - 48 * 60 * 60 * 1000);

  const [
    newCases,
    waitingCases,
    submittedCases,
    readyForPrintCases,
    totalCases,
    staleCases,
    todayOrders,
    todayRevenue,
    ordersToShip,
    lowStockProducts,
    failedStockSyncLogs,
    failedPriceSyncLogs,
    failedRenderJobs,
    failedQueues,
    shops,
    recentSyncLogs,
    recentAutomations,
    recentDocuments,
  ] = await Promise.all([
    prisma.personalizationCase.count({ where: tenantCaseWhere(tenantId, { status: 'NEW' }) }),
    prisma.personalizationCase.count({ where: tenantCaseWhere(tenantId, { status: 'WAITING_FOR_CUSTOMER' }) }),
    prisma.personalizationCase.count({ where: tenantCaseWhere(tenantId, { status: 'SUBMITTED' }) }),
    prisma.personalizationCase.count({ where: tenantCaseWhere(tenantId, { status: 'READY_FOR_PRINT' }) }),
    prisma.personalizationCase.count({ where: tenantCaseWhere(tenantId) }),
    prisma.personalizationCase.count({
      where: tenantCaseWhere(tenantId, {
        status: { in: ['NEW', 'WAITING_FOR_CUSTOMER'] },
        createdAt: { lt: staleCaseDate },
      }),
    }),
    prisma.order.count({ where: tenantOrderWhere(tenantId, { createdAtShop: { gte: today } }) }),
    prisma.order.aggregate({
      where: tenantOrderWhere(tenantId, { createdAtShop: { gte: today } }),
      _sum: { totalPaid: true },
    }),
    prisma.order.count({
      where: tenantOrderWhere(tenantId, {
        operationalStatus: { in: ['NEW', 'IN_PROGRESS', 'READY_FOR_PRODUCTION'] },
      }),
    }),
    prisma.warehouseProduct.count({
      where: tenantDirectWhere(tenantId, {
        isActive: true,
        currentStock: { lte: 1 },
      }),
    }),
    prisma.stockSyncLog.count({ where: tenantDirectWhere(tenantId, { status: 'FAILED' }) }),
    prisma.priceSyncLog.count({ where: tenantDirectWhere(tenantId, { status: 'FAILED' }) }),
    prisma.renderJob.count({
      where: {
        status: 'FAILED',
        ...(tenantId ? { case: { order: { shop: { tenantId } } } } : {}),
      },
    }),
    Promise.resolve(0),
    prisma.shop.findMany({
      where: tenantDirectWhere(tenantId),
      include: {
        syncLogs: { orderBy: { startedAt: 'desc' }, take: 1 },
        _count: {
          select: {
            orders: true,
            productMappings: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 8,
    }),
    prisma.syncLog.findMany({
      where: tenantId ? { shop: { tenantId } } : {},
      include: { shop: { select: { name: true } } },
      orderBy: { startedAt: 'desc' },
      take: 6,
    }),
    prisma.automation.findMany({
      where: tenantDirectWhere(tenantId, { lastRunAt: { not: null } }),
      orderBy: { lastRunAt: 'desc' },
      take: 6,
    }),
    prisma.warehouseDocument.findMany({
      where: tenantDirectWhere(tenantId, { status: 'CONFIRMED' }),
      orderBy: { updatedAt: 'desc' },
      take: 6,
    }),
  ]);

  const integrationHealth = shops.map((shop) => {
    const latestSync = shop.syncLogs[0] ?? null;
    const isManual = shop.platform === 'MANUAL';
    const hasError = latestSync?.status === 'FAILED';
    const health: IntegrationHealth = isManual ? 'manual' : hasError ? 'error' : shop.status === 'ACTIVE' ? 'connected' : 'inactive';
    return {
      id: shop.id,
      name: shop.name,
      platform: shop.platform,
      status: shop.status,
      health,
      message: isManual
        ? 'Źródło ręczne'
        : hasError
          ? latestSync?.errorMessage || 'Błąd ostatniej synchronizacji'
          : shop.status === 'ACTIVE'
            ? 'Połączony'
            : 'Nieaktywny',
      lastSyncAt: shop.lastSyncAt,
      ordersCount: shop._count.orders,
      mappingsCount: shop._count.productMappings,
      latestSyncStatus: latestSync?.status ?? null,
    };
  });

  const recentActivity = [
    ...recentSyncLogs.map((log) => ({
      id: `sync-${log.id}`,
      type: 'sync',
      tone: log.status === 'FAILED' ? 'red' : 'green',
      title: `Synchronizacja ${log.shop.name}`,
      description: `${log.ordersCreated} nowych zamówień, ${log.ordersSkipped} pominiętych`,
      occurredAt: log.finishedAt ?? log.startedAt,
      href: '/sync-logs',
    })),
    ...recentAutomations.map((automation) => ({
      id: `automation-${automation.id}`,
      type: 'automation',
      tone: automation.lastErrorAt ? 'red' : 'green',
      title: `Automatyzacja "${automation.name}"`,
      description: automation.lastErrorMessage || `Uruchomiona ${automation.runCount} razy`,
      occurredAt: automation.lastRunAt ?? automation.updatedAt,
      href: '/automations',
    })),
    ...recentDocuments.map((document) => ({
      id: `document-${document.id}`,
      type: 'document',
      tone: 'green',
      title: `Dokument ${document.number} zatwierdzony`,
      description: document.type,
      occurredAt: document.confirmedAt ?? document.updatedAt,
      href: `/warehouse/documents/${document.id}`,
    })),
  ]
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 8);

  const actionRequired = staleCases + ordersToShip + lowStockProducts + failedStockSyncLogs + failedPriceSyncLogs + failedRenderJobs;

  return {
    newCases,
    waitingCases,
    submittedCases,
    readyForPrintCases,
    totalCases,
    actionRequired,
    operations: {
      staleCases,
      ordersToShip,
      lowStockProducts,
      failedSyncs: failedStockSyncLogs + failedPriceSyncLogs,
      failedRenderJobs,
      failedQueues,
    },
    kpis: {
      todayOrders,
      todayRevenue: Number(todayRevenue._sum.totalPaid ?? 0),
      newCases,
      submittedCases,
      readyForPrintCases,
    },
    integrationHealth,
    recentActivity,
  };
}
