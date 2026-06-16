import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { getProductById } from './warehouse-products.service';
import type { AiProvider } from '../../schemas/admin.schema';
import { normalizeAiModelId } from './ai-models';

type AiContentAction = 'GENERATE' | 'IMPROVE' | 'SHORTEN' | 'SEO';

export interface AiContentProposalInput {
  shopId?: string;
  templateId?: string | null;
  action: AiContentAction;
  imageUrl?: string | null;
  current?: {
    name?: string;
    shortDescriptionHtml?: string;
    longDescriptionHtml?: string;
    metaTitle?: string;
    metaDescription?: string;
    metaKeywords?: string;
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
  metaKeywords: string;
  linkRewrite: string;
  notes: string[];
};

const providerKeyField: Record<AiProvider, 'openaiApiKey' | 'anthropicApiKey' | 'deepseekApiKey'> = {
  OPENAI: 'openaiApiKey',
  ANTHROPIC: 'anthropicApiKey',
  DEEPSEEK: 'deepseekApiKey',
};

const textModelField: Record<AiProvider, 'openaiTextModel' | 'anthropicTextModel' | 'deepseekTextModel'> = {
  OPENAI: 'openaiTextModel',
  ANTHROPIC: 'anthropicTextModel',
  DEEPSEEK: 'deepseekTextModel',
};

const visionModelField: Record<AiProvider, 'openaiVisionModel' | 'anthropicVisionModel' | 'deepseekVisionModel'> = {
  OPENAI: 'openaiVisionModel',
  ANTHROPIC: 'anthropicVisionModel',
  DEEPSEEK: 'deepseekVisionModel',
};

function requireTenantId() {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;
  if (!tenantId) throw new Error('Tenant context is required for AI content proposal');
  return tenantId;
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

function extractJson(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match?.[0] ?? trimmed;
}

function normalizeProposal(raw: any, fallbackName: string): NormalizedProposal {
  const name = String(raw?.name ?? fallbackName ?? '').trim();
  const shortDescriptionHtml = sanitizeBasicHtml(raw?.shortDescriptionHtml);
  const longDescriptionHtml = sanitizeBasicHtml(raw?.longDescriptionHtml);
  const metaTitle = clamp(String(raw?.metaTitle ?? name).trim(), 70);
  const metaDescription = clamp(String(raw?.metaDescription ?? stripHtml(shortDescriptionHtml || longDescriptionHtml)).trim(), 170);
  const metaKeywords = String(raw?.metaKeywords ?? '').trim();
  const linkRewrite = slugify(String(raw?.linkRewrite ?? name).trim());
  const notes = Array.isArray(raw?.notes) ? raw.notes.map((note: unknown) => String(note)).filter(Boolean) : [];

  return {
    name,
    shortDescriptionHtml,
    longDescriptionHtml,
    metaTitle,
    metaDescription,
    metaKeywords,
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
    'Wymagany ksztalt JSON: {"name":"","shortDescriptionHtml":"","longDescriptionHtml":"","metaTitle":"","metaDescription":"","metaKeywords":"","linkRewrite":"","notes":[]}.',
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
    input.imageUrl ? `Pierwsze zdjecie produktu: ${input.imageUrl}` : 'Pierwsze zdjecie produktu: brak',
    '',
    'Aktualny draft:',
    `Nazwa: ${current.name ?? ''}`,
    `Opis krotki HTML: ${current.shortDescriptionHtml ?? ''}`,
    `Opis dlugi HTML: ${current.longDescriptionHtml ?? ''}`,
    `Meta title: ${current.metaTitle ?? ''}`,
    `Meta description: ${current.metaDescription ?? ''}`,
    `Meta keywords: ${current.metaKeywords ?? ''}`,
    `URL: ${current.linkRewrite ?? ''}`,
  ].join('\n');
}

async function fetchImageAsAnthropicBlock(imageUrl: string, timeoutMs: number) {
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) return null;

  const contentType = response.headers.get('content-type') ?? 'image/jpeg';
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: contentType,
      data: buffer.toString('base64'),
    },
  };
}

