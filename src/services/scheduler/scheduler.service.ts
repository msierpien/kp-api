import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import prisma from '../../lib/prisma';
import { syncShopOrders, type SyncResult } from '../sync/sync-orders.service';
import { cleanupStorage } from '../storage/cleanup-storage.service';
import { syncWholesaleProviderForTenant } from '../admin/wholesale.service';
import { reconcilePrestaShopForTenant } from '../prestashop/prestashop-reconciliation.service';
import { syncStockForShop } from '../stock/stock-sync.service';
import { runCompetitorPriceAutomationForTenant } from '../admin/competitor-analytics.service';
// BullMQ Worker automatycznie przetwarza RenderJobs - nie potrzebujemy crona

/**
 * Mapa aktywnych zadań cron per sklep
 * Key: shopId, Value: ScheduledTask
 */
const scheduledTasks = new Map<string, ScheduledTask>();

/**
 * Mapa aktywnych zadań cron per hurtownia
 * Key: providerId, Value: ScheduledTask
 */
const scheduledWholesaleTasks = new Map<string, ScheduledTask>();
const scheduledCompetitorPriceTasks = new Map<string, ScheduledTask>();
const ACTIVE_WHOLESALE_SYNC_STATUSES = ['PENDING', 'PROCESSING'] as const;
const DAILY_INVENTORY_WHOLESALE_WAIT_TIMEOUT_MS = 30 * 60_000;
const DAILY_INVENTORY_WHOLESALE_WAIT_INTERVAL_MS = 10_000;
const DAILY_INVENTORY_BLOCKED_WARNING =
  'Synchronizacja hurtowni nadal trwa; pominięto dzienną publikację stanów, żeby nie wysłać nieaktualnych danych.';

/**
 * Konwersja interwału (w minutach) na cron expression
 * Przykłady:
 * - 5 minut
 * - 15 minut
 * - 30 minut
 * - 60 minut (co godzinę)
 */
function intervalToCron(intervalMinutes: number): string {
  if (intervalMinutes >= 60 && intervalMinutes % 60 === 0) {
    const hours = intervalMinutes / 60;
    if (hours === 1) {
      return '0 * * * *'; // co godzinę
    }
    return `0 */${hours} * * *`; // co X godzin
  }
  
  return `*/${intervalMinutes} * * * *`; // co X minut
}

/**
 * Uruchamia synchronizację dla konkretnego sklepu
 */
async function runShopSync(shopId: string, shopName: string) {
  const startTime = new Date();
  console.log(`[Scheduler] 🔄 Starting automatic sync for shop: ${shopName} (${shopId})`);
  
  try {
    const result = await syncShopOrders(shopId);
    
    const duration = Date.now() - startTime.getTime();
    console.log(
      `[Scheduler] ✅ Sync completed for ${shopName}: ` +
      `${result.ordersCreated} created, ${result.ordersSkipped} skipped ` +
      `(${duration}ms)`
    );
  } catch (error) {
    const duration = Date.now() - startTime.getTime();
    console.error(
      `[Scheduler] ❌ Sync failed for ${shopName} after ${duration}ms:`,
      error
    );
  }
}

/**
 * Scheduleuje zadanie synchronizacji dla sklepu
 */
function scheduleShopSync(shopId: string, shopName: string, intervalMinutes: number) {
  // Usuń istniejące zadanie jeśli istnieje
  stopShopSync(shopId);
  
  const cronExpression = intervalToCron(intervalMinutes);
  
  const task = cron.schedule(
    cronExpression,
    () => {
      runShopSync(shopId, shopName);
    },
    { timezone: 'Europe/Warsaw' }
  );
  
  scheduledTasks.set(shopId, task);
  
  console.log(
    `[Scheduler] 📅 Scheduled sync for ${shopName}: every ${intervalMinutes} min (${cronExpression})`
  );
}

/**
 * Zatrzymuje synchronizację dla sklepu
 */
