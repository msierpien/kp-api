import cron from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import prisma from '../../lib/prisma';
import { syncShopOrders, type SyncResult } from '../sync/sync-orders.service';
import { cleanupStorage } from '../storage/cleanup-storage.service';
import { syncWholesaleProviderForTenant } from '../admin/wholesale.service';
import { reconcilePrestaShopForTenant } from '../prestashop/prestashop-reconciliation.service';
import { syncStockForShop } from '../stock/stock-sync.service';
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
const ACTIVE_WHOLESALE_SYNC_STATUSES = ['PENDING', 'PROCESSING'] as const;
const DAILY_INVENTORY_WARNING =
  'Synchronizacja hurtowni była jeszcze w toku; opublikowano najnowsze zakończone dane hurtowni.';

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
    const [shops, wholesaleProviders] = await Promise.all([
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
    ]);

    shops.forEach((shop) => {
      scheduleShopSync(shop.id, shop.name, shop.syncInterval);
    });

    wholesaleProviders.forEach((provider) => {
      scheduleWholesaleSync(provider.id, provider.name, provider.tenantId, provider.syncInterval);
    });

    console.log(
      `[Scheduler] ✅ Initialized ${shops.length} shop sync schedules and ` +
      `${wholesaleProviders.length} wholesale sync schedules`
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

    const activeWholesaleSyncs = await prisma.wholesaleSyncLog.count({
      where: {
        status: { in: [...ACTIVE_WHOLESALE_SYNC_STATUSES] },
        provider: {
          isActive: true,
          syncEnabled: true,
          platform: 'CSV_FEED',
        },
      },
    });

    const warningMessage = activeWholesaleSyncs > 0 ? DAILY_INVENTORY_WARNING : undefined;
    if (warningMessage) {
      console.warn(`[Scheduler] ⚠️ ${warningMessage} Aktywne logi hurtowni: ${activeWholesaleSyncs}`);
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
        const result = await syncStockForShop(shop.id, 'SCHEDULED', { warningMessage });
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
  
  return {
    totalScheduled: scheduledTasks.size + scheduledWholesaleTasks.size,
    shops: status,
    wholesaleProviders: wholesaleStatus,
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
