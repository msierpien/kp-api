import cron from 'node-cron';
import prisma from '../../lib/prisma';
import { syncOrdersForShop } from '../sync/sync-orders.service';

/**
 * Mapa aktywnych zadań cron per sklep
 * Key: shopId, Value: ScheduledTask
 */
const scheduledTasks = new Map<string, cron.ScheduledTask>();

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
    const result = await syncOrdersForShop(shopId);
    
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
    {
      scheduled: true,
      timezone: 'Europe/Warsaw',
    }
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

/**
 * Inicjalizuje scheduler - ładuje wszystkie sklepy z auto-sync i scheduleuje
 */
export async function initializeScheduler() {
  console.log('[Scheduler] 🚀 Initializing order synchronization scheduler...');
  
  try {
    // Pobierz wszystkie aktywne sklepy z włączonym auto-sync
    const shops = await prisma.shop.findMany({
      where: {
        status: 'ACTIVE',
        syncEnabled: true,
        platform: {
          not: 'MANUAL', // Sklepy manualne nie mają auto-sync
        },
      },
      select: {
        id: true,
        name: true,
        syncInterval: true,
      },
    });
    
    if (shops.length === 0) {
      console.log('[Scheduler] ℹ️  No shops configured for auto-sync');
      return;
    }
    
    // Scheduleuj każdy sklep
    for (const shop of shops) {
      scheduleShopSync(shop.id, shop.name, shop.syncInterval);
    }
    
    console.log(`[Scheduler] ✅ Initialized ${shops.length} shop sync schedules`);
  } catch (error) {
    console.error('[Scheduler] ❌ Failed to initialize scheduler:', error);
  }
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
  
  for (const [shopId, task] of scheduledTasks) {
    status.push({
      shopId,
      isScheduled: task !== undefined,
    });
  }
  
  return {
    totalScheduled: scheduledTasks.size,
    shops: status,
  };
}

/**
 * Wymusza natychmiastową synchronizację dla sklepu (poza harmonogramem)
 */
export async function triggerManualSync(shopId: string) {
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
  
  // Uruchom sync w tle (nie czekamy na zakończenie)
  runShopSync(shopId, shop.name);
  
  return {
    message: `Manual sync triggered for ${shop.name}`,
    shopId,
  };
}
