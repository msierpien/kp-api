import prisma from '../../lib/prisma';
import {
  isShippedOrderOperationalStatus,
  isStockReservationOrderOperationalStatus,
  normalizeOrderOperationalStatus,
  RETURN_ORDER_OPERATIONAL_STATUSES,
} from '../../lib/order-statuses';

/**
 * Skutki magazynowe zmiany statusu zamowienia — jedna logika dla webhooka,
 * crona synchronizacji i recznej zmiany w panelu. Kazda sciezka, ktora zapisuje
 * `operationalStatus`, powinna przejsc przez `applyOrderStatusWarehouseEffects`,
 * inaczej rezerwacje i WZ rozjezdzaja sie ze stanem faktycznym.
 */

export type OrderStatusWarehouseAction = 'RESERVE' | 'FINALIZE_SHIPMENT' | 'RELEASE' | 'NONE';

const RELEASING_STATUSES = new Set<string>(['CANCELLED', ...RETURN_ORDER_OPERATIONAL_STATUSES]);

/**
 * Czysta funkcja decyzyjna. `NONE` dla NEW i statusow niezmapowanych — fallback
 * na 'NEW' przy nieznanym statusie sklepu NIE moze zwalniac rezerwacji oplaconego
 * zamowienia (to byl realny bug: kazdy niestandardowy status PrestaShop zwalnial stan).
 */
export function resolveWarehouseActionForStatus(
  status: unknown,
  options: { forceRelease?: boolean } = {},
): OrderStatusWarehouseAction {
  if (isShippedOrderOperationalStatus(status)) return 'FINALIZE_SHIPMENT';

  const normalized = normalizeOrderOperationalStatus(status);
  if (normalized && RELEASING_STATUSES.has(normalized)) return 'RELEASE';
  // Jawna konfiguracja sklepu (releaseStatusIds) moze wymusic zwolnienie
  // niezaleznie od zmapowanego statusu operacyjnego.
  if (options.forceRelease) return 'RELEASE';

  if (isStockReservationOrderOperationalStatus(status)) return 'RESERVE';

  return 'NONE';
}

export interface OrderStatusWarehouseEffectsResult {
  action: OrderStatusWarehouseAction;
  /** Ostrzezenia do pokazania/zalogowania — np. zatwierdzony WZ przy anulacji. */
  warnings: string[];
  errors: string[];
}

export async function applyOrderStatusWarehouseEffects(
  orderId: string,
  status: unknown,
  options: { forceRelease?: boolean } = {},
): Promise<OrderStatusWarehouseEffectsResult> {
  const action = resolveWarehouseActionForStatus(status, options);
  const result: OrderStatusWarehouseEffectsResult = { action, warnings: [], errors: [] };

  // Importy dynamiczne lamia cykl: warehouse-documents -> ... -> ten modul.
  const { createWzForOrder, finalizeOrderShipment, shouldAutoCreateWzForTenant } = await import('../admin/warehouse-documents.service');
  const { releaseOrderReservations, reserveOrder } = await import('../admin/warehouse-reservations.service');

  try {
    switch (action) {
      case 'RESERVE': {
        await reserveOrder(orderId);
        const order = await prisma.order.findUnique({
          where: { id: orderId },
          select: { shop: { select: { tenantId: true } } },
        });
        if (order && await shouldAutoCreateWzForTenant(order.shop.tenantId)) {
          await createWzForOrder(orderId);
        }
        break;
      }
      case 'FINALIZE_SHIPMENT': {
        const shipment = await finalizeOrderShipment(orderId);
        if (shipment.status === 'FAILED') {
          result.errors.push(`WZ nie zostało zamknięte przy wysyłce: ${shipment.reason}`);
        }
        break;
      }
      case 'RELEASE': {
        // Zwalniamy tylko ACTIVE. Zatwierdzonego WZ nie cofamy automatycznie —
        // przywrocenie towaru to swiadoma decyzja w module zwrotow.
        const confirmedWz = await prisma.warehouseDocument.count({
          where: { orderId, type: 'WZ', status: 'CONFIRMED' },
        });
        await releaseOrderReservations(orderId);
        if (confirmedWz > 0) {
          result.warnings.push('Zamówienie ma zatwierdzony WZ — towar wróci na stan dopiero po obsłużeniu zwrotu');
        }
        break;
      }
      case 'NONE':
        break;
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : 'Nie udało się zastosować skutków magazynowych statusu');
  }

  return result;
}