function stopShopSync(shopId: string) {
  const task = scheduledTasks.get(shopId);
  if (task) {
    task.stop();
    scheduledTasks.delete(shopId);
    console.log(`[Scheduler] 🛑 Stopped sync for shop: ${shopId}`);
  }
}

export function removeShopFromScheduler(shopId: string) {
  stopShopSync(shopId);
}

async function runWholesaleSync(providerId: string, providerName: string, tenantId: string) {
  const startTime = new Date();
  console.log(`[Scheduler] 🔄 Enqueueing automatic wholesale sync for: ${providerName} (${providerId})`);

  try {
    const result = await syncWholesaleProviderForTenant(providerId, tenantId);
    const duration = Date.now() - startTime.getTime();
    console.log(
      `[Scheduler] ✅ Wholesale sync enqueued for ${providerName}: ` +
      `log ${result.id}, status ${result.status} ` +
      `(${duration}ms)`
    );
  } catch (error) {
    const duration = Date.now() - startTime.getTime();
    console.error(
      `[Scheduler] ❌ Wholesale sync failed for ${providerName} after ${duration}ms:`,
      error
    );
  }
}

function scheduleWholesaleSync(providerId: string, providerName: string, tenantId: string, intervalMinutes: number) {
  stopWholesaleSync(providerId);

  const cronExpression = intervalToCron(intervalMinutes);
  const task = cron.schedule(
    cronExpression,
    () => {
      runWholesaleSync(providerId, providerName, tenantId);
    },
    { timezone: 'Europe/Warsaw' }
  );

  scheduledWholesaleTasks.set(providerId, task);

  console.log(
    `[Scheduler] 📅 Scheduled wholesale sync for ${providerName}: every ${intervalMinutes} min (${cronExpression})`
  );
}

