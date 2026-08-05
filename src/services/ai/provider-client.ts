import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import type { AiProvider } from '../../schemas/admin.schema';
import { normalizeAiModelId } from '../admin/ai-models';

/**
 * Wspolny runtime AI: wywolanie dostawcy, limity i dziennik zuzycia.
 *
 * Do tej pory te trzy rzeczy zyly prywatnie w generatorze opisow produktow.
 * Asystent w edytorze klienta potrzebuje dokladnie tego samego - a druga
 * kopia oznaczalaby, ze limit dzienny liczy sie w dwoch miejscach i zaden
 * z nich nie widzi calosci.
 */

export type AiUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
};

export type AiCallResult = {
  text: string;
  usage?: AiUsage;
};

export class AiLimitExceededError extends Error {
  statusCode = 429;

  constructor(message: string) {
    super(message);
    this.name = 'AiLimitExceededError';
  }
}

export const providerKeyField: Record<AiProvider, 'openaiApiKey' | 'anthropicApiKey' | 'deepseekApiKey'> = {
  OPENAI: 'openaiApiKey',
  ANTHROPIC: 'anthropicApiKey',
  DEEPSEEK: 'deepseekApiKey',
};

export const textModelField: Record<AiProvider, 'openaiTextModel' | 'anthropicTextModel' | 'deepseekTextModel'> = {
  OPENAI: 'openaiTextModel',
  ANTHROPIC: 'anthropicTextModel',
  DEEPSEEK: 'deepseekTextModel',
};

export const visionModelField: Record<AiProvider, 'openaiVisionModel' | 'anthropicVisionModel' | 'deepseekVisionModel'> = {
  OPENAI: 'openaiVisionModel',
  ANTHROPIC: 'anthropicVisionModel',
  DEEPSEEK: 'deepseekVisionModel',
};

export const DEFAULT_DAILY_LIMIT = 200;
export const DEFAULT_MONTHLY_LIMIT = 5000;
export const DEFAULT_TIMEOUT_MS = 45000;

function dayStart() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function monthStart() {
  const date = new Date();
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  return date;
}

/** Statusy liczone do limitu - trwajace wywolanie tez zajmuje miejsce. */
const COUNTED_STATUSES = ['PENDING', 'PROCESSING', 'SUCCESS'];

export async function assertAiLimits(tenantId: string, settings: any) {
  const [dailyCount, monthlyCount] = await Promise.all([
    prisma.aiUsageLog.count({
      where: { tenantId, status: { in: COUNTED_STATUSES }, createdAt: { gte: dayStart() } },
    }),
    prisma.aiUsageLog.count({
      where: { tenantId, status: { in: COUNTED_STATUSES }, createdAt: { gte: monthStart() } },
    }),
  ]);

  const dailyLimit = settings.dailyLimit ?? DEFAULT_DAILY_LIMIT;
  const monthlyLimit = settings.monthlyLimit ?? DEFAULT_MONTHLY_LIMIT;

  if (dailyCount >= dailyLimit) {
    throw new AiLimitExceededError(`Przekroczono dzienny limit AI (${dailyCount}/${dailyLimit}).`);
  }

  if (monthlyCount >= monthlyLimit) {
    throw new AiLimitExceededError(`Przekroczono miesieczny limit AI (${monthlyCount}/${monthlyLimit}).`);
  }
}

/** Ile wywolan zostalo w danym oknie - odpowiedz niesie to do UI. */
export async function countAiCalls(where: Record<string, unknown>) {
  return prisma.aiUsageLog.count({ where: { ...where, status: { in: COUNTED_STATUSES } } });
}

export function getDayStart() {
  return dayStart();
}

/**
 * Dostawca i model dla danego zadania.
 *
 * DeepSeek nie ma modelu wizyjnego, wiec zadanie z obrazem schodzi na
 * dostawce wizyjnego z ustawien - inaczej wywolanie konczyloby sie bledem
 * dopiero po stronie API dostawcy.
 */
export function resolveProviderAndModel(
  settings: any,
  options: { needsVision?: boolean; overrideProvider?: string | null; overrideModel?: string | null } = {}
): { provider: AiProvider; model: string } {
  const textProvider = (settings.textProvider ?? settings.activeProvider) as AiProvider;
  const visionProvider = (settings.visionProvider ??
    (settings.activeProvider === 'DEEPSEEK' ? 'OPENAI' : settings.activeProvider)) as AiProvider;

  const provider = (options.overrideProvider ||
    (options.needsVision ? visionProvider : textProvider)) as AiProvider;

  const configuredModel =
    options.overrideModel ||
    (options.needsVision && provider !== 'DEEPSEEK' && settings[visionModelField[provider]]
      ? settings[visionModelField[provider]]
      : settings[textModelField[provider]]);

  const model = normalizeAiModelId(configuredModel);
  if (!model) throw new Error(`Brak modelu dla dostawcy ${provider}`);

  return { provider, model };
}

export function getProviderApiKey(settings: any, provider: AiProvider): string {
  const encrypted = settings[providerKeyField[provider]];
  if (!encrypted) throw new Error(`Brak klucza API dla dostawcy ${provider}`);
  return decrypt(encrypted);
}

// ============================================
// Wywolania dostawcow
// ============================================

