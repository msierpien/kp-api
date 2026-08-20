import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { config as appConfig } from '../../config';
import { decrypt } from '../../lib/encryption';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { assertOrderOperationalStatus } from '../../lib/order-statuses';
import {
  shipmentServiceLabel,
  shipmentStageFromStatus,
  shipmentStageLabel,
  shipmentTrackingUrl,
} from '../../lib/inpost-statuses';
import { generateAccessToken, getTokenExpiryDate, maskToken } from '../../lib/token';
import { emailService } from '../email/email.service';
import { createShopEmailService } from './email-settings.service';
import { findEmailTemplateForAction } from './email-templates.service';
import { queueOrderPersonalizationEmail } from '../queue/email.queue';
import { confirmDocument, syncWzDraftItemsWithReservations } from './warehouse-documents.service';
import {
  issueInvoiceAfterShipment,
  type IssueInvoiceAfterShipmentConfig,
  type ShipmentInvoiceResult,
} from '../orders/order-shipment-invoice.service';
import { AUTOMATION_SCENARIOS, getAutomationScenario } from './automation-scenarios';
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
  ORDER_SHIPMENT_STATUS_CHANGED = 'ORDER_SHIPMENT_STATUS_CHANGED',
}

export enum AutomationActionType {
  SEND_EMAIL = 'SEND_EMAIL',
  CHANGE_STATUS = 'CHANGE_STATUS',
  ADD_NOTE = 'ADD_NOTE',
  SEND_ORDER_EMAIL = 'SEND_ORDER_EMAIL',
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
  AutomationTrigger.ORDER_SHIPMENT_STATUS_CHANGED,
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

  // Tresc z biblioteki szablonow wygrywa nad wklejona w regule; bez
  // `templateId` regula dziala dokladnie jak wczesniej.
  const caseTemplate = await findEmailTemplateForAction({
    templateId: config.templateId,
    shopId: caseData?.order?.shop?.id ?? null,
  });
  const subjectSource = caseTemplate?.subject
    || config.subject
    || 'Personalizacja zamówienia {{orderReference}} - {{shopName}}';
  const bodySource = caseTemplate?.bodyText
    || config.body
    || config.template
    || 'Link do personalizacji: {{personalizationUrl}}';