function stopWholesaleSync(providerId: string) {
  const task = scheduledWholesaleTasks.get(providerId);
  if (task) {
    task.stop();
    scheduledWholesaleTasks.delete(providerId);
    console.log(`[Scheduler] 🛑 Stopped wholesale sync for provider: ${providerId}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countActiveWholesaleSyncs() {
  return prisma.wholesaleSyncLog.count({
    where: {
      status: { in: [...ACTIVE_WHOLESALE_SYNC_STATUSES] },
      provider: {
        isActive: true,
        syncEnabled: true,
        platform: 'CSV_FEED',
      },
    },
  });
}

async function waitForWholesaleSyncsToFinish() {
  const deadline = Date.now() + DAILY_INVENTORY_WHOLESALE_WAIT_TIMEOUT_MS;
  let activeWholesaleSyncs = await countActiveWholesaleSyncs();

  if (activeWholesaleSyncs > 0) {
    console.warn(
      `[Scheduler] ⏳ Waiting for wholesale syncs before inventory publication: ` +
      `${activeWholesaleSyncs} active`
    );
  }

  while (activeWholesaleSyncs > 0 && Date.now() < deadline) {
    await sleep(Math.min(DAILY_INVENTORY_WHOLESALE_WAIT_INTERVAL_MS, deadline - Date.now()));
    activeWholesaleSyncs = await countActiveWholesaleSyncs();
  }

  return activeWholesaleSyncs;
}

async function runCompetitorPriceAutomation(tenantId: string, shopId: string, shopName: string) {
  const startTime = new Date();
  console.log(`[Scheduler] 🔄 Starting competitor auto-pricing for ${shopName} (${shopId})`);
  try {
    const result = await runCompetitorPriceAutomationForTenant(tenantId, { trigger: 'SCHEDULED', shopId });
    const duration = Date.now() - startTime.getTime();
    console.log(
      `[Scheduler] ✅ Competitor auto-pricing completed for ${shopName}: ` +
      `status ${result.run.status}, applied ${result.run.applied}, synced ${result.run.synced}, skipped manual ${result.run.skippedManualOverrides} ` +
      `(${duration}ms)`
    );
  } catch (error) {
    const duration = Date.now() - startTime.getTime();
    console.error(`[Scheduler] ❌ Competitor auto-pricing failed for ${shopName} after ${duration}ms:`, error);
  }
}

function scheduleCompetitorPriceAutomation(tenantId: string, shopId: string, shopName: string, intervalMinutes: number) {
  stopCompetitorPriceAutomation(tenantId);
  const cronExpression = intervalToCron(intervalMinutes);
  const task = cron.schedule(
    cronExpression,
    () => {
      runCompetitorPriceAutomation(tenantId, shopId, shopName);
    },
    { timezone: 'Europe/Warsaw' },
  );
  scheduledCompetitorPriceTasks.set(tenantId, task);
  console.log(`[Scheduler] 📅 Scheduled competitor auto-pricing for ${shopName}: every ${intervalMinutes} min (${cronExpression})`);
}

function stopCompetitorPriceAutomation(tenantId: string) {
  const task = scheduledCompetitorPriceTasks.get(tenantId);
  if (task) {
    task.stop();
    scheduledCompetitorPriceTasks.delete(tenantId);
    console.log(`[Scheduler] 🛑 Stopped competitor auto-pricing for tenant: ${tenantId}`);
  }
}

export async function refreshCompetitorPriceAutomationSchedule(tenantId: string) {
  const settings = await prisma.warehousePricingSettings.findUnique({
    where: { tenantId },
    include: { competitorAutoPricingShop: { select: { id: true, name: true, status: true } } },
  });
  if (!settings?.competitorAutoPricingEnabled || !settings.competitorAutoPricingShop || settings.competitorAutoPricingShop.status !== 'ACTIVE') {
    stopCompetitorPriceAutomation(tenantId);
    return;
  }
  scheduleCompetitorPriceAutomation(
    tenantId,
    settings.competitorAutoPricingShop.id,
    settings.competitorAutoPricingShop.name,
    settings.competitorAutoPricingIntervalMinutes,
  );
}

export function removeWholesaleProviderFromScheduler(providerId: string) {
  stopWholesaleSync(providerId);
}

export async function refreshWholesaleProviderSchedule(providerId: string) {
  const provider = await prisma.wholesaleProvider.findUnique({
    where: { id: providerId },
    select: {
      id: true,
      tenantId: true,
      name: true,
      platform: true,
      syncEnabled: true,
      syncInterval: true,
      isActive: true,
    },
  });

  if (!provider || !provider.isActive || !provider.syncEnabled || provider.platform !== 'CSV_FEED') {
    stopWholesaleSync(providerId);
    return;
  }

  scheduleWholesaleSync(provider.id, provider.name, provider.tenantId, provider.syncInterval);
}

// UWAGA: Przetwarzanie RenderJobs jest teraz obsługiwane przez BullMQ Worker
// Nie potrzebujemy już crona do przetwarzania - worker automatycznie pobiera joby z kolejki Redis

/**
 * Inicjalizuje scheduler - ładuje wszystkie sklepy z auto-sync i scheduleuje
 */
export async function initializeScheduler() {
  console.log('[Scheduler] 🚀 Initializing order synchronization scheduler...');
  
  try {
    const [shops, wholesaleProviders, competitorAutoSettings] = await Promise.all([
      prisma.shop.findMany({
        where: {
          status: 'ACTIVE',
          syncEnabled: true,
          platform: { not: 'MANUAL' }, // MANUAL nie ma auto-sync
        },
        select: {
          id: true,
          name: true,
          syncInterval: true,
        },
      }),
      prisma.wholesaleProvider.findMany({
        where: {
          isActive: true,
          syncEnabled: true,
          platform: 'CSV_FEED',
        },
        select: {
          id: true,
          tenantId: true,
          name: true,
          syncInterval: true,
        },
      }),
      prisma.warehousePricingSettings.findMany({
        where: {
          competitorAutoPricingEnabled: true,
          competitorAutoPricingShopId: { not: null },
        },
        include: {
          competitorAutoPricingShop: { select: { id: true, name: true, status: true } },
        },
      }),
    ]);

    shops.forEach((shop) => {
      scheduleShopSync(shop.id, shop.name, shop.syncInterval);
    });

    wholesaleProviders.forEach((provider) => {
      scheduleWholesaleSync(provider.id, provider.name, provider.tenantId, provider.syncInterval);
    });

    competitorAutoSettings.forEach((settings) => {
      if (!settings.competitorAutoPricingShop || settings.competitorAutoPricingShop.status !== 'ACTIVE') return;
      scheduleCompetitorPriceAutomation(
        settings.tenantId,
        settings.competitorAutoPricingShop.id,
        settings.competitorAutoPricingShop.name,
        settings.competitorAutoPricingIntervalMinutes,
      );
    });

    console.log(
      `[Scheduler] ✅ Initialized ${shops.length} shop sync schedules and ` +
      `${wholesaleProviders.length} wholesale sync schedules and ` +
      `${competitorAutoSettings.length} competitor auto-pricing schedules`
    );
    
    // Scheduleuj storage cleanup - codziennie o 3:00
    scheduleStorageCleanup();
    schedulePrestaShopReconciliation();
    scheduleDailyInventoryPublication();
    
    console.log('[Scheduler] ℹ️  RenderJobs processing handled by BullMQ Worker');
  } catch (error) {
    console.error('[Scheduler] ❌ Failed to initialize scheduler:', error);
    throw error;
  }
}

/**
 * Storage cleanup - codziennie o 3:00
 */
function scheduleStorageCleanup() {
  cron.schedule(
    '0 3 * * *', // Codziennie o 3:00
    async () => {
      console.log('[Scheduler] 🧹 Starting automatic storage cleanup...');
      try {
        const stats = await cleanupStorage({
          dryRun: false,
          olderThanDays: 30, // Usuń orphaned files starsze niż 30 dni
          removeOrphanedOnly: true,
        });
        
        console.log(
          `[Scheduler] ✅ Storage cleanup complete: ` +
          `${stats.orphanedFilesDeleted} files deleted, ` +
          `${(stats.spaceSavedBytes / 1024 / 1024).toFixed(2)} MB saved`
        );
      } catch (error) {
        console.error('[Scheduler] ❌ Storage cleanup failed:', error);
      }
    },
    { timezone: 'Europe/Warsaw' }
  );
  
  console.log('[Scheduler] 📅 Scheduled storage cleanup: daily at 3:00 AM');
}

function schedulePrestaShopReconciliation() {
  cron.schedule(
    '15 2 * * *',
    async () => {
      console.log('[Scheduler] 🔎 Starting nightly PrestaShop reconciliation...');
      try {
        const shops = await prisma.shop.findMany({
          where: {
            status: 'ACTIVE',
            platform: 'PRESTASHOP',
            productMappings: {
              some: {
                isActive: true,
                warehouseProductId: { not: null },
              },
            },
          },
          select: {
            id: true,
            tenantId: true,
            name: true,
          },
        });

        let scanned = 0;
        let mismatches = 0;
        let errors = 0;

        for (const shop of shops) {
          const result = await reconcilePrestaShopForTenant(shop.tenantId, {
            shopId: shop.id,
            limit: 1000,
            includeInSync: false,
          });

          scanned += result.summary.scanned;
          mismatches += result.summary.mismatches;
          errors += result.summary.errors;

          if (result.summary.returned > 0) {
            console.warn(
              `[Scheduler] PrestaShop reconciliation for ${shop.name}: ` +
              `${result.summary.mismatches} mismatches, ${result.summary.errors} errors`
            );
          }
        }

        console.log(
          `[Scheduler] ✅ Nightly PrestaShop reconciliation completed: ` +
          `${scanned} scanned, ${mismatches} mismatches, ${errors} errors`
        );
      } catch (error) {
        console.error('[Scheduler] ❌ Nightly PrestaShop reconciliation failed:', error);
      }
    },
    { timezone: 'Europe/Warsaw' }
  );

  console.log('[Scheduler] 📅 Scheduled PrestaShop reconciliation: daily at 2:15 AM');
}

async function runDailyInventoryPublication() {
  const startTime = new Date();
  console.log('[Scheduler] 📦 Starting daily inventory publication...');

  try {
    const providers = await prisma.wholesaleProvider.findMany({
      where: {
        isActive: true,
        syncEnabled: true,
        platform: 'CSV_FEED',
      },
      select: {
        id: true,
        tenantId: true,
        name: true,
      },
      orderBy: { name: 'asc' },
    });

    let providerSyncErrors = 0;
    for (const provider of providers) {
      try {
        await syncWholesaleProviderForTenant(provider.id, provider.tenantId);
      } catch (error) {
        providerSyncErrors += 1;
        console.error(`[Scheduler] ❌ Failed to enqueue wholesale sync for ${provider.name}:`, error);
      }
    }

    const activeWholesaleSyncs = await waitForWholesaleSyncsToFinish();
    if (activeWholesaleSyncs > 0) {
      const duration = Date.now() - startTime.getTime();
      console.warn(
        `[Scheduler] ⚠️ ${DAILY_INVENTORY_BLOCKED_WARNING} ` +
        `Aktywne logi hurtowni: ${activeWholesaleSyncs}, czas=${duration}ms`
      );
      return;
    }

    const shops = await prisma.shop.findMany({
      where: {
        status: 'ACTIVE',
        platform: 'PRESTASHOP',
        productMappings: {
          some: {
            isActive: true,
            warehouseProductId: { not: null },
          },
        },
      },
      select: {
        id: true,
        name: true,
      },
      orderBy: { name: 'asc' },
    });

    let enqueued = 0;
    let shopErrors = 0;
    for (const shop of shops) {
      try {
        const result = await syncStockForShop(shop.id, 'SCHEDULED');
        enqueued += result.enqueued;
        console.log(`[Scheduler] 📤 Inventory publication queued for ${shop.name}: ${result.enqueued} jobs`);
      } catch (error) {
        shopErrors += 1;
        console.error(`[Scheduler] ❌ Inventory publication failed for ${shop.name}:`, error);
      }
    }

    const duration = Date.now() - startTime.getTime();
    console.log(
      `[Scheduler] ✅ Daily inventory publication completed: ` +
      `${providers.length} providers requested (${providerSyncErrors} errors), ` +
      `${shops.length} shops, ${enqueued} stock jobs (${shopErrors} errors), ` +
      `${duration}ms`
    );
  } catch (error) {
    console.error('[Scheduler] ❌ Daily inventory publication failed:', error);
  }
}

function scheduleDailyInventoryPublication() {
  cron.schedule(
    '30 5 * * *',
    () => {
      runDailyInventoryPublication();
    },
    { timezone: 'Europe/Warsaw' },
  );

  console.log('[Scheduler] 📅 Scheduled inventory publication: daily at 5:30 AM');
}

/**
 * Reload schedulera - przeładowuje wszystkie zadania
 * Użyj po zmianie konfiguracji sklepów
 */
export async function reloadScheduler() {
  console.log('[Scheduler] 🔄 Reloading scheduler...');
  
  // Zatrzymaj wszystkie istniejące zadania
  for (const [shopId] of scheduledTasks) {
    stopShopSync(shopId);
  }

  for (const [providerId] of scheduledWholesaleTasks) {
    stopWholesaleSync(providerId);
  }

  for (const [tenantId] of scheduledCompetitorPriceTasks) {
    stopCompetitorPriceAutomation(tenantId);
  }
  
  // Ponownie zainicjalizuj
  await initializeScheduler();
}

/**
 * Włącza synchronizację dla konkretnego sklepu
 */
export async function enableShopSync(shopId: string) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      name: true,
      syncInterval: true,
      platform: true,
    },
  });
  
  if (!shop) {
    throw new Error('Shop not found');
  }
  
  if (shop.platform === 'MANUAL') {
    throw new Error('Manual shops cannot have auto-sync enabled');
  }
  
  // Aktualizuj bazę
  await prisma.shop.update({
    where: { id: shopId },
    data: { syncEnabled: true },
  });
  
  // Scheduleuj
  scheduleShopSync(shopId, shop.name, shop.syncInterval);
}

/**
 * Wyłącza synchronizację dla konkretnego sklepu
 */
export async function disableShopSync(shopId: string) {
  // Aktualizuj bazę
  await prisma.shop.update({
    where: { id: shopId },
    data: { syncEnabled: false },
  });
  
  // Zatrzymaj zadanie
  stopShopSync(shopId);
}

/**
 * Aktualizuje interwał synchronizacji dla sklepu
 */
export async function updateShopSyncInterval(shopId: string, intervalMinutes: number) {
  if (intervalMinutes < 5) {
    throw new Error('Sync interval must be at least 5 minutes');
  }
  
  if (intervalMinutes > 1440) {
    throw new Error('Sync interval cannot exceed 24 hours (1440 minutes)');
  }
  
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      name: true,
      syncEnabled: true,
    },
  });
  
  if (!shop) {
    throw new Error('Shop not found');
  }
  
  // Aktualizuj bazę
  await prisma.shop.update({
    where: { id: shopId },
    data: { syncInterval: intervalMinutes },
  });
  
  // Jeśli sync jest włączony, przescheduleuj
  if (shop.syncEnabled) {
    scheduleShopSync(shopId, shop.name, intervalMinutes);
  }
}

/**
 * Zwraca status schedulera dla wszystkich sklepów
 */
export function getSchedulerStatus() {
  const status: Array<{
    shopId: string;
    isScheduled: boolean;
  }> = [];

  const wholesaleStatus: Array<{
    providerId: string;
    isScheduled: boolean;
  }> = [];

  const competitorPriceStatus: Array<{
    tenantId: string;
    isScheduled: boolean;
  }> = [];
  
  for (const [shopId, task] of scheduledTasks) {
    status.push({
      shopId,
      isScheduled: task !== undefined,
    });
  }

  for (const [providerId, task] of scheduledWholesaleTasks) {
    wholesaleStatus.push({
      providerId,
      isScheduled: task !== undefined,
    });
  }

  for (const [tenantId, task] of scheduledCompetitorPriceTasks) {
    competitorPriceStatus.push({
      tenantId,
      isScheduled: task !== undefined,
    });
  }
  
  return {
    totalScheduled: scheduledTasks.size + scheduledWholesaleTasks.size + scheduledCompetitorPriceTasks.size,
    shops: status,
    wholesaleProviders: wholesaleStatus,
    competitorAutoPricing: competitorPriceStatus,
  };
}

/**
 * Wymusza natychmiastową synchronizację dla sklepu (poza harmonogramem)
 */
export async function triggerManualSync(shopId: string, options: {
  wait?: boolean;
  fromDate?: string;
  fromOrderId?: string;
  limit?: number;
} = {}): Promise<SyncResult | {
  message: string;
  shopId: string;
}> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      name: true,
      status: true,
    },
  });

  if (!shop) {
    throw new Error('Shop not found');
  }

  if (shop.status !== 'ACTIVE') {
    throw new Error('Shop is not active');
  }

  const syncOptions = {
    fromDate: options.fromDate,
    fromOrderId: options.fromOrderId,
    limit: options.limit,
  };

  if (options.wait) {
    return syncShopOrders(shopId, syncOptions);
  }

  // Uruchom sync w tle (nie czekamy na zakończenie)
  void syncShopOrders(shopId, syncOptions).then((result) => {
    console.log(`[Scheduler] ✅ Background sync completed for ${shop.name}:`, result);
  }).catch((error) => {
    console.error(`[Scheduler] ❌ Background sync failed for ${shop.name}:`, error);
  });

  return {
    message: `Manual sync triggered for ${shop.name}`,
    shopId,
  };
}
