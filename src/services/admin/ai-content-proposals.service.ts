import prisma from '../../lib/prisma';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import {
  AiLimitExceededError,
  DEFAULT_TIMEOUT_MS,
  assertAiLimits,
  extractJson,
  getProviderApiKey,
  resolveProviderAndModel,
  runAiCall,
} from '../ai/provider-client';

export { AiLimitExceededError };

type AiContentAction = 'GENERATE' | 'IMPROVE' | 'SHORTEN' | 'SEO';

export interface AiContentProposalInput {
  shopId?: string;
  templateId?: string | null;
  action: AiContentAction;
  imageUrl?: string | null;
  inspiration?: string | null;
  current?: {
    name?: string;
    shortDescriptionHtml?: string;
    longDescriptionHtml?: string;
    metaTitle?: string;
    metaDescription?: string;
    linkRewrite?: string;
  };
  categories?: Array<{ id?: number | string; name?: string; isDefault?: boolean }>;
  features?: Array<{ name?: string; value?: string }>;
}

type NormalizedProposal = {
  name: string;
  shortDescriptionHtml: string;
  longDescriptionHtml: string;
  metaTitle: string;
  metaDescription: string;
  /** Legacy field kept for older admin clients. PrestaShop 9 product SEO no longer uses it. */
  metaKeywords: string;
  linkRewrite: string;
  notes: string[];
};

type GenerateContext = {
  tenantId: string;
  userId?: string | null;
  source?: 'INLINE' | 'BULK';
  bulkJobId?: string | null;
  bulkJobItemId?: string | null;
};

function requireTenantId() {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;
  if (!tenantId) throw new Error('Tenant context is required for AI content proposal');
  return tenantId;
}

function getUserId() {
  return getTenantContext()?.userId || null;
}

async function getProductForAi(productId: string, tenantId: string) {
  return prisma.warehouseProduct.findFirst({
    where: { id: productId, tenantId },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
      retailPrice: true,
      purchasePrice: true,
    },
  });
}

function stripHtml(value?: string | null) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeBasicHtml(value?: string | null) {
  const allowed = new Set(['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h2', 'h3']);
  return String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?([a-z0-9-]+)(\s[^>]*)?>/gi, (match, tag) => {
      const normalized = String(tag).toLowerCase();
      if (!allowed.has(normalized)) return '';
      return match.startsWith('</') ? `</${normalized}>` : match.replace(/\s[^>]*/i, '');
    })
    .trim();
}