async function callOpenAi(apiKey: string, model: string, prompt: string, imageUrl: string | null | undefined, timeoutMs: number) {
  const userContent: any[] = [{ type: 'text', text: prompt }];
  if (imageUrl) userContent.push({ type: 'image_url', image_url: { url: imageUrl } });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Jestes asystentem e-commerce. Odpowiadasz wyłącznie poprawnym JSON.' },
        { role: 'user', content: userContent },
      ],
    }),
  });

  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? 'OpenAI request failed');
  return String(payload?.choices?.[0]?.message?.content ?? '');
}

async function callAnthropic(apiKey: string, model: string, prompt: string, imageUrl: string | null | undefined, timeoutMs: number) {
  const content: any[] = [{ type: 'text', text: prompt }];
  if (imageUrl) {
    const imageBlock = await fetchImageAsAnthropicBlock(imageUrl, Math.min(timeoutMs, 30000));
    if (imageBlock) content.unshift(imageBlock);
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1600,
      system: 'Jestes asystentem e-commerce. Odpowiadasz wyłącznie poprawnym JSON.',
      messages: [{ role: 'user', content }],
    }),
  });

  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? 'Anthropic request failed');
  return String(payload?.content?.find((part: any) => part?.type === 'text')?.text ?? '');
}

async function callDeepSeek(apiKey: string, model: string, prompt: string, timeoutMs: number) {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Jestes asystentem e-commerce. Odpowiadasz wyłącznie poprawnym JSON.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? 'DeepSeek request failed');
  return String(payload?.choices?.[0]?.message?.content ?? '');
}

export async function generateWarehouseProductContentProposal(productId: string, input: AiContentProposalInput) {
  const tenantId = requireTenantId();
  const product = await getProductById(productId);
  if (!product) throw new Error('Produkt nie znaleziony');

  const settings = await prisma.aiSettings.findUnique({ where: { tenantId } });
  if (!settings) throw new Error('Brak konfiguracji AI');

  const textProvider = (settings.textProvider ?? settings.activeProvider) as AiProvider;
  const visionProvider = (settings.visionProvider ?? (settings.activeProvider === 'DEEPSEEK' ? 'OPENAI' : settings.activeProvider)) as AiProvider;
  const provider = (input.imageUrl ? visionProvider : textProvider) as AiProvider;
  const encryptedKey = settings[providerKeyField[provider]];
  if (!encryptedKey) throw new Error(`Brak klucza API dla dostawcy ${provider}`);

  const configuredModel = input.imageUrl && provider !== 'DEEPSEEK' && settings[visionModelField[provider]]
    ? settings[visionModelField[provider]]
    : settings[textModelField[provider]];
  const selectedModel = normalizeAiModelId(configuredModel);

  if (!selectedModel) throw new Error(`Brak modelu dla dostawcy ${provider}`);

  const templateId = input.templateId || settings.defaultPromptTemplateId;
  const template = templateId
    ? await prisma.aiPromptTemplate.findFirst({ where: { id: templateId, tenantId, isActive: true } })
    : await prisma.aiPromptTemplate.findFirst({ where: { tenantId, isDefault: true, isActive: true } });

  const prompt = buildPrompt(input, product, template);
  const apiKey = decrypt(encryptedKey);
  const timeoutMs = settings.timeoutMs ?? 45000;
  const raw = provider === 'OPENAI'
    ? await callOpenAi(apiKey, selectedModel, prompt, input.imageUrl, timeoutMs)
    : provider === 'ANTHROPIC'
      ? await callAnthropic(apiKey, selectedModel, prompt, input.imageUrl, timeoutMs)
      : await callDeepSeek(apiKey, selectedModel, prompt, timeoutMs);

  const parsed = JSON.parse(extractJson(raw));
  const fallbackName = input.current?.name || product.name;

  return {
    provider,
    model: selectedModel,
    templateId: template?.id ?? null,
    action: input.action,
    usedImage: Boolean(input.imageUrl && provider !== 'DEEPSEEK'),
    proposal: normalizeProposal(parsed, fallbackName),
  };
}