  const subject = renderTemplate(String(subjectSource), variables);
  const body = renderTemplate(String(bodySource), variables);

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
        String(subjectSource),
        { ...variables, productName: '{{productName}}', quantity: '{{quantity}}' },
      ),
      body: renderTemplate(
        String(bodySource),
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

/**
 * Mail o zamowieniu — inaczej niz SEND_EMAIL nie dotyka sprawy personalizacji
 * ani tokenow, wiec dziala przy wyzwalaczach zamowienia i przesylki.
 */
async function executeSendOrderEmail(config: Record<string, any>, context: AutomationContext): Promise<void> {
  const order = context.caseData?.order;
  if (!order?.id) throw new Error('Brak zamówienia dla akcji „Wyślij email o zamówieniu”');

  const shipment = (context.caseData?.shipment ?? {}) as Record<string, any>;
  const trackingNumber = String(shipment.trackingNumber ?? '').trim();
  const shipmentStatus = String(shipment.status ?? '').trim();
  const stage = shipmentStageFromStatus(shipmentStatus);

  const variables = {
    customerName: order.customerName || '',
    orderReference: order.orderReference || '',
    shopName: order.shop?.name || '',
    trackingNumber,
    trackingUrl: shipmentTrackingUrl(trackingNumber) ?? '',
    carrierService: shipmentServiceLabel(shipment.service) ?? '',
    pickupPoint: String(shipment.targetPoint ?? ''),
    shipmentStatus,
    shipmentStage: shipmentStageLabel(stage),
  };

  const to = config.to && config.to !== 'customer'
    ? renderTemplate(String(config.to), variables)
    : order.customerEmail;
  if (!to) throw new Error('Zamówienie nie ma adresu e-mail odbiorcy');

  // Tresc z biblioteki szablonow wygrywa nad wklejona w regule; regula bez
  // `templateId` dziala jak dotad, wiec starsze reguly zostaja nietkniete.
  const template = await findEmailTemplateForAction({
    templateId: config.templateId,
    shopId: order.shop?.id ?? null,
  });

  const subject = renderTemplate(
    String(template?.subject || config.subject || 'Zamówienie {{orderReference}}'),
    variables,
  );
  const body = renderTemplate(String(template?.bodyText || config.body || config.template || ''), variables);
  if (!body.trim()) {
    throw new Error(config.templateId
      ? 'Szablon wskazany w regule nie istnieje, jest wyłączony albo należy do innego sklepu'
      : 'Akcja „Wyślij email o zamówieniu” nie ma treści wiadomości');
  }

  // Nadawca zalezy od SKLEPU: kazdy wysyla z wlasnej domeny, inaczej SPF
  // i DKIM nie zgadzaja sie z adresem i poczta laduje w spamie.
  const sender = order.shop?.id ? await createShopEmailService(order.shop.id).catch(() => null) : null;
  const mailer = sender ?? emailService;
  if (!sender && !emailService.isConfigured()) {
    throw new Error('Email service not configured');
  }

  await mailer.sendAutomationEmail({
    to,
    subject,
    body,
    shopName: String(variables.shopName),
  });

  console.log(`[Automation] Order email sent to ${to} for order ${order.orderReference}: ${subject}`);
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
        case AutomationActionType.SEND_ORDER_EMAIL:
          await executeSendOrderEmail(action.config || {}, context);
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

interface AutomationRunOutcome {
  automationId: string;
  automationName: string;
  actionResults: AutomationActionExecutionResult[];
}

interface RunAutomationsInput {
  trigger: string;
  tenantId: string;
  context: AutomationContext;
  /**
   * Klucz idempotencji, np. `shipment:<id>:ready_to_pickup`. Gdy reguła ma go
   * juz w historii, pomijamy ja bez wykonania akcji — inaczej powtorzony
   * przebieg synchronizacji wyslalby klientowi drugiego maila o tym samym.
   */
  contextKey?: string | null;
  subjectLabel?: string | null;
  /** Komunikaty traktowane jak blad reguly mimo braku wyjatku (np. wstrzymana faktura). */
  blockingMessages?: (results: AutomationActionExecutionResult[]) => string[];
}

/**
 * Wspolny przebieg dla wszystkich wyzwalaczy: dopasowanie warunkow, blokada
 * powtorki, wykonanie akcji i slad w historii.
 */
async function runAutomationsForTrigger(input: RunAutomationsInput): Promise<AutomationRunOutcome[]> {
  const automations = await prisma.automation.findMany({
    where: {
      tenantId: input.tenantId,
      trigger: input.trigger,
      isActive: true,
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
  });

  const outcomes: AutomationRunOutcome[] = [];

  for (const automation of automations) {
    const dryRun = buildDryRunResult(automation.id, automation.conditions, input.context);

    if (!dryRun.matched) {
      await recordAutomationRun({
        automationId: automation.id,
        tenantId: input.tenantId,
        trigger: input.trigger,
        status: 'SKIPPED',
        matched: false,
        // Bez klucza: pominiecie nie moze zablokowac pozniejszego wykonania,
        // gdy warunki w koncu zostana spelnione.
        contextKey: null,
        subjectLabel: input.subjectLabel ?? null,
        payload: { conditionResults: dryRun.conditionResults },
      });
      continue;
    }

    const run = await reserveAutomationRun({
      automationId: automation.id,
      tenantId: input.tenantId,
      trigger: input.trigger,
      contextKey: input.contextKey ?? null,
      subjectLabel: input.subjectLabel ?? null,
    });
    if (!run) continue;

    const actions = Array.isArray(automation.actions)
      ? automation.actions as unknown as AutomationAction[]
      : [];
    const actionResults = await executeActions(actions, input.context);
    const actionErrors = actionResults
      .filter((result) => result.error)
      .map((result) => `${result.type}: ${result.error}`);
    const errors = [...actionErrors, ...(input.blockingMessages?.(actionResults) ?? [])];
    const now = new Date();

    await prisma.automation.update({
      where: { id: automation.id },
      data: {
        runCount: { increment: 1 },
        lastRunAt: now,
        ...(errors.length > 0
          ? { lastErrorAt: now, lastErrorMessage: errors.join('\n').slice(0, 5000) }
          : { lastErrorMessage: null }),
      },
    });

    await prisma.automationRun.update({
      where: { id: run.id },
      data: {
        status: errors.length > 0 ? 'ERROR' : 'OK',
        error: errors.length > 0 ? errors.join('\n').slice(0, 5000) : null,
        finishedAt: now,
        payloadJson: {
          conditionResults: dryRun.conditionResults,
          actions: actionResults.map((result) => ({ type: result.type, error: result.error ?? null })),
        } as unknown as Prisma.InputJsonValue,
      },
    }).catch((error) => {
      // Historia nie moze przewrocic wykonanej juz automatyzacji.
      console.error('[Automation] Nie udało się zapisać wyniku uruchomienia:', error);
    });

    outcomes.push({
      automationId: automation.id,
      automationName: automation.name,
      actionResults,
    });
  }

  return outcomes;
}

/**
 * Rezerwuje wpis w historii PRZED wykonaniem akcji. Kolizja klucza znaczy, ze
 * ten sam kontekst obsluzyla juz wczesniejsza proba — wtedy zwracamy null
 * i reguła nie rusza po raz drugi.
 */
async function reserveAutomationRun(input: {
  automationId: string;
  tenantId: string;
  trigger: string;
  contextKey: string | null;
  subjectLabel: string | null;
}): Promise<{ id: string } | null> {
  try {
    return await prisma.automationRun.create({
      data: {
        automationId: input.automationId,
        tenantId: input.tenantId,
        trigger: input.trigger,
        status: 'RUNNING',
        matched: true,
        contextKey: input.contextKey,
        subjectLabel: input.subjectLabel,
      },
      select: { id: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return null;
    }
    throw error;
  }
}

async function recordAutomationRun(input: {
  automationId: string;
  tenantId: string;
  trigger: string;
  status: string;
  matched: boolean;
  contextKey: string | null;
  subjectLabel: string | null;
  payload?: Record<string, unknown>;
}) {
  try {
    await prisma.automationRun.create({
      data: {
        automationId: input.automationId,
        tenantId: input.tenantId,
        trigger: input.trigger,
        status: input.status,
        matched: input.matched,
        contextKey: input.contextKey,
        subjectLabel: input.subjectLabel,
        finishedAt: new Date(),
        ...(input.payload ? { payloadJson: input.payload as unknown as Prisma.InputJsonValue } : {}),
      },
    });
  } catch (error) {
    console.error('[Automation] Nie udało się zapisać historii automatyzacji:', error);
  }
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

    await runAutomationsForTrigger({
      trigger: context.trigger,
      tenantId,
      context,
      subjectLabel: context.caseData?.order?.orderReference ?? context.caseId,
    });
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

    const outcomes = await runAutomationsForTrigger({
      trigger: AutomationTrigger.ORDER_INVOICE_ISSUED,
      tenantId,
      context,
      // Faktura wystawia sie raz, wiec jej numer wystarcza za blokade powtorki.
      contextKey: `invoice:${input.invoiceId}`,
      subjectLabel: order.orderReference,
    });

    if (outcomes.length === 0) {
      return { status: 'NONE', reason: 'Brak aktywnej automatyzacji dla wystawionej faktury' };
    }

    const warehouseDocumentAction = outcomes
      .flatMap((outcome) => outcome.actionResults)
      .find((result) => result.warehouseDocumentAction)?.warehouseDocumentAction;

    return warehouseDocumentAction ?? {
      status: 'NONE',
      reason: 'Automatyzacja nie zwróciła akcji WZ',
    };
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

    let shipmentInvoiceAction: ShipmentInvoiceResult | null = null;

    const outcomes = await runAutomationsForTrigger({
      trigger: AutomationTrigger.ORDER_SHIPMENT_CREATED,
      tenantId,
      context,
      subjectLabel: order.orderReference,
      // Wstrzymanie z powodu brakow to nie awaria akcji, ale MUSI zostac slad:
      // baner w panelu znika po odswiezeniu, a faktury i tak nie ma.
      blockingMessages: (results) => {
        const action = results.find((result) => result.shipmentInvoiceAction)?.shipmentInvoiceAction;
        if (action) shipmentInvoiceAction = action;
        return action && ['STOCK_MISSING', 'FAILED'].includes(action.status)
          ? [`${AutomationActionType.ISSUE_INVOICE_AFTER_SHIPMENT}: ${action.message}`]
          : [];
      },
    });

    if (outcomes.length === 0) return null;
    return shipmentInvoiceAction;
  } catch (error) {
    return {
      status: 'FAILED',
      message: error instanceof Error ? error.message : 'Nie udało się uruchomić automatyzacji listu przewozowego',
      warehouseDocument: { status: 'NONE', reason: 'Automatyzacja nie została wykonana' },
    };
  }
}

/**
 * Zmiana statusu przesylki u przewoznika. Stad ida maile „kurier doreczy dzis"
 * i „paczka czeka w paczkomacie" — synchronizacja wola to raz na kazda realna
 * zmiane, a `contextKey` pilnuje, zeby ponowny przebieg nic nie powtorzyl.
 */
export async function triggerShipmentStatusAutomations(input: {
  orderId: string;
  shipmentId: string;
  shipment: Record<string, unknown>;
  previousStatus?: string | null;
}): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: input.orderId },
      include: { shop: true },
    });
    if (!order) return;

    // Warunki reguł pisze sie na etapie (`shipment.stage`), bo surowych
    // statusow przewoznika sa dziesiatki i dochodza nowe. Etap dokladamy tu,
    // zeby regula widziala go obok surowej nazwy.
    const status = String(input.shipment.status ?? '');
    const shipment = {
      ...input.shipment,
      stage: shipmentStageFromStatus(status),
      stageLabel: shipmentStageLabel(shipmentStageFromStatus(status)),
      previousStage: input.previousStatus ? shipmentStageFromStatus(input.previousStatus) : null,
    };

    const context: AutomationContext = {
      caseId: order.id,
      orderId: order.id,
      shipmentId: input.shipmentId,
      trigger: AutomationTrigger.ORDER_SHIPMENT_STATUS_CHANGED,
      previousStatus: input.previousStatus ?? undefined,
      newStatus: status,
      caseData: { order, shipment },
    };

    const tenantId = order.shop.tenantId;
    if (!tenantId) return;

    await runAutomationsForTrigger({
      trigger: AutomationTrigger.ORDER_SHIPMENT_STATUS_CHANGED,
      tenantId,
      context,
      contextKey: `shipment:${input.shipmentId}:${status || 'unknown'}`,
      subjectLabel: order.orderReference,
    });
  } catch (error) {
    console.error('[Automation] Nie udało się uruchomić automatyzacji statusu przesyłki:', error);
  }
}

