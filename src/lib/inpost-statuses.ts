/**
 * Statusy przesylek InPost. ShipX ma ich kilkadziesiat i dokłada nowe, wiec
 * warunki automatyzacji i filtry panelu opieramy na ETAPIE doreczenia, a nie
 * na surowej nazwie. Surowy status i tak zapisujemy — bez niego nie da sie
 * dojsc, dlaczego przesylka wpadla tam, gdzie wpadla.
 */

export const SHIPMENT_STAGES = [
  'CREATED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'READY_TO_PICKUP',
  'PICKUP_REMINDER',
  'DELIVERED',
  'PROBLEM',
  'RETURNED',
  'CANCELLED',
  'UNKNOWN',
] as const;

export type ShipmentStage = typeof SHIPMENT_STAGES[number];

export const SHIPMENT_STAGE_DEFINITIONS: Record<ShipmentStage, {
  label: string;
  description: string;
  color: string;
  /** Etap koncowy: przesylki w nim nie odpytujemy juz przy synchronizacji. */
  isFinal: boolean;
}> = {
  CREATED: {
    label: 'Nadana',
    description: 'List przewozowy powstał, paczka czeka na odbiór przez kuriera',
    color: 'slate',
    isFinal: false,
  },
  IN_TRANSIT: {
    label: 'W drodze',
    description: 'Paczka jedzie przez sieć InPost',
    color: 'blue',
    isFinal: false,
  },
  OUT_FOR_DELIVERY: {
    label: 'Doręczenie dziś',
    description: 'Kurier ma paczkę na trasie i doręczy ją dzisiaj',
    color: 'amber',
    isFinal: false,
  },
  READY_TO_PICKUP: {
    label: 'Czeka w paczkomacie',
    description: 'Paczka trafiła do paczkomatu albo punktu i czeka na odbiór',
    color: 'violet',
    isFinal: false,
  },
  PICKUP_REMINDER: {
    label: 'Przypomnienie o odbiorze',
    description: 'Czas na odbiór dobiega końca — InPost wysłał przypomnienie',
    color: 'orange',
    isFinal: false,
  },
  DELIVERED: {
    label: 'Doręczona',
    description: 'Paczka odebrana przez klienta',
    color: 'green',
    isFinal: true,
  },
  PROBLEM: {
    label: 'Wymaga uwagi',
    description: 'Doręczenie się nie powiodło albo minął czas odbioru',
    color: 'red',
    isFinal: false,
  },
  RETURNED: {
    label: 'Zwrot do nadawcy',
    description: 'Paczka wraca albo wróciła do nadawcy',
    color: 'rose',
    isFinal: true,
  },
  CANCELLED: {
    label: 'Anulowana',
    description: 'Przesyłka anulowana albo nieznana w systemie przewoźnika',
    color: 'gray',
    isFinal: true,
  },
  UNKNOWN: {
    label: 'Bez statusu',
    description: 'Przewoźnik nie podał jeszcze statusu przesyłki',
    color: 'slate',
    isFinal: false,
  },
};

/**
 * Surowy status ShipX → etap. Lista pokrywa statusy, ktore InPost realnie
 * zwraca dla paczkomatow i kuriera; nieznane wpadaja do heurystyki nizej.
 */
