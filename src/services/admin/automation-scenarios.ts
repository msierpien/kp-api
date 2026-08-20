/**
 * Gotowe reguły z wypełnionymi polami. Dotąd typowe automatyzacje powstawały
 * skryptami w `src/scripts` — operator nie miał jak dołożyć ich sam, a każda
 * nowa instalacja wymagała wejścia do kontenera. Scenariusz to ten sam JSON,
 * co reguła własna: po zapisaniu można go dowolnie edytować.
 */

export type AutomationScenarioCategory = 'cases' | 'orders' | 'documents' | 'integrations';

export interface AutomationScenario {
  id: string;
  name: string;
  summary: string;
  category: AutomationScenarioCategory;
  trigger: string;
  conditions: Array<Record<string, unknown>>;
  actions: Array<{ type: string; config: Record<string, unknown> }>;
  priority: number;
  /** Scenariusze wysyłające pocztę do klienta wchodzą wyłączone — najpierw podgląd treści. */
  startsDisabled?: boolean;
}

const TRACKING_FOOTER = 'Śledzenie przesyłki: {{trackingUrl}}';

export const AUTOMATION_SCENARIOS: AutomationScenario[] = [
  {
    id: 'personalization-link-after-purchase',
    name: 'Link do personalizacji po zakupie',
    summary: 'Sprawa utworzona → email z linkiem do personalizacji.',
    category: 'cases',
    trigger: 'CASE_CREATED',
    conditions: [],
    priority: 10,
    actions: [
      {
        type: 'SEND_EMAIL',
        config: {
          to: 'customer',
          subject: 'Twój link do personalizacji — zamówienie {{orderReference}}',
          body: [
            'Dzień dobry,',
            '',
            'zaproszenia z zamówienia {{orderReference}} są gotowe do personalizacji:',
            '{{personalizationUrl}}',
            '',
            'Pozdrawiamy,',
            '{{shopName}}',
          ].join('\n'),
        },
      },
    ],
  },
  {
    id: 'personalization-reminder',
    name: 'Przypomnienie o niedokończonej personalizacji',
    summary: 'Upłynął czas, sprawa czeka na klienta → email i notatka.',
    category: 'cases',
    trigger: 'CASE_TIME_ELAPSED',
    priority: 40,
    conditions: [
      { field: 'status', operator: 'equals', value: 'WAITING_FOR_CUSTOMER', groupId: 'group-1', groupOperator: 'AND' },
    ],
    actions: [
      {
        type: 'SEND_EMAIL',
        config: {
          to: 'customer',
          subject: 'Czekamy na Twoją personalizację — {{orderReference}}',
          body: [
            'Dzień dobry,',
            '',
            'personalizacja zamówienia {{orderReference}} nie została jeszcze dokończona.',
            'Link do formularza: {{personalizationUrl}}',
            '',
            'Pozdrawiamy,',
            '{{shopName}}',
          ].join('\n'),
        },
      },
      { type: 'ADD_NOTE', config: { note: 'Wysłano przypomnienie o personalizacji (automat).' } },
    ],
  },
  {
    id: 'case-ready-for-print',
    name: 'Sprawa gotowa do druku',
    summary: 'Formularz wysłany → zmiana statusu sprawy na „Gotowe do druku”.',
    category: 'cases',
    trigger: 'CASE_SUBMITTED',
    conditions: [],
    priority: 30,
    actions: [
      { type: 'CHANGE_STATUS', config: { status: 'READY_FOR_PRINT' } },
    ],
  },
  {
    id: 'invoice-after-shipment',
    name: 'Faktura VAT i WZ po liście przewozowym',
    summary: 'List przewozowy utworzony → dokumenty; przy brakach magazynowych wstrzymaj i zgłoś.',
    category: 'documents',
    trigger: 'ORDER_SHIPMENT_CREATED',
    conditions: [],
    priority: 20,
    actions: [
      {
        type: 'ISSUE_INVOICE_AFTER_SHIPMENT',
        config: { blockOnMissingStock: true, ensureWz: true, requireScanned: true },
      },
    ],
  },
  {
    id: 'close-wz-after-invoice',
    name: 'Zamknięcie WZ po fakturze',
    summary: 'Faktura wystawiona → zamknij WZ, jeśli towar był zeskanowany.',
    category: 'documents',
    trigger: 'ORDER_INVOICE_ISSUED',
    conditions: [],
    priority: 30,
    actions: [
      { type: 'CONFIRM_ORDER_WZ_AFTER_INVOICE', config: { requireScanned: true } },
    ],
  },
  {
    id: 'courier-delivers-today',
    name: 'Kurier doręcza dziś',
    summary: 'Przesyłka trafiła na trasę → email „paczka będzie dziś”.',
    category: 'orders',
    trigger: 'ORDER_SHIPMENT_STATUS_CHANGED',
    priority: 50,
    startsDisabled: true,
    conditions: [
      { field: 'shipment.stage', operator: 'equals', value: 'OUT_FOR_DELIVERY', groupId: 'group-1', groupOperator: 'AND' },
    ],
    actions: [
      {
        type: 'SEND_ORDER_EMAIL',
        config: {
          to: 'customer',
          subject: 'Twoja paczka jedzie dziś — zamówienie {{orderReference}}',
          body: [
            'Dzień dobry,',
            '',
            'paczka z zamówienia {{orderReference}} jest już u kuriera i powinna dotrzeć dzisiaj.',
            TRACKING_FOOTER,
            '',
            'Pozdrawiamy,',
            '{{shopName}}',
          ].join('\n'),
        },
      },
    ],
  },
  {
    id: 'parcel-waiting-in-locker',
    name: 'Paczka czeka w paczkomacie',
    summary: 'Przesyłka gotowa do odbioru → email z numerem i punktem odbioru.',
    category: 'orders',
    trigger: 'ORDER_SHIPMENT_STATUS_CHANGED',
    priority: 50,
    startsDisabled: true,
    conditions: [
      { field: 'shipment.stage', operator: 'equals', value: 'READY_TO_PICKUP', groupId: 'group-1', groupOperator: 'AND' },
    ],
    actions: [
      {
        type: 'SEND_ORDER_EMAIL',
        config: {
          to: 'customer',
          subject: 'Paczka czeka na odbiór — zamówienie {{orderReference}}',
          body: [
            'Dzień dobry,',
            '',
            'paczka z zamówienia {{orderReference}} czeka na odbiór.',
            'Punkt odbioru: {{pickupPoint}}',
            'Numer przesyłki: {{trackingNumber}}',
            TRACKING_FOOTER,
            '',
            'Pozdrawiamy,',
            '{{shopName}}',
          ].join('\n'),
        },
      },
    ],
  },
  {
    id: 'pickup-reminder',
    name: 'Przypomnienie o odbiorze z paczkomatu',
    summary: 'Czas odbioru dobiega końca → email przypominający.',
    category: 'orders',
    trigger: 'ORDER_SHIPMENT_STATUS_CHANGED',
    priority: 55,
    startsDisabled: true,
    conditions: [
      { field: 'shipment.stage', operator: 'equals', value: 'PICKUP_REMINDER', groupId: 'group-1', groupOperator: 'AND' },
    ],
    actions: [
      {
        type: 'SEND_ORDER_EMAIL',
        config: {
          to: 'customer',
          subject: 'Ostatnie dni na odbiór paczki — {{orderReference}}',
          body: [
            'Dzień dobry,',
            '',
            'paczka z zamówienia {{orderReference}} wciąż czeka w punkcie {{pickupPoint}}.',
            'Po upływie czasu odbioru wróci do nas, a przesyłkę trzeba będzie nadać ponownie.',
            TRACKING_FOOTER,
            '',
            'Pozdrawiamy,',
            '{{shopName}}',
          ].join('\n'),
        },
      },
    ],
  },
  {
    id: 'parcel-delivered',
    name: 'Przesyłka doręczona',
    summary: 'Paczka odebrana → podziękowanie i status zamówienia „Dostarczone”.',
    category: 'orders',
    trigger: 'ORDER_SHIPMENT_STATUS_CHANGED',
    priority: 60,
    startsDisabled: true,
    conditions: [
      { field: 'shipment.stage', operator: 'equals', value: 'DELIVERED', groupId: 'group-1', groupOperator: 'AND' },
    ],
    actions: [
      {
        type: 'SEND_ORDER_EMAIL',
        config: {
          to: 'customer',
          subject: 'Paczka dotarła — dziękujemy za zamówienie {{orderReference}}',
          body: [
            'Dzień dobry,',
            '',
            'paczka z zamówienia {{orderReference}} została odebrana. Dziękujemy za zakupy!',
            '',
            'Pozdrawiamy,',
            '{{shopName}}',
          ].join('\n'),
        },
      },
      { type: 'CHANGE_ORDER_STATUS', config: { status: 'DELIVERED' } },
    ],
  },
  {
    id: 'webhook-to-external-system',
    name: 'Webhook do systemu zewnętrznego',
    summary: 'Dowolny wyzwalacz → POST z ładunkiem sprawy.',
    category: 'integrations',
    trigger: 'CASE_STATUS_CHANGED',
    conditions: [],
    priority: 50,
    startsDisabled: true,
    actions: [
      {
        type: 'WEBHOOK',
        config: { url: 'https://', method: 'POST', timeoutMs: 10000 },
      },
    ],
  },
];

export function getAutomationScenario(id: string): AutomationScenario | null {
  return AUTOMATION_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