export interface AutomationRunMetrics {
  /** Siedem dni wstecz, od najstarszego — panel rysuje z tego sparkline. */
  daily: Array<{ date: string; total: number; errors: number }>;
  total: number;
  errors: number;
}

const METRICS_WINDOW_DAYS = 7;

export async function listAutomations() {
  const automations = await prisma.automation.findMany({
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  });
  if (automations.length === 0) return [];

  const metrics = await loadAutomationMetrics(automations.map((automation) => automation.id));

  return automations.map((automation) => ({
    ...automation,
    metrics: metrics.get(automation.id) ?? emptyMetrics(),
  }));
}

function emptyMetrics(): AutomationRunMetrics {
  const daily = Array.from({ length: METRICS_WINDOW_DAYS }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (METRICS_WINDOW_DAYS - 1 - index));
    return { date: date.toISOString().slice(0, 10), total: 0, errors: 0 };
  });
  return { daily, total: 0, errors: 0 };
}

/** Uruchomienia z ostatnich 7 dni per reguła i dzień — dane pod sparkline w liście. */
async function loadAutomationMetrics(automationIds: string[]): Promise<Map<string, AutomationRunMetrics>> {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (METRICS_WINDOW_DAYS - 1));

  const runs = await prisma.automationRun.findMany({
    where: {
      automationId: { in: automationIds },
      matched: true,
      createdAt: { gte: since },
    },
    select: { automationId: true, status: true, createdAt: true },
  });

  const result = new Map<string, AutomationRunMetrics>();
  for (const run of runs) {
    const metrics = result.get(run.automationId) ?? emptyMetrics();
    const day = run.createdAt.toISOString().slice(0, 10);
    const bucket = metrics.daily.find((item) => item.date === day);
    if (bucket) {
      bucket.total += 1;
      if (run.status === 'ERROR') bucket.errors += 1;
    }
    metrics.total += 1;
    if (run.status === 'ERROR') metrics.errors += 1;
    result.set(run.automationId, metrics);
  }

  return result;
}