const STAGE_BY_STATUS: Record<string, ShipmentStage> = {
  created: 'CREATED',
  offers_prepared: 'CREATED',
  offer_selected: 'CREATED',
  confirmed: 'CREATED',
  dispatched_by_sender: 'CREATED',
  dispatched_by_sender_in_pok: 'CREATED',

  collected_from_sender: 'IN_TRANSIT',
  taken_by_courier: 'IN_TRANSIT',
  adopted_at_source_branch: 'IN_TRANSIT',
  sent_from_source_branch: 'IN_TRANSIT',
  adopted_at_sorting_center: 'IN_TRANSIT',
  sent_from_sorting_center: 'IN_TRANSIT',
  adopted_at_target_branch: 'IN_TRANSIT',
  out_for_delivery_to_address: 'OUT_FOR_DELIVERY',
  out_for_delivery: 'OUT_FOR_DELIVERY',
  ready_to_pickup_from_pok: 'READY_TO_PICKUP',
  ready_to_pickup_from_branch: 'READY_TO_PICKUP',
  ready_to_pickup: 'READY_TO_PICKUP',
  pickup_reminder_sent: 'PICKUP_REMINDER',
  pickup_time_expired: 'PROBLEM',
  avizo: 'PROBLEM',
  undelivered: 'PROBLEM',
  undelivered_wrong_address: 'PROBLEM',
  undelivered_cod_cash_receiver: 'PROBLEM',
  undelivered_no_pickup: 'PROBLEM',
  delay_in_delivery: 'PROBLEM',
  missing: 'PROBLEM',
  stack_in_customer_service_point: 'PROBLEM',
  stack_parcel_pickup_time_expired: 'PROBLEM',
  stack_in_box_machine: 'READY_TO_PICKUP',

  delivered: 'DELIVERED',

  return_pickup_confirmation: 'RETURNED',
  returned_to_sender: 'RETURNED',
  rejected_by_receiver: 'RETURNED',

  canceled: 'CANCELLED',
  cancelled: 'CANCELLED',
  not_found: 'CANCELLED',
};

export function normalizeShipmentStatus(status?: string | null): string {
  return String(status ?? '').trim().toLowerCase();
}

/**
 * Etap dla surowego statusu. Nieznanego statusu nie zgadujemy na sile —
 * heurystyka lapie tylko oczywiste rodziny nazw, reszta ląduje w IN_TRANSIT,
 * czyli tam, gdzie paczka nadal jest odpytywana.
 */
export function shipmentStageFromStatus(status?: string | null): ShipmentStage {
  const normalized = normalizeShipmentStatus(status);
  if (!normalized) return 'UNKNOWN';

  const known = STAGE_BY_STATUS[normalized];
  if (known) return known;

  if (normalized.startsWith('out_for_delivery')) return 'OUT_FOR_DELIVERY';
  if (normalized.startsWith('ready_to_pickup')) return 'READY_TO_PICKUP';
  if (normalized.includes('reminder')) return 'PICKUP_REMINDER';
  if (normalized.includes('returned') || normalized.includes('rejected')) return 'RETURNED';
  if (normalized.includes('canceled') || normalized.includes('cancelled')) return 'CANCELLED';
  if (normalized.includes('undelivered') || normalized.includes('expired')) return 'PROBLEM';
  if (normalized.includes('delivered')) return 'DELIVERED';

  return 'IN_TRANSIT';
}

export function isFinalShipmentStage(stage: ShipmentStage): boolean {
  return SHIPMENT_STAGE_DEFINITIONS[stage].isFinal;
}

export function shipmentStageLabel(stage?: string | null): string {
  const definition = SHIPMENT_STAGE_DEFINITIONS[stage as ShipmentStage];
  return definition ? definition.label : SHIPMENT_STAGE_DEFINITIONS.UNKNOWN.label;
}

const TRACKING_URL = 'https://inpost.pl/sledzenie-przesylek?number=';

export function shipmentTrackingUrl(trackingNumber?: string | null): string | null {
  const trimmed = String(trackingNumber ?? '').trim();
  return trimmed ? `${TRACKING_URL}${encodeURIComponent(trimmed)}` : null;
}

const SERVICE_LABELS: Record<string, string> = {
  inpost_locker_standard: 'Paczkomat',
  inpost_locker_economy: 'Paczkomat Economy',
  inpost_courier_c2c: 'Paczkomat C2C',
  inpost_courier_standard: 'Kurier',
  inpost_courier_express_1000: 'Kurier 10:00',
  inpost_courier_express_1200: 'Kurier 12:00',
  inpost_courier_express_1700: 'Kurier 17:00',
  inpost_courier_palette: 'Paleta',
};

export function shipmentServiceLabel(service?: string | null): string | null {
  const trimmed = String(service ?? '').trim();
  if (!trimmed) return null;
  return SERVICE_LABELS[trimmed] ?? trimmed;
}
