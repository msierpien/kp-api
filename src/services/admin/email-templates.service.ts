import prisma from '../../lib/prisma';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { createShopEmailService } from './email-settings.service';
import { emailService } from '../email/email.service';

export type EmailTemplateScope = 'ORDER' | 'CASE';

export interface EmailTemplateVariable {
  name: string;
  description: string;
  sample: string;
}

/**
 * Zmienne dostępne w szablonie. Panel pokazuje z tego listę obok edytora, a
 * podgląd podstawia `sample` — inaczej autor treści zgaduje, co ma pod ręką.
 */
export const EMAIL_TEMPLATE_VARIABLES: Record<EmailTemplateScope, EmailTemplateVariable[]> = {
  ORDER: [
    { name: 'customerName', description: 'Imię i nazwisko klienta', sample: 'Anna Kowalska' },
    { name: 'orderReference', description: 'Numer zamówienia', sample: 'KP-2903' },
    { name: 'shopName', description: 'Nazwa sklepu', sample: 'Kreatywne Papierki' },
    { name: 'trackingNumber', description: 'Numer listu przewozowego', sample: '620112345678901234567890' },
    { name: 'trackingUrl', description: 'Link do śledzenia przesyłki', sample: 'https://inpost.pl/sledzenie-przesylek?number=6201…' },
    { name: 'carrierService', description: 'Usługa kuriera', sample: 'Paczkomat' },
    { name: 'pickupPoint', description: 'Punkt odbioru', sample: 'KRA01M' },
    { name: 'shipmentStage', description: 'Etap doręczenia', sample: 'Czeka w paczkomacie' },
  ],
  CASE: [
    { name: 'customerName', description: 'Imię i nazwisko klienta', sample: 'Anna Kowalska' },
    { name: 'orderReference', description: 'Numer zamówienia', sample: 'KP-2903' },
    { name: 'shopName', description: 'Nazwa sklepu', sample: 'Kreatywne Papierki' },
    { name: 'productName', description: 'Nazwa produktu', sample: 'Zaproszenia ślubne „Lawenda”' },
    { name: 'quantity', description: 'Liczba sztuk', sample: '80' },
    { name: 'personalizationUrl', description: 'Link do personalizacji', sample: 'https://personalizacja.example/abc123' },
  ],
};

export interface EmailTemplateInput {
  key: string;
  name: string;
  description?: string | null;
  subject: string;
  bodyText: string;
  scope?: EmailTemplateScope;
  shopId?: string | null;
  isActive?: boolean;
}

function resolveTenantId() {
  const context = getTenantContext();
  const tenantId = context?.role === 'SUPER_ADMIN'
    ? context.overrideTenantId || context.tenantId
    : context?.tenantId;
  if (!tenantId) throw new Error('Brak tenanta dla szablonu wiadomości');
  return tenantId;
}

export async function listEmailTemplates(scope?: EmailTemplateScope) {
  return prisma.emailTemplate.findMany({
    where: scope ? { scope } : {},
    orderBy: [{ scope: 'asc' }, { name: 'asc' }],
    include: { shop: { select: { id: true, name: true } } },
  });
}

export async function getEmailTemplateById(id: string) {
  const template = await prisma.emailTemplate.findFirst({
    where: { id },
    include: { shop: { select: { id: true, name: true } } },
  });
  if (!template) throw new Error('Szablon nie został znaleziony');
  return template;
}

/**
 * Szablon dla akcji automatyzacji. Wpis przypisany do sklepu wygrywa nad
 * wspólnym — każdy sklep pisze własnym głosem, a wspólny jest awaryjny.
 */
export async function findEmailTemplateForAction(input: { templateId?: string | null; shopId?: string | null }) {
  if (!input.templateId) return null;

  const template = await prisma.emailTemplate.findFirst({
    where: { id: input.templateId, isActive: true },
  });
  if (!template) return null;
  if (template.shopId && input.shopId && template.shopId !== input.shopId) return null;

  return template;
}