export async function listAutomationRuns(automationId: string, limit = 25) {
  await getAutomationById(automationId);
  return prisma.automationRun.findMany({
    where: { automationId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
  });
}

/**
 * Zbiorcza zmiana priorytetow po przeciagnieciu wiersza. Wyzszy priorytet =
 * wczesniejsze wykonanie (tak samo jak w `orderBy` przy wyzwalaniu reguł).
 */
export async function reorderAutomations(items: Array<{ id: string; priority: number }>) {
  const ids = items.map((item) => item.id);
  const owned = await prisma.automation.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((automation) => automation.id));
  const allowed = items.filter((item) => ownedIds.has(item.id));

  await prisma.$transaction(allowed.map((item) => prisma.automation.update({
    where: { id: item.id },
    data: { priority: item.priority },
  })));

  return { updated: allowed.length };
}

export async function duplicateAutomation(id: string) {
  const source = await getAutomationById(id);

  return prisma.automation.create({
    data: {
      tenantId: source.tenantId,
      name: `${source.name} (kopia)`,
      description: source.description,
      trigger: source.trigger,
      conditions: source.conditions as Prisma.InputJsonValue,
      actions: source.actions as Prisma.InputJsonValue,
      // Kopia startuje wylaczona: dwie identyczne, aktywne reguly zrobilyby
      // wszystko po dwa razy, zanim ktokolwiek zdazy poprawic warunki.
      isActive: false,
      priority: source.priority,
    },
  });
}

export function listAutomationScenarios() {
  return AUTOMATION_SCENARIOS;
}

export async function createAutomationFromScenario(scenarioId: string, overrides: { name?: string } = {}) {
  const scenario = getAutomationScenario(scenarioId);
  if (!scenario) throw new Error('Nie znamy takiego scenariusza');

  return createAutomation({
    name: overrides.name || scenario.name,
    description: scenario.summary,
    trigger: scenario.trigger,
    conditions: scenario.conditions,
    actions: scenario.actions,
    // Scenariusze piszace do klienta wchodza wylaczone — najpierw podglad tresci.
    isActive: !scenario.startsDisabled,
    priority: scenario.priority,
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