export async function fetchImageAsAnthropicBlock(imageUrl: string, timeoutMs: number) {
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

export interface ProviderCallOptions {
  apiKey: string;
  model: string;
  prompt: string;
  systemPrompt: string;
  imageUrl?: string | null;
  timeoutMs: number;
  maxTokens?: number;
}

async function callOpenAi({ apiKey, model, prompt, systemPrompt, imageUrl, timeoutMs }: ProviderCallOptions): Promise<AiCallResult> {
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
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    }),
  });

  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? 'OpenAI request failed');
  return {
    text: String(payload?.choices?.[0]?.message?.content ?? ''),
    usage: {
      inputTokens: payload?.usage?.prompt_tokens ?? null,
      outputTokens: payload?.usage?.completion_tokens ?? null,
      totalTokens: payload?.usage?.total_tokens ?? null,
    },
  };
}

async function callAnthropic({ apiKey, model, prompt, systemPrompt, imageUrl, timeoutMs, maxTokens }: ProviderCallOptions): Promise<AiCallResult> {
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
      max_tokens: maxTokens ?? 1600,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
    }),
  });

  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? 'Anthropic request failed');
  const inputTokens = payload?.usage?.input_tokens ?? null;
  const outputTokens = payload?.usage?.output_tokens ?? null;
  return {
    text: String(payload?.content?.find((part: any) => part?.type === 'text')?.text ?? ''),
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens != null && outputTokens != null ? Number(inputTokens) + Number(outputTokens) : null,
    },
  };
}

async function callDeepSeek({ apiKey, model, prompt, systemPrompt, timeoutMs }: ProviderCallOptions): Promise<AiCallResult> {
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
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message ?? 'DeepSeek request failed');
  return {
    text: String(payload?.choices?.[0]?.message?.content ?? ''),
    usage: {
      inputTokens: payload?.usage?.prompt_tokens ?? null,
      outputTokens: payload?.usage?.completion_tokens ?? null,
      totalTokens: payload?.usage?.total_tokens ?? null,
    },
  };
}

export async function callProvider(provider: AiProvider, options: ProviderCallOptions): Promise<AiCallResult> {
  if (provider === 'OPENAI') return callOpenAi(options);
  if (provider === 'ANTHROPIC') return callAnthropic(options);
  return callDeepSeek(options);
}

// ============================================
// Wywolanie z dziennikiem
// ============================================

export interface RunAiCallInput {
  tenantId: string;
  userId?: string | null;
  provider: AiProvider;
  model: string;
  action: string;
  source?: string;
  apiKey: string;
  prompt: string;
  systemPrompt: string;
  imageUrl?: string | null;
  timeoutMs: number;
  maxTokens?: number;
  promptTemplateId?: string | null;
  /** Powiazania dziennika - zaleznie od tego, kto wola. */
  warehouseProductId?: string | null;
  personalizationCaseId?: string | null;
  bulkJobId?: string | null;
  bulkJobItemId?: string | null;
  /** Co zapisac w `metadataJson` po udanym wywolaniu. */
  buildMetadata?: (result: AiCallResult) => Record<string, unknown>;
}

/**
 * Jedno wejscie do modelu: zaklada wpis w dzienniku, wola dostawce i zamyka
 * wpis wynikiem. Dziennik powstaje PRZED wywolaniem - inaczej rownolegle
 * zadania widzialyby siebie nawzajem jako "jeszcze nie zaczete" i razem
 * przekroczylyby limit.
 */
export async function runAiCall(input: RunAiCallInput): Promise<AiCallResult & { usageLogId: string }> {
  const usageLog = await prisma.aiUsageLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.userId ?? null,
      warehouseProductId: input.warehouseProductId ?? null,
      personalizationCaseId: input.personalizationCaseId ?? null,
      aiBulkContentJobId: input.bulkJobId ?? null,
      aiBulkContentJobItemId: input.bulkJobItemId ?? null,
      provider: input.provider,
      model: input.model,
      action: input.action,
      status: 'PROCESSING',
      source: input.source ?? 'INLINE',
      usedImage: Boolean(input.imageUrl && input.provider !== 'DEEPSEEK'),
      promptTemplateId: input.promptTemplateId ?? null,
      startedAt: new Date(),
    },
  });

  let result: AiCallResult;
  try {
    result = await callProvider(input.provider, {
      apiKey: input.apiKey,
      model: input.model,
      prompt: input.prompt,
      systemPrompt: input.systemPrompt,
      imageUrl: input.imageUrl,
      timeoutMs: input.timeoutMs,
      maxTokens: input.maxTokens,
    });
  } catch (error) {
    await prisma.aiUsageLog.update({
      where: { id: usageLog.id },
      data: {
        status: 'FAILED',
        errorMessage: error instanceof Error ? error.message : 'Unknown AI provider error',
        completedAt: new Date(),
      },
    });
    throw error;
  }

  await prisma.aiUsageLog.update({
    where: { id: usageLog.id },
    data: {
      status: 'SUCCESS',
      inputTokens: result.usage?.inputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      totalTokens: result.usage?.totalTokens ?? null,
      metadataJson: input.buildMetadata ? (input.buildMetadata(result) as any) : undefined,
      completedAt: new Date(),
    },
  });

  return { ...result, usageLogId: usageLog.id };
}

/** Wycina JSON z odpowiedzi modelu owinietej w Markdown albo komentarz. */
export function extractJson(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match?.[0] ?? trimmed;
}