export async function createEmailTemplate(input: EmailTemplateInput) {
  const tenantId = resolveTenantId();
  await assertKeyIsFree(tenantId, input.key);

  return prisma.emailTemplate.create({
    data: {
      tenantId,
      key: normalizeKey(input.key),
      name: input.name.trim(),
      description: input.description ?? null,
      subject: input.subject,
      bodyText: input.bodyText,
      scope: input.scope ?? 'ORDER',
      shopId: input.shopId || null,
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateEmailTemplate(id: string, input: Partial<EmailTemplateInput>) {
  const existing = await getEmailTemplateById(id);
  if (input.key && normalizeKey(input.key) !== existing.key) {
    await assertKeyIsFree(existing.tenantId, input.key);
  }

  return prisma.emailTemplate.update({
    where: { id },
    data: {
      ...(input.key ? { key: normalizeKey(input.key) } : {}),
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.bodyText !== undefined ? { bodyText: input.bodyText } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.shopId !== undefined ? { shopId: input.shopId || null } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
}

export async function deleteEmailTemplate(id: string) {
  await getEmailTemplateById(id);
  return prisma.emailTemplate.delete({ where: { id } });
}

/** Podgląd na przykładowych danych — bez ruszania czyjegokolwiek zamówienia. */
export function renderEmailTemplatePreview(input: { subject: string; bodyText: string; scope?: EmailTemplateScope }) {
  const variables = sampleVariables(input.scope ?? 'ORDER');
  return {
    subject: applyVariables(input.subject, variables),
    body: applyVariables(input.bodyText, variables),
    variables,
  };
}

export async function sendEmailTemplateTest(input: {
  id: string;
  to: string;
}) {
  const template = await getEmailTemplateById(input.id);
  const preview = renderEmailTemplatePreview({
    subject: template.subject,
    bodyText: template.bodyText,
    scope: template.scope as EmailTemplateScope,
  });

  // Nadawca zalezy od sklepu — test ma isc ta sama droga co wysylka realna,
  // inaczej sprawdzalby cos innego niz to, co dostanie klient.
  const sender = template.shopId ? await createShopEmailService(template.shopId).catch(() => null) : null;
  const mailer = sender ?? emailService;
  if (!sender && !emailService.isConfigured()) {
    throw new Error('Poczta nie jest skonfigurowana');
  }

  await mailer.sendAutomationEmail({
    to: input.to,
    subject: `[TEST] ${preview.subject}`,
    body: preview.body,
    shopName: 'Test szablonu',
  });

  return { sent: true, to: input.to };
}

export function applyVariables(template: string, variables: Record<string, unknown>) {
  let rendered = String(template ?? '');
  for (const [key, value] of Object.entries(variables)) {
    rendered = rendered.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), String(value ?? ''));
  }
  return rendered;
}

function sampleVariables(scope: EmailTemplateScope): Record<string, string> {
  return Object.fromEntries(
    EMAIL_TEMPLATE_VARIABLES[scope].map((variable) => [variable.name, variable.sample]),
  );
}

function normalizeKey(key: string) {
  return key.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

async function assertKeyIsFree(tenantId: string, key: string) {
  const normalized = normalizeKey(key);
  if (!normalized) throw new Error('Klucz szablonu nie może być pusty');

  const existing = await prisma.emailTemplate.findFirst({
    where: { tenantId, key: normalized },
    select: { id: true },
  });
  if (existing) throw new Error(`Szablon o kluczu „${normalized}” już istnieje`);
}

export function listEmailTemplateVariables(scope: EmailTemplateScope) {
  return EMAIL_TEMPLATE_VARIABLES[scope] ?? EMAIL_TEMPLATE_VARIABLES.ORDER;
}

export function tenantIdForTemplates() {
  return getTenantId();
}
