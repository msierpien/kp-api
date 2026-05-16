import prisma from '../../lib/prisma';
import { emailService } from '../email/email.service';
import { generateAccessToken, maskToken } from '../../lib/token';

/**
 * Typy triggerów automatyzacji
 */
export enum AutomationTrigger {
  CASE_CREATED = 'CASE_CREATED',
  CASE_STATUS_CHANGED = 'CASE_STATUS_CHANGED',
  CASE_SUBMITTED = 'CASE_SUBMITTED',
  CASE_TIME_ELAPSED = 'CASE_TIME_ELAPSED',
}

/**
 * Typy akcji automatyzacji
 */
export enum AutomationActionType {
  SEND_EMAIL = 'SEND_EMAIL',
  CHANGE_STATUS = 'CHANGE_STATUS',
  ADD_NOTE = 'ADD_NOTE',
  WEBHOOK = 'WEBHOOK',
}

/**
 * Interfejs warunku
 */
interface AutomationCondition {
  field: string; // 'status', 'templateId', 'shopId', 'createdAt'
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than' | 'in';
  value: any;
  logicOperator?: 'AND' | 'OR'; // dla następnego warunku
}

/**
 * Interfejs akcji
 */
interface AutomationAction {
  type: AutomationActionType;
  config: any; // specyficzna konfiguracja dla typu akcji
}

/**
 * Context przekazywany do automatyzacji
 */
interface AutomationContext {
  caseId: string;
  trigger: AutomationTrigger;
  caseData?: any; // pełne dane case
  previousStatus?: string; // dla CASE_STATUS_CHANGED
  newStatus?: string; // dla CASE_STATUS_CHANGED
}

/**
 * Ewaluuje czy warunki są spełnione
 */
function evaluateConditions(
  conditions: AutomationCondition[],
  context: AutomationContext
): boolean {
  if (!conditions || conditions.length === 0) {
    return true; // brak warunków = zawsze spełnione
  }

  const caseData = context.caseData;
  if (!caseData) {
    return false;
  }

  let result = true;
  let currentLogicOperator: 'AND' | 'OR' = 'AND';

  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i];
    let conditionResult = false;

    // Pobierz wartość z case data
    const fieldValue = getFieldValue(caseData, condition.field);

    // Ewaluuj operator
    switch (condition.operator) {
      case 'equals':
        conditionResult = fieldValue === condition.value;
        break;
      case 'not_equals':
        conditionResult = fieldValue !== condition.value;
        break;
      case 'contains':
        conditionResult =
          typeof fieldValue === 'string' &&
          fieldValue.toLowerCase().includes(String(condition.value).toLowerCase());
        break;
      case 'greater_than':
        conditionResult = fieldValue > condition.value;
        break;
      case 'less_than':
        conditionResult = fieldValue < condition.value;
        break;
      case 'in':
        conditionResult = Array.isArray(condition.value) && condition.value.includes(fieldValue);
        break;
    }

    // Połącz z poprzednim wynikiem
    if (i === 0) {
      result = conditionResult;
    } else {
      if (currentLogicOperator === 'AND') {
        result = result && conditionResult;
      } else {
        result = result || conditionResult;
      }
    }

    // Zapisz operator logiczny dla następnej iteracji
    currentLogicOperator = condition.logicOperator || 'AND';
  }

  return result;
}

/**
 * Pobiera wartość pola z obiektu case (obsługa nested fields)
 */
function getFieldValue(obj: any, field: string): any {
  const parts = field.split('.');
  let value = obj;

  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part];
    } else {
      return undefined;
    }
  }

  return value;
}

/**
 * Wykonuje akcje automatyzacji
 */
async function executeActions(
  actions: AutomationAction[],
  context: AutomationContext
): Promise<void> {
  const caseData = context.caseData;

  for (const action of actions) {
    try {
      switch (action.type) {
        case AutomationActionType.SEND_EMAIL:
          await executeSendEmail(action.config, caseData);
          break;

        case AutomationActionType.CHANGE_STATUS:
          await executeChangeStatus(action.config, context.caseId);
          break;

        case AutomationActionType.ADD_NOTE:
          await executeAddNote(action.config, context.caseId);
          break;

        case AutomationActionType.WEBHOOK:
          await executeWebhook(action.config, context);
          break;

        default:
          console.warn(`[Automation] Unknown action type: ${action.type}`);
      }
    } catch (error) {
      console.error(`[Automation] Failed to execute action ${action.type}:`, error);
      // Kontynuuj wykonywanie pozostałych akcji
    }
  }
}

/**
 * Akcja: Wyślij email
 */
async function executeSendEmail(config: any, caseData: any): Promise<void> {
  const { to, subject, template } = config;

  if (!emailService.isConfigured()) {
    throw new Error('Email service not configured');
  }

  if (!caseData?.id) {
    throw new Error('Missing case data for email automation');
  }

  // Każdy email dostaje świeży token: zapisujemy nowy hash i zaszyfrowany token w bazie
  const { token: accessToken, hash: tokenHash, encrypted: tokenEncrypted } = generateAccessToken();
  await prisma.personalizationCase.update({
    where: { id: caseData.id },
    data: {
      customerTokenHash: tokenHash,
      customerTokenEncrypted: tokenEncrypted,
      tokenActive: true,
      updatedAt: new Date(),
    },
  });
  console.log(`[Automation] Generated new token for case ${caseData.id}: ${maskToken(accessToken)}`);

  const baseUrl = config.frontend.portalUrl;
  const personalizationUrl = `${baseUrl}/${accessToken}`;

  // Podstawowe zmienne do template
  const variables = {
    customerName: caseData.order?.customerName || '',
    orderReference: caseData.order?.orderReference || '',
    productName: caseData.orderItem?.productNameSnapshot || '',
    shopName: caseData.order?.shop?.name || '',
    personalizationUrl,
  };

  // Prosta zamiana zmiennych w template
  let emailBody = template || 'Link do personalizacji: {{personalizationUrl}}';
  for (const [key, value] of Object.entries(variables)) {
    emailBody = emailBody.replace(new RegExp(`{{${key}}}`, 'g'), String(value));
  }

  const emailTo = to === 'customer' ? caseData.order?.customerEmail : to;

  await emailService.sendPersonalizationEmail({
    to: emailTo,
    customerName: variables.customerName,
    orderReference: variables.orderReference,
    shopName: variables.shopName,
    items: [
      {
        productName: variables.productName,
        quantity: caseData.orderItem?.quantity || 1,
        personalizationUrl,
      },
    ],
    baseUrl,
  });

  console.log(`[Automation] ✉️  Email sent to ${emailTo} for case ${caseData.id}`);
}

