import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { config as appConfig } from '../../config';
import { decrypt } from '../../lib/encryption';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { assertOrderOperationalStatus } from '../../lib/order-statuses';
import { generateAccessToken, getTokenExpiryDate, maskToken } from '../../lib/token';
import { emailService } from '../email/email.service';
import { createShopEmailService } from './email-settings.service';
import { queueOrderPersonalizationEmail } from '../queue/email.queue';
import { confirmDocument, syncWzDraftItemsWithReservations } from './warehouse-documents.service';
import {
  issueInvoiceAfterShipment,
  type IssueInvoiceAfterShipmentConfig,
  type ShipmentInvoiceResult,
} from '../orders/order-shipment-invoice.service';
import {
  buildDryRunResult,
  executeWebhook,
  normalizeConditions,
  type AutomationContext,
} from './automation-rules';

export {
  assertPublicHttpsUrl,
  buildDryRunResult,
  evaluateConditions,
  executeWebhook,
  normalizeConditions,
} from './automation-rules';
export type {
  AutomationCondition,
  AutomationContext,
  AutomationDryRunResult,
  LogicOperator,
  NormalizedAutomationCondition,
} from './automation-rules';

export enum AutomationTrigger {
  CASE_CREATED = 'CASE_CREATED',
  CASE_STATUS_CHANGED = 'CASE_STATUS_CHANGED',
  CASE_SUBMITTED = 'CASE_SUBMITTED',
  CASE_TIME_ELAPSED = 'CASE_TIME_ELAPSED',
  ORDER_INVOICE_ISSUED = 'ORDER_INVOICE_ISSUED',
  ORDER_SHIPMENT_CREATED = 'ORDER_SHIPMENT_CREATED',
}

export enum AutomationActionType {
  SEND_EMAIL = 'SEND_EMAIL',
  CHANGE_STATUS = 'CHANGE_STATUS',
  ADD_NOTE = 'ADD_NOTE',
  WEBHOOK = 'WEBHOOK',
  CONFIRM_ORDER_WZ_AFTER_INVOICE = 'CONFIRM_ORDER_WZ_AFTER_INVOICE',
  ISSUE_INVOICE_AFTER_SHIPMENT = 'ISSUE_INVOICE_AFTER_SHIPMENT',
  CHANGE_ORDER_STATUS = 'CHANGE_ORDER_STATUS',
}

/**
 * Wyzwalacze operujace na ZAMOWIENIU, nie na sprawie personalizacji.
 * `context.caseId` jest tam identyfikatorem zamowienia, wiec akcje piszace po
 * `personalizationCase` (zmiana statusu sprawy, notatka, mail z linkiem) nie
 * maja czego znalezc — dlatego odrzucamy je z czytelnym komunikatem.
 */
const ORDER_SCOPED_TRIGGERS: string[] = [
  AutomationTrigger.ORDER_INVOICE_ISSUED,
  AutomationTrigger.ORDER_SHIPMENT_CREATED,
];

export function isOrderScopedTrigger(trigger: string) {
  return ORDER_SCOPED_TRIGGERS.includes(trigger);
}

/** Akcje piszace po sprawie personalizacji — bezuzyteczne przy wyzwalaczach zamowienia. */
const CASE_SCOPED_ACTION_MESSAGES: Record<string, string> = {
  [AutomationActionType.SEND_EMAIL]: 'Akcja „Wyślij email" wysyła link do personalizacji sprawy — przy wyzwalaczu zamówienia nie ma czego wysłać',
  [AutomationActionType.CHANGE_STATUS]: 'Akcja „Zmień status" dotyczy sprawy personalizacji — przy wyzwalaczu zamówienia użyj „Zmień status zamówienia"',
  [AutomationActionType.ADD_NOTE]: 'Akcja „Dodaj notatkę" zapisuje notatkę sprawy personalizacji — przy wyzwalaczu zamówienia nie ma jej gdzie dopisać',
};

