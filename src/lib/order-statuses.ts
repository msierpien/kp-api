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

export function isReturnedOrderOperationalStatus(value: unknown): boolean {
  const status = normalizeOrderOperationalStatus(value);
  return Boolean(status && RETURN_ORDER_OPERATIONAL_STATUSES.includes(status));
}

export function inferOperationalStatusFromShopStatus(status: {
  operationalStatus?: string | null;
  isPaid?: boolean | null;
  isCancelled?: boolean | null;
} | null | undefined): OrderOperationalStatus {
  const mapped = normalizeOrderOperationalStatus(status?.operationalStatus);
  if (mapped) return mapped;
  if (status?.isCancelled) return 'CANCELLED';
  if (status?.isPaid) return 'PAID';
  return 'NEW';
}