/**
 * Akcja: Zmień status
 */
async function executeChangeStatus(config: any, caseId: string): Promise<void> {
  const { status } = config;

  await prisma.personalizationCase.update({
    where: { id: caseId },
    data: {
      status,
      updatedAt: new Date(),
    },
  });

  console.log(`[Automation] 🔄 Status changed to ${status} for case ${caseId}`);
}

/**
 * Akcja: Dodaj notatkę
 */
async function executeAddNote(config: any, caseId: string): Promise<void> {
  const { note } = config;

  const currentCase = await prisma.personalizationCase.findUnique({
    where: { id: caseId },
    select: { notesInternal: true },
  });

  const existingNotes = currentCase?.notesInternal || '';
  const timestamp = new Date().toISOString();
  const newNote = `\n[${timestamp}] [AUTOMATION] ${note}`;

  await prisma.personalizationCase.update({
    where: { id: caseId },
    data: {
      notesInternal: existingNotes + newNote,
      updatedAt: new Date(),
    },
  });

  console.log(`[Automation] 📝 Note added to case ${caseId}`);
}

/**
 * Akcja: Webhook
 */
async function executeWebhook(config: any, context: AutomationContext): Promise<void> {
  const { url, method = 'POST', headers = {} } = config;

  const payload = {
    trigger: context.trigger,
    caseId: context.caseId,
    timestamp: new Date().toISOString(),
    data: context.caseData,
  };

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
  }

  console.log(`[Automation] 🌐 Webhook sent to ${url} for case ${context.caseId}`);
}

/**
 * Główna funkcja triggerująca automatyzacje
 */
export async function triggerAutomations(context: AutomationContext): Promise<void> {
  try {
    // Pobierz wszystkie aktywne automatyzacje dla danego triggera
    const automations = await prisma.automation.findMany({
      where: {
        trigger: context.trigger,
        isActive: true,
      },
      orderBy: {
        priority: 'desc', // Wyższy priorytet = wcześniej
      },
    });

    if (automations.length === 0) {
      return; // Brak automatyzacji
    }

    // Pobierz pełne dane case jeśli nie są dostarczone
    if (!context.caseData) {
      context.caseData = await prisma.personalizationCase.findUnique({
        where: { id: context.caseId },
        include: {
          order: {
            include: {
              shop: true,
            },
          },
          orderItem: true,
          template: true,
        },
      });
    }

    console.log(
      `[Automation] Processing ${automations.length} automations for trigger: ${context.trigger}`
    );

    // Wykonaj każdą automatyzację
    for (const automation of automations) {
      try {
        const conditions = automation.conditions as unknown as AutomationCondition[];
        const actions = automation.actions as unknown as AutomationAction[];

        // Sprawdź warunki
        const conditionsMet = evaluateConditions(conditions, context);

        if (conditionsMet) {
          console.log(`[Automation] ✅ Conditions met for: ${automation.name}`);
          await executeActions(actions, context);
        } else {
          console.log(`[Automation] ⏭️  Conditions not met for: ${automation.name}`);
        }
      } catch (error) {
        console.error(`[Automation] Failed to execute automation ${automation.name}:`, error);
        // Kontynuuj z następną automatyzacją
      }
    }
  } catch (error) {
    console.error('[Automation] Failed to trigger automations:', error);
  }
}

/**
 * CRUD operations
 */

export async function listAutomations() {
  return await prisma.automation.findMany({
    orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function getAutomationById(id: string) {
  const automation = await prisma.automation.findUnique({
    where: { id },
  });

  if (!automation) {
    throw new Error('Automation not found');
  }

  return automation;
}

export async function createAutomation(data: {
  name: string;
  description?: string;
  trigger: string;
  conditions: any;
  actions: any;
  isActive?: boolean;
  priority?: number;
}) {
  return await prisma.automation.create({
    data: {
      name: data.name,
      description: data.description,
      trigger: data.trigger,
      conditions: data.conditions,
      actions: data.actions,
      isActive: data.isActive ?? true,
      priority: data.priority ?? 0,
    },
  });
}

export async function updateAutomation(
  id: string,
  data: {
    name?: string;
    description?: string;
    trigger?: string;
    conditions?: any;
    actions?: any;
    isActive?: boolean;
    priority?: number;
  }
) {
  return await prisma.automation.update({
    where: { id },
    data: {
      ...data,
      updatedAt: new Date(),
    },
  });
}

export async function deleteAutomation(id: string) {
  return await prisma.automation.delete({
    where: { id },
  });
}

export async function toggleAutomation(id: string, isActive: boolean) {
  return await prisma.automation.update({
    where: { id },
    data: { isActive },
  });
}
