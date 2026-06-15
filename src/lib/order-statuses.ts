export const ORDER_OPERATIONAL_STATUSES = [
  'NEW',
  'PAID',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'PARTIALLY_RETURNED',
  'RETURNED',
] as const;

export type OrderOperationalStatus = typeof ORDER_OPERATIONAL_STATUSES[number];

export const ACTIVE_ORDER_OPERATIONAL_STATUSES: OrderOperationalStatus[] = [
  'NEW',
  'PAID',
  'PROCESSING',
  'PACKED',
  'SHIPPED',
  'DELIVERED',
];

export const STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES: OrderOperationalStatus[] = [
  'PAID',
  'PROCESSING',
  'PACKED',
];

export const RETURN_ORDER_OPERATIONAL_STATUSES: OrderOperationalStatus[] = [
  'PARTIALLY_RETURNED',
  'RETURNED',
];

export const INACTIVE_ORDER_OPERATIONAL_STATUSES: OrderOperationalStatus[] = [
  'CANCELLED',
  ...RETURN_ORDER_OPERATIONAL_STATUSES,
];

export const ORDER_OPERATIONAL_STATUS_DEFINITIONS: Record<OrderOperationalStatus, {
  label: string;
  color: string;
  flowOrder: number | null;
  isActive: boolean;
}> = {
  NEW: { label: 'Nowe', color: 'slate', flowOrder: 1, isActive: true },
  PAID: { label: 'Oplacone', color: 'blue', flowOrder: 2, isActive: true },
  PROCESSING: { label: 'W realizacji', color: 'amber', flowOrder: 3, isActive: true },
  PACKED: { label: 'Spakowane', color: 'violet', flowOrder: 4, isActive: true },
  SHIPPED: { label: 'Wyslane', color: 'cyan', flowOrder: 5, isActive: true },
  DELIVERED: { label: 'Dostarczone', color: 'green', flowOrder: 6, isActive: true },
  CANCELLED: { label: 'Anulowane', color: 'red', flowOrder: null, isActive: false },
  PARTIALLY_RETURNED: { label: 'Zwrot czesciowy', color: 'rose', flowOrder: null, isActive: false },
  RETURNED: { label: 'Zwrot', color: 'rose', flowOrder: null, isActive: false },
};

const LEGACY_ORDER_STATUS_ALIASES: Record<string, OrderOperationalStatus> = {
  IN_PROGRESS: 'PROCESSING',
  READY_FOR_PRODUCTION: 'PROCESSING',
  SENT_TO_PRODUCTION: 'PROCESSING',
  READY_TO_INVOICE: 'PROCESSING',
  INVOICED: 'PROCESSING',
  READY_TO_SHIP: 'PACKED',
  COMPLETED: 'DELIVERED',
  RETURN: 'RETURNED',
};

const PRESTASHOP_DEFAULT_STATUS_ALIASES: Record<string, OrderOperationalStatus> = {
  '2': 'PAID',
  '3': 'PROCESSING',
  '4': 'SHIPPED',
  '5': 'DELIVERED',
  '6': 'CANCELLED',
  '7': 'RETURNED',
  '9': 'PAID',
  '11': 'PAID',
  '15': 'PARTIALLY_RETURNED',
};

function normalizeStatusLabel(value: unknown) {
  return typeof value === 'string'
    ? value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase()
    : '';
}

function inferOperationalStatusFromName(value: unknown): OrderOperationalStatus | null {
  const label = normalizeStatusLabel(value);
  if (!label) return null;

  if (label.includes('czesciowy zwrot') || label.includes('partial refund')) return 'PARTIALLY_RETURNED';
  if (label.includes('zwrocon') || label.includes('refund')) return 'RETURNED';
  if (label.includes('anulowan') || label.includes('cancel')) return 'CANCELLED';
  if (label.includes('dostarczone') || label.includes('delivered')) return 'DELIVERED';
  if (label.includes('dostarczane') || label.includes('wyslan') || label.includes('shipped')) return 'SHIPPED';
  if (label.includes('przygotowanie') || label.includes('realizacji') || label.includes('processing')) return 'PROCESSING';
  if (
    label.includes('zaakceptowan') ||
    label.includes('przyjeta') ||
    label.includes('oplacone') ||
    label.includes('paid')
  ) {
    return 'PAID';
  }

  return null;
}

export function isOrderOperationalStatus(value: unknown): value is OrderOperationalStatus {
  return typeof value === 'string' && (ORDER_OPERATIONAL_STATUSES as readonly string[]).includes(value);
}

export function normalizeOrderOperationalStatus(value: unknown): OrderOperationalStatus | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (isOrderOperationalStatus(normalized)) return normalized;
  return LEGACY_ORDER_STATUS_ALIASES[normalized] ?? null;
}

export function assertOrderOperationalStatus(value: unknown): OrderOperationalStatus {
  const status = normalizeOrderOperationalStatus(value);
  if (!status) {
    throw new Error(`Nieprawidlowy status zamowienia: ${String(value)}`);
  }
  return status;
}

export function isActiveOrderOperationalStatus(value: unknown): boolean {
  const status = normalizeOrderOperationalStatus(value);
  return Boolean(status && ACTIVE_ORDER_OPERATIONAL_STATUSES.includes(status));
}

export function isStockReservationOrderOperationalStatus(value: unknown): boolean {
  const status = normalizeOrderOperationalStatus(value);
  return Boolean(status && STOCK_RESERVATION_ORDER_OPERATIONAL_STATUSES.includes(status));
}

export function isReturnedOrderOperationalStatus(value: unknown): boolean {
  const status = normalizeOrderOperationalStatus(value);
  return Boolean(status && RETURN_ORDER_OPERATIONAL_STATUSES.includes(status));
}

export function inferOperationalStatusFromShopStatus(status: {
  externalStatusId?: string | number | null;
  name?: string | null;
  operationalStatus?: string | null;
  isPaid?: boolean | null;
  isCancelled?: boolean | null;
  shipped?: boolean | null;
  delivery?: boolean | null;
} | null | undefined): OrderOperationalStatus {
  const mapped = normalizeOrderOperationalStatus(status?.operationalStatus);
  if (mapped) return mapped;
  const named = inferOperationalStatusFromName(status?.name);
  if (named) return named;
  if (status?.isCancelled) return 'CANCELLED';
  if (status?.delivery) return 'DELIVERED';
  if (status?.shipped) return 'SHIPPED';
  if (status?.isPaid) return 'PAID';
  const externalAlias = status?.externalStatusId == null
    ? null
    : PRESTASHOP_DEFAULT_STATUS_ALIASES[String(status.externalStatusId)];
  if (externalAlias) return externalAlias;
  return 'NEW';
}