function assertActionMatchesTriggerScope(actionType: string, trigger: string) {
  if (!isOrderScopedTrigger(trigger)) return;
  const message = CASE_SCOPED_ACTION_MESSAGES[actionType];
  if (message) throw new Error(message);
}

export interface AutomationAction {
  type: AutomationActionType;
  config: Record<string, any>;
}

export type InvoiceWarehouseDocumentAction =
  | { status: 'NONE'; reason: string }
  | { status: 'REQUIRES_CONFIRMATION'; documentId: string; documentNumber: string; reason: string }
  | { status: 'AUTO_CONFIRMED'; documentId: string; documentNumber: string }
  | { status: 'FAILED'; documentId: string; documentNumber: string; reason: string };

interface AutomationActionExecutionResult {
  type: string;
  error?: string;
  warehouseDocumentAction?: InvoiceWarehouseDocumentAction;
  shipmentInvoiceAction?: ShipmentInvoiceResult;
}

function renderTemplate(template: string, variables: Record<string, unknown>) {
  let rendered = template;
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(value ?? ''));
  }
  return rendered;
}

function getReusableCaseToken(caseData: any) {
  if (!caseData?.tokenActive || !caseData.customerTokenEncrypted) return null;
  try {
    return decrypt(caseData.customerTokenEncrypted);
  } catch {
    return null;
  }
}

async function issueCaseToken(caseData: any) {
  const { token, hash, encrypted } = generateAccessToken();
  await prisma.personalizationCase.update({
    where: { id: caseData.id },
    data: {
      customerTokenHash: hash,
      customerTokenEncrypted: encrypted,
      tokenActive: true,
      customerTokenExpiresAt: getTokenExpiryDate(),
      updatedAt: new Date(),
    },
  });
  console.log(`[Automation] Generated token for case ${caseData.id}: ${maskToken(token)}`);
  return token;
}