function clamp(value: string, max: number) {
  return value.length > max ? value.slice(0, max).trim() : value;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** Pola propozycji trafiajace do dziennika zuzycia (bez `notes`). */
const PROPOSAL_FIELDS = [
  'name',
  'shortDescriptionHtml',
  'longDescriptionHtml',
  'metaTitle',
  'metaDescription',
  'metaKeywords',
  'linkRewrite',
] as const;

function normalizeProposal(raw: any, fallbackName: string): NormalizedProposal {
  const name = String(raw?.name ?? fallbackName ?? '').trim();
  const shortDescriptionHtml = sanitizeBasicHtml(raw?.shortDescriptionHtml);
  const longDescriptionHtml = sanitizeBasicHtml(raw?.longDescriptionHtml);
  const metaTitle = clamp(String(raw?.metaTitle ?? name).trim(), 70);
  const metaDescription = clamp(String(raw?.metaDescription ?? stripHtml(shortDescriptionHtml || longDescriptionHtml)).trim(), 170);
  const linkRewrite = slugify(String(raw?.linkRewrite ?? name).trim());
  const notes = Array.isArray(raw?.notes) ? raw.notes.map((note: unknown) => String(note)).filter(Boolean) : [];

  return {
    name,
    shortDescriptionHtml,
    longDescriptionHtml,
    metaTitle,
    metaDescription,
    metaKeywords: '',
    linkRewrite,
    notes,
  };
}

function buildPrompt(input: AiContentProposalInput, product: any, template: any) {
  const current = input.current ?? {};
  const categories = (input.categories ?? []).map((category) => category.name).filter(Boolean).join(', ') || 'brak';
  const features = (input.features ?? []).map((feature) => `${feature.name}: ${feature.value}`).filter(Boolean).join('\n') || 'brak';
  const actionLabels: Record<AiContentAction, string> = {
    GENERATE: 'wygeneruj kompletny opis i SEO',
    IMPROVE: 'popraw istniejacy opis bez zmiany faktow',
    SHORTEN: 'skroc i uporzadkuj opis',
    SEO: 'ulepsz pola SEO i krotki opis',
  };

  return [
    `Zadanie: ${actionLabels[input.action]}.`,
    'Zwróć tylko JSON, bez Markdown i bez komentarza.',
    'Wymagany ksztalt JSON: {"name":"","shortDescriptionHtml":"","longDescriptionHtml":"","metaTitle":"","metaDescription":"","linkRewrite":"","notes":[]}.',
    'Nie generuj metaKeywords / slow kluczowych. PrestaShop 9 nie uzywa tego pola dla produktu.',
    'Glowny opis ma byc w prostym HTML: p, br, strong, em, ul, ol, li, h2, h3. Bez klas, styli inline, tabel i skryptow.',
    'Nie wymyslaj parametrow, ktorych nie ma w danych lub nie wynikaja z obrazu.',
    '',
    `Szablon: ${template?.name ?? 'domyslny'}`,
    `Brief: ${template?.brief ?? 'Pisz konkretnie i naturalnie po polsku.'}`,
    `Prompt systemowy szablonu: ${template?.systemPrompt ?? 'Brak'}`,
    `Ton: ${template?.tone ?? 'naturalny sprzedazowy'}`,
    `Typ produktu: ${template?.productType ?? product.name}`,
    `Kontekst okazji: ${template?.occasionContext ?? 'brak'}`,
    '',
    `Produkt: ${product.name}`,
    `SKU: ${product.sku}`,
    `Opis lokalny: ${product.description ?? 'brak'}`,
    `Kategorie: ${categories}`,
    `Cechy:\n${features}`,
    input.inspiration
      ? `Inspiracje z konkurencji, tylko jako kontekst. Nie kopiuj tekstu 1:1, nie przepisuj unikalnych sformulowan i zweryfikuj fakty z danymi produktu:\n${input.inspiration}`
      : 'Inspiracje z konkurencji: brak',
    input.imageUrl ? `Pierwsze zdjecie produktu: ${input.imageUrl}` : 'Pierwsze zdjecie produktu: brak',
    '',
    'Aktualny draft:',
    `Nazwa: ${current.name ?? ''}`,
    `Opis krotki HTML: ${current.shortDescriptionHtml ?? ''}`,
    `Opis dlugi HTML: ${current.longDescriptionHtml ?? ''}`,
    `Meta title: ${current.metaTitle ?? ''}`,
    `Meta description: ${current.metaDescription ?? ''}`,
    `URL: ${current.linkRewrite ?? ''}`,
  ].join('\n');
}

export async function generateWarehouseProductContentProposal(productId: string, input: AiContentProposalInput) {
  const tenantId = requireTenantId();
  return generateWarehouseProductContentProposalForTenant(productId, input, {
    tenantId,
    userId: getUserId(),
    source: 'INLINE',
  });
}

export async function generateWarehouseProductContentProposalForTenant(productId: string, input: AiContentProposalInput, context: GenerateContext) {
  const tenantId = context.tenantId;
  const product = await getProductForAi(productId, tenantId);
  if (!product) throw new Error('Produkt nie znaleziony');

  const settings = await prisma.aiSettings.findUnique({ where: { tenantId } });
  if (!settings) throw new Error('Brak konfiguracji AI');
  await assertAiLimits(tenantId, settings);

  const { provider, model } = resolveProviderAndModel(settings, {
    needsVision: Boolean(input.imageUrl),
  });
  const apiKey = getProviderApiKey(settings, provider);

  const templateId = input.templateId || settings.defaultPromptTemplateId;
  const template = templateId
    ? await prisma.aiPromptTemplate.findFirst({ where: { id: templateId, tenantId, isActive: true } })
    : await prisma.aiPromptTemplate.findFirst({ where: { tenantId, isDefault: true, isActive: true } });

  const usedImage = Boolean(input.imageUrl && provider !== 'DEEPSEEK');

  const result = await runAiCall({
    tenantId,
    userId: context.userId ?? null,
    provider,
    model,
    action: input.action,
    source: context.source ?? 'INLINE',
    apiKey,
    prompt: buildPrompt(input, product, template),
    systemPrompt: 'Jestes asystentem e-commerce. Odpowiadasz wyłącznie poprawnym JSON.',
    imageUrl: input.imageUrl,
    timeoutMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    promptTemplateId: template?.id ?? null,
    warehouseProductId: productId,
    bulkJobId: context.bulkJobId ?? null,
    bulkJobItemId: context.bulkJobItemId ?? null,
    // Ksztalt propozycji jest staly (normalizeProposal zawsze zwraca ten sam
    // zestaw pol), wiec metadanych nie ma po co liczyc z odpowiedzi modelu -
    // parsowanie JSON w tym miejscu wywracaloby wpis juz oznaczony jako udany.
    buildMetadata: () => ({ proposalFields: PROPOSAL_FIELDS }),
  });

  const parsed = JSON.parse(extractJson(result.text));
  const fallbackName = input.current?.name || product.name;
  const proposal = normalizeProposal(parsed, fallbackName);

  return {
    provider,
    model,
    templateId: template?.id ?? null,
    action: input.action,
    usedImage,
    usageLogId: result.usageLogId,
    proposal,
  };
}