async function executeSendEmail(config: Record<string, any>, caseData: any): Promise<void> {
  if (!emailService.isConfigured()) {
    throw new Error('Email service not configured');
  }
  if (!caseData?.id) {
    throw new Error('Missing case data for email automation');
  }

  const accessToken = config.rotateToken === true
    ? await issueCaseToken(caseData)
    : getReusableCaseToken(caseData) ?? await issueCaseToken(caseData);
  const baseUrl = appConfig.frontend.portalUrl;
  const personalizationUrl = `${baseUrl}/${accessToken}`;
  const variables = {
    customerName: caseData.order?.customerName || '',
    orderReference: caseData.order?.orderReference || '',
    productName: caseData.orderItem?.productNameSnapshot || '',
    quantity: caseData.orderItem?.quantity || 1,
    shopName: caseData.order?.shop?.name || '',
    personalizationUrl,
  };
  const to = config.to === 'customer' || !config.to
    ? caseData.order?.customerEmail
    : renderTemplate(String(config.to), variables);
  if (!to) throw new Error('Missing email recipient');

  const subject = renderTemplate(
    String(config.subject || `Personalizacja zamówienia {{orderReference}} - {{shopName}}`),
    variables,
  );
  const body = renderTemplate(
    String(config.body || config.template || 'Link do personalizacji: {{personalizationUrl}}'),
    variables,
  );

  // Zamowienie moze miec KILKA produktow personalizowanych, a kazdy zaklada
  // wlasna sprawe - wysylka wprost daloby klientowi tyle maili, ile pozycji.
  // Zadanie w kolejce jest deduplikowane po ZAMOWIENIU i czeka chwile, az
  // powstana pozostale sprawy; linki zbiera dopiero przy wysylce.
  const orderId = caseData.order?.id ?? caseData.orderId;
  if (orderId) {
    // Podstawiamy tylko to, co znamy teraz. Linki i nazwy produktow zostaja
    // jako {{...}} - wypelni je worker, gdy zobaczy komplet pozycji.
    await queueOrderPersonalizationEmail({
      orderId,
      shopId: caseData?.order?.shop?.id || caseData?.shop?.id || undefined,
      to,
      subject: renderTemplate(
        String(config.subject || `Personalizacja zamówienia {{orderReference}} - {{shopName}}`),
        { ...variables, productName: '{{productName}}', quantity: '{{quantity}}' },
      ),
      body: renderTemplate(
        String(config.body || config.template || 'Link do personalizacji: {{personalizationUrl}}'),
        {
          ...variables,
          personalizationUrl: '{{personalizationUrl}}',
          personalizationLinks: '{{personalizationLinks}}',
          productName: '{{productName}}',
          quantity: '{{quantity}}',
        },
      ),
      shopName: String(variables.shopName),
    });
    return;
  }

  // Nadawca zalezy od SKLEPU sprawy: kazdy sklep ma wysylac z wlasnej domeny,
  // inaczej SPF i DKIM nie zgadzaja sie z adresem i poczta laduje w spamie.
  // Brak wpisu dla sklepu = konfiguracja zapasowa tenanta, a gdy i jej nie
  // ma - globalny serwis (ustawienia z ENV).
  const shopId = caseData?.order?.shop?.id || caseData?.shop?.id || null;
  const sender = shopId ? await createShopEmailService(shopId).catch(() => null) : null;
  const mailer = sender ?? emailService;

  if (typeof (mailer as any).sendAutomationEmail === 'function') {
    await (mailer as any).sendAutomationEmail({
      to,
      subject,
      body,
      shopName: String(variables.shopName),
    });
  } else {
    await mailer.sendPersonalizationEmail({
      to,
      customerName: String(variables.customerName),
      orderReference: String(variables.orderReference),
      shopName: String(variables.shopName),
      items: [
        {
          productName: String(variables.productName),
          quantity: Number(variables.quantity) || 1,
          personalizationUrl,
        },
      ],
      baseUrl,
    });
  }

  console.log(`[Automation] Email sent to ${to} for case ${caseData.id}: ${subject}`);
}

async function executeChangeStatus(config: Record<string, any>, context: AutomationContext): Promise<void> {
  const status = String(config.status || '');
  if (!status) throw new Error('Missing status for CHANGE_STATUS action');
  await prisma.personalizationCase.update({
    where: { id: context.caseId },
    data: { status, updatedAt: new Date() },
  });
}

async function executeChangeOrderStatus(config: Record<string, any>, context: AutomationContext): Promise<void> {
  const orderId = context.orderId || context.caseData?.order?.id || context.caseId;
  if (!orderId) throw new Error('Brak zamówienia dla akcji zmiany statusu');

  const rawStatus = String(config.status || '').trim();
  if (!rawStatus) {
    throw new Error('Brak statusu w akcji „Zmień status zamówienia" — otwórz regułę, wybierz status i zapisz');
  }
  const status = assertOrderOperationalStatus(rawStatus);

  // Ta sama sciezka co reczna zmiana w panelu: mapowanie na status PrestaShop
  // i skutki magazynowe. Osobny `prisma.order.update` rozjechalby stan.
  const { updateOrderStatus } = await import('./shop-order-statuses.service');
  await updateOrderStatus(orderId, { operationalStatus: status });
}

async function executeAddNote(config: Record<string, any>, caseId: string): Promise<void> {
  const note = String(config.note || '').trim();
  if (!note) throw new Error('Missing note for ADD_NOTE action');

  const currentCase = await prisma.personalizationCase.findUnique({
    where: { id: caseId },
    select: { notesInternal: true },
  });
  const existingNotes = currentCase?.notesInternal || '';
  const timestamp = new Date().toISOString();
  const nextNote = `[${timestamp}] [AUTOMATION] ${note}`;

  await prisma.personalizationCase.update({
    where: { id: caseId },
    data: {
      notesInternal: existingNotes ? `${existingNotes}\n${nextNote}` : nextNote,
      updatedAt: new Date(),
    },
  });
}

async function executeConfirmOrderWzAfterInvoice(
  config: Record<string, any>,
  context: AutomationContext,
): Promise<InvoiceWarehouseDocumentAction> {
  const orderId = context.orderId || context.caseData?.order?.id || context.caseId;
  const tenantId = context.caseData?.order?.shop?.tenantId || getTenantId();
  const draft = await prisma.warehouseDocument.findFirst({
    where: {
      orderId,
      type: 'WZ',
      status: 'DRAFT',
      ...(tenantId ? { tenantId } : {}),
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  if (!draft) {
    return { status: 'NONE', reason: 'Brak roboczego WZ dla zamówienia' };
  }

  // Draft moze byc nieaktualny wzgledem rezerwacji (np. realokacja po PZ) —
  // ocena skanow i zatwierdzenie musza dotyczyc zsynchronizowanych pozycji,
  // tak samo jak przy pakowaniu i wysylce.
  await syncWzDraftItemsWithReservations(draft.id);
  const document = await prisma.warehouseDocument.findUniqueOrThrow({
    where: { id: draft.id },
    include: { items: true },
  });

  const requireScanned = config.requireScanned !== false;
  const allItemsScanned = document.items.length > 0 && document.items.every((item) => Boolean(item.scannedEan?.trim()));
  if (requireScanned && !allItemsScanned) {
    return {
      status: 'REQUIRES_CONFIRMATION',
      documentId: document.id,
      documentNumber: document.number,
      reason: 'WZ ma pozycje bez skanu EAN',
    };
  }

  try {
    await confirmDocument(document.id);
    return {
      status: 'AUTO_CONFIRMED',
      documentId: document.id,
      documentNumber: document.number,
    };
  } catch (error) {
    return {
      status: 'FAILED',
      documentId: document.id,
      documentNumber: document.number,
      reason: error instanceof Error ? error.message : 'Nie udało się zatwierdzić WZ',
    };
  }
}

async function executeIssueInvoiceAfterShipment(
  config: Record<string, any>,
  context: AutomationContext,
): Promise<ShipmentInvoiceResult> {
  const orderId = context.orderId || context.caseData?.order?.id || context.caseId;
  if (!orderId) throw new Error('Brak zamówienia dla akcji wystawienia faktury');

  return issueInvoiceAfterShipment(orderId, {
    blockOnMissingStock: config.blockOnMissingStock,
    ensureWz: config.ensureWz,
    requireScanned: config.requireScanned,
  } satisfies IssueInvoiceAfterShipmentConfig);
}

async function executeActions(actions: AutomationAction[], context: AutomationContext): Promise<AutomationActionExecutionResult[]> {
  const results: AutomationActionExecutionResult[] = [];

  for (const action of actions) {
    try {
      let warehouseDocumentAction: InvoiceWarehouseDocumentAction | undefined;
      let shipmentInvoiceAction: ShipmentInvoiceResult | undefined;
      assertActionMatchesTriggerScope(action.type, context.trigger);
      switch (action.type) {
        case AutomationActionType.SEND_EMAIL:
          await executeSendEmail(action.config || {}, context.caseData);
          break;
        case AutomationActionType.CHANGE_STATUS:
          await executeChangeStatus(action.config || {}, context);
          break;
        case AutomationActionType.CHANGE_ORDER_STATUS:
          await executeChangeOrderStatus(action.config || {}, context);
          break;
        case AutomationActionType.ADD_NOTE:
          await executeAddNote(action.config || {}, context.caseId);
          break;
        case AutomationActionType.WEBHOOK:
          await executeWebhook(action.config || {}, context);
          break;
        case AutomationActionType.CONFIRM_ORDER_WZ_AFTER_INVOICE:
          warehouseDocumentAction = await executeConfirmOrderWzAfterInvoice(action.config || {}, context);
          break;
        case AutomationActionType.ISSUE_INVOICE_AFTER_SHIPMENT:
          shipmentInvoiceAction = await executeIssueInvoiceAfterShipment(action.config || {}, context);
          break;
        default:
          throw new Error(`Unknown action type: ${action.type}`);
      }
      results.push({ type: action.type, warehouseDocumentAction, shipmentInvoiceAction });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ type: action.type, error: message });
      console.error(`[Automation] Failed to execute action ${action.type}:`, error);
    }
  }

  return results;
}

function getTenantIdForAutomationData(data: { tenantId?: string }) {
  const context = getTenantContext();
  if (context?.role === 'SUPER_ADMIN') {
    return data.tenantId || context.overrideTenantId || context.tenantId || null;
  }
  return context?.tenantId || null;
}

function getTenantIdFromContext(context: AutomationContext): string | null {
  return context.caseData?.order?.shop?.tenantId
    || context.caseData?.shop?.tenantId
    || context.caseData?.template?.tenantId
    || getTenantId();
}

function automationConditionsJson(conditions: unknown): Prisma.InputJsonValue {
  return normalizeConditions(conditions) as unknown as Prisma.InputJsonValue;
}

function automationActionsJson(actions: unknown): Prisma.InputJsonValue {
  return (Array.isArray(actions) ? actions : []) as unknown as Prisma.InputJsonValue;
}

async function loadCaseData(caseId: string) {
  return prisma.personalizationCase.findUnique({
    where: { id: caseId },
    include: {
      order: { include: { shop: true } },
      orderItem: true,
      template: true,
    },
  });
}

export async function triggerAutomations(context: AutomationContext): Promise<void> {
  try {
    if (!context.caseData) {
      context.caseData = await loadCaseData(context.caseId);
    }
    const tenantId = getTenantIdFromContext(context);
    if (!tenantId) {
      console.warn('[Automation] Missing tenant context; skipping automations');
      return;
    }

    const automations = await prisma.automation.findMany({
      where: {
        tenantId,
        trigger: context.trigger,
        isActive: true,
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });

    for (const automation of automations) {
      const dryRun = buildDryRunResult(automation.id, automation.conditions, context);
      if (!dryRun.matched) continue;

      const actions = Array.isArray(automation.actions)
        ? automation.actions as unknown as AutomationAction[]
        : [];
      const actionResults = await executeActions(actions, context);
      const actionErrors = actionResults
        .filter((result) => result.error)
        .map((result) => `${result.type}: ${result.error}`);
      const now = new Date();

      await prisma.automation.update({
        where: { id: automation.id },
        data: {
          runCount: { increment: 1 },
          lastRunAt: now,
          ...(actionErrors.length > 0
            ? { lastErrorAt: now, lastErrorMessage: actionErrors.join('\n').slice(0, 5000) }
            : { lastErrorMessage: null }),
        },
      });
    }
  } catch (error) {
    console.error('[Automation] Failed to trigger automations:', error);
  }
}

export async function triggerInvoiceIssuedAutomations(input: { orderId: string; invoiceId: string }): Promise<InvoiceWarehouseDocumentAction> {
  try {
    const order = await prisma.order.findFirst({
      where: {
        id: input.orderId,
        ...(getTenantId() ? { shop: { tenantId: getTenantId() as string } } : {}),
      },
      include: { shop: true, items: true },
    });
    if (!order) throw new Error('Zamówienie nie znalezione');

    const invoice = await prisma.salesDocument.findFirst({
      where: {
        id: input.invoiceId,
        orderId: input.orderId,
        ...(getTenantId() ? { tenantId: getTenantId() as string } : {}),
      },
    });
    const context: AutomationContext = {
      caseId: order.id,
      orderId: order.id,
      invoiceId: input.invoiceId,
      trigger: AutomationTrigger.ORDER_INVOICE_ISSUED,
      caseData: { order, invoice },
    };
    const tenantId = getTenantIdFromContext(context);
    if (!tenantId) {
      return { status: 'NONE', reason: 'Brak tenanta dla automatyzacji faktury' };
    }

    const automations = await prisma.automation.findMany({
      where: {
        tenantId,
        trigger: AutomationTrigger.ORDER_INVOICE_ISSUED,
        isActive: true,
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    if (automations.length === 0) {
      return { status: 'NONE', reason: 'Brak aktywnej automatyzacji dla wystawionej faktury' };
    }

    let warehouseDocumentAction: InvoiceWarehouseDocumentAction = {
      status: 'NONE',
      reason: 'Automatyzacja nie zwróciła akcji WZ',
    };

    for (const automation of automations) {
      const dryRun = buildDryRunResult(automation.id, automation.conditions, context);
      if (!dryRun.matched) continue;

      const actions = Array.isArray(automation.actions)
        ? automation.actions as unknown as AutomationAction[]
        : [];
      const actionResults = await executeActions(actions, context);
      const actionErrors = actionResults
        .filter((result) => result.error)
        .map((result) => `${result.type}: ${result.error}`);
      const actionResult = actionResults.find((result) => result.warehouseDocumentAction);
      if (actionResult?.warehouseDocumentAction) {
        warehouseDocumentAction = actionResult.warehouseDocumentAction;
      }
      const now = new Date();

      await prisma.automation.update({
        where: { id: automation.id },
        data: {
          runCount: { increment: 1 },
          lastRunAt: now,
          ...(actionErrors.length > 0
            ? { lastErrorAt: now, lastErrorMessage: actionErrors.join('\n').slice(0, 5000) }
            : { lastErrorMessage: null }),
        },
      });
    }

    return warehouseDocumentAction;
  } catch (error) {
    return {
      status: 'FAILED',
      documentId: '',
      documentNumber: 'WZ',
      reason: error instanceof Error ? error.message : 'Nie udało się uruchomić automatyzacji faktury',
    };
  }
}

/**
 * Nadanie listu przewozowego. Zwraca wynik akcji fakturowej, bo panel musi
 * pokazac operatorowi, ze przy brakach magazynowych faktura i WZ nie powstaly.
 */
export async function triggerShipmentCreatedAutomations(input: {
  orderId: string;
  shipment?: unknown;
}): Promise<ShipmentInvoiceResult | null> {
  try {
    const order = await prisma.order.findFirst({
      where: {
        id: input.orderId,
        ...(getTenantId() ? { shop: { tenantId: getTenantId() as string } } : {}),
      },
      include: { shop: true, items: true },
    });
    if (!order) throw new Error('Zamówienie nie znalezione');

    const context: AutomationContext = {
      caseId: order.id,
      orderId: order.id,
      trigger: AutomationTrigger.ORDER_SHIPMENT_CREATED,
      caseData: { order, shipment: input.shipment ?? null },
    };
    const tenantId = getTenantIdFromContext(context);
    if (!tenantId) return null;

    const automations = await prisma.automation.findMany({
      where: {
        tenantId,
        trigger: AutomationTrigger.ORDER_SHIPMENT_CREATED,
        isActive: true,
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
    if (automations.length === 0) return null;

    let shipmentInvoiceAction: ShipmentInvoiceResult | null = null;

    for (const automation of automations) {
      const dryRun = buildDryRunResult(automation.id, automation.conditions, context);
      if (!dryRun.matched) continue;

      const actions = Array.isArray(automation.actions)
        ? automation.actions as unknown as AutomationAction[]
        : [];
      const actionResults = await executeActions(actions, context);
      const actionErrors = actionResults
        .filter((result) => result.error)
        .map((result) => `${result.type}: ${result.error}`);
      const actionResult = actionResults.find((result) => result.shipmentInvoiceAction);
      if (actionResult?.shipmentInvoiceAction) {
        shipmentInvoiceAction = actionResult.shipmentInvoiceAction;
      }

      // Wstrzymanie z powodu brakow to nie awaria akcji, ale MUSI zostac slad:
      // baner w panelu znika po odswiezeniu, a faktury i tak nie ma.
      const blockedMessage = shipmentInvoiceAction && ['STOCK_MISSING', 'FAILED'].includes(shipmentInvoiceAction.status)
        ? [`${AutomationActionType.ISSUE_INVOICE_AFTER_SHIPMENT}: ${shipmentInvoiceAction.message}`]
        : [];
      const errorMessages = [...actionErrors, ...blockedMessage];
      const now = new Date();

      await prisma.automation.update({
        where: { id: automation.id },
        data: {
          runCount: { increment: 1 },
          lastRunAt: now,
          ...(errorMessages.length > 0
            ? { lastErrorAt: now, lastErrorMessage: errorMessages.join('\n').slice(0, 5000) }
            : { lastErrorMessage: null }),
        },
      });
    }

    return shipmentInvoiceAction;
  } catch (error) {
    return {
      status: 'FAILED',
      message: error instanceof Error ? error.message : 'Nie udało się uruchomić automatyzacji listu przewozowego',
      warehouseDocument: { status: 'NONE', reason: 'Automatyzacja nie została wykonana' },
    };
  }
}

export async function listAutomations() {
  return prisma.automation.findMany({
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function getAutomationById(id: string) {
  const automation = await prisma.automation.findFirst({ where: { id } });
  if (!automation) throw new Error('Automation not found');
  return automation;
}

export async function createAutomation(data: {
  tenantId?: string;
  name: string;
  description?: string | null;
  trigger: string;
  conditions: any;
  actions: any;
  isActive?: boolean;
  priority?: number;
}) {
  const tenantId = getTenantIdForAutomationData(data);
  if (!tenantId) throw new Error('Brak tenanta dla automatyzacji');

  return prisma.automation.create({
    data: {
      tenantId,
      name: data.name,
      description: data.description,
      trigger: data.trigger,
      conditions: automationConditionsJson(data.conditions),
      actions: automationActionsJson(data.actions),
      isActive: data.isActive ?? true,
      priority: data.priority ?? 0,
    },
  });
}

export async function updateAutomation(
  id: string,
  data: {
    tenantId?: string;
    name?: string;
    description?: string | null;
    trigger?: string;
    conditions?: any;
    actions?: any;
    isActive?: boolean;
    priority?: number;
  },
) {
  await getAutomationById(id);
  const updateData = {
    ...data,
    ...(data.conditions !== undefined ? { conditions: automationConditionsJson(data.conditions) } : {}),
    ...(data.actions !== undefined ? { actions: automationActionsJson(data.actions) } : {}),
    tenantId: undefined,
    updatedAt: new Date(),
  };
  return prisma.automation.update({ where: { id }, data: updateData });
}

export async function deleteAutomation(id: string) {
  await getAutomationById(id);
  return prisma.automation.delete({ where: { id } });
}

export async function toggleAutomation(id: string, isActive: boolean) {
  await getAutomationById(id);
  return prisma.automation.update({ where: { id }, data: { isActive } });
}

export async function dryRunAutomation(id: string, input: { caseId?: string; caseData?: any }) {
  const automation = await getAutomationById(id);
  const caseData = input.caseData || (input.caseId ? await loadCaseData(input.caseId) : null);
  return buildDryRunResult(automation.id, automation.conditions, {
    caseId: input.caseId || caseData?.id || 'preview',
    trigger: automation.trigger as AutomationTrigger,
    caseData,
  });
}

export async function testAutomationWebhook(config: Record<string, any>) {
  await executeWebhook(config, {
    caseId: 'test',
    trigger: AutomationTrigger.CASE_CREATED,
    caseData: { test: true },
  });
  return { ok: true };
}
