import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { decrypt, encrypt } from '../../lib/encryption';
import { getTenantContext, getTenantId, isSuperAdmin } from '../../lib/tenant-context';
import type { AiProvider, AiSettingsInput } from '../../schemas/admin.schema';
import { normalizeAiModelId } from './ai-models';

type ProviderKeyField = 'openaiApiKey' | 'anthropicApiKey' | 'deepseekApiKey';

const providerKeyField: Record<AiProvider, ProviderKeyField> = {
  OPENAI: 'openaiApiKey',
  ANTHROPIC: 'anthropicApiKey',
  DEEPSEEK: 'deepseekApiKey',
};

const defaults = {
  activeProvider: 'OPENAI' as AiProvider,
  textProvider: 'OPENAI' as AiProvider,
  visionProvider: 'OPENAI' as AiProvider,
  openaiTextModel: 'gpt-4.1-mini',
  openaiVisionModel: 'gpt-4.1-mini',
  anthropicTextModel: 'claude-sonnet-4-6',
  anthropicVisionModel: 'claude-haiku-4-5',
  deepseekTextModel: 'deepseek-chat',
  deepseekVisionModel: null,
  dailyLimit: 200,
  monthlyLimit: 5000,
  timeoutMs: 45000,
  maxBatchSize: 20,
  defaultPromptTemplateId: null,
  toneJson: null,
  rulesJson: null,
};

function requireTenantId() {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;

  if (!tenantId || (isSuperAdmin() && !getTenantContext()?.overrideTenantId && !getTenantContext()?.tenantId)) {
    throw new Error('Tenant context is required for AI settings');
  }

  return tenantId;
}

function maskEncryptedKey(value?: string | null) {
  if (!value) {
    return { configured: false, mask: null };
  }

  try {
    const decrypted = decrypt(value);
    const suffix = decrypted.slice(-4);
    return { configured: true, mask: suffix ? `••••${suffix}` : '••••' };
  } catch {
    return { configured: true, mask: '••••' };
  }
}

function toResponse(settings: any) {
  return {
    id: settings.id ?? null,
    tenantId: settings.tenantId ?? null,
    activeProvider: settings.activeProvider ?? defaults.activeProvider,
    textProvider: settings.textProvider ?? settings.activeProvider ?? defaults.textProvider,
    visionProvider: settings.visionProvider ?? (settings.activeProvider === 'DEEPSEEK' ? defaults.visionProvider : settings.activeProvider) ?? defaults.visionProvider,
    providers: {
      OPENAI: {
        key: maskEncryptedKey(settings.openaiApiKey),
        textModel: normalizeAiModelId(settings.openaiTextModel ?? defaults.openaiTextModel),
        visionModel: normalizeAiModelId(settings.openaiVisionModel ?? defaults.openaiVisionModel),
      },
      ANTHROPIC: {
        key: maskEncryptedKey(settings.anthropicApiKey),
        textModel: normalizeAiModelId(settings.anthropicTextModel ?? defaults.anthropicTextModel),
        visionModel: normalizeAiModelId(settings.anthropicVisionModel ?? defaults.anthropicVisionModel),
      },
      DEEPSEEK: {
        key: maskEncryptedKey(settings.deepseekApiKey),
        textModel: normalizeAiModelId(settings.deepseekTextModel ?? defaults.deepseekTextModel),
        visionModel: normalizeAiModelId(settings.deepseekVisionModel ?? defaults.deepseekVisionModel),
      },
    },
    limits: {
      dailyLimit: settings.dailyLimit ?? defaults.dailyLimit,
      monthlyLimit: settings.monthlyLimit ?? defaults.monthlyLimit,
      timeoutMs: settings.timeoutMs ?? defaults.timeoutMs,
      maxBatchSize: settings.maxBatchSize ?? defaults.maxBatchSize,
    },
    defaultPromptTemplateId: settings.defaultPromptTemplateId ?? null,
    toneJson: settings.toneJson ?? null,
    rulesJson: settings.rulesJson ?? null,
    lastTest: {
      provider: settings.lastTestProvider ?? null,
      status: settings.lastTestStatus ?? null,
      at: settings.lastTestAt ?? null,
      message: settings.lastTestMessage ?? null,
    },
    createdAt: settings.createdAt ?? null,
    updatedAt: settings.updatedAt ?? null,
  };
}

function encryptedKeyUpdate(value: string | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;
  return encrypt(value.trim());
}

export async function getAiSettings() {
  const tenantId = requireTenantId();
  const settings = await prisma.aiSettings.findUnique({ where: { tenantId } });

  return toResponse(settings ?? { tenantId, ...defaults });
}

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

export async function getAiUsageSummary() {
  const tenantId = requireTenantId();
  const settings = await prisma.aiSettings.findUnique({ where: { tenantId } });
  const countedStatuses = ['PENDING', 'PROCESSING', 'SUCCESS'];
  const [dailyUsed, monthlyUsed, recent] = await Promise.all([
    prisma.aiUsageLog.count({ where: { tenantId, status: { in: countedStatuses }, createdAt: { gte: dayStart() } } }),
    prisma.aiUsageLog.count({ where: { tenantId, status: { in: countedStatuses }, createdAt: { gte: monthStart() } } }),
    prisma.aiUsageLog.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { product: { select: { name: true, sku: true } } },
    }),
  ]);

  return {
    limits: {
      dailyLimit: settings?.dailyLimit ?? defaults.dailyLimit,
      monthlyLimit: settings?.monthlyLimit ?? defaults.monthlyLimit,
      dailyUsed,
      monthlyUsed,
      dailyRemaining: Math.max(0, (settings?.dailyLimit ?? defaults.dailyLimit) - dailyUsed),
      monthlyRemaining: Math.max(0, (settings?.monthlyLimit ?? defaults.monthlyLimit) - monthlyUsed),
    },
    recent: recent.map((log) => ({
      id: log.id,
      productId: log.warehouseProductId,
      productName: log.product?.name ?? null,
      sku: log.product?.sku ?? null,
      provider: log.provider,
      model: log.model,
      action: log.action,
      status: log.status,
      source: log.source,
      usedImage: log.usedImage,
      inputTokens: log.inputTokens,
      outputTokens: log.outputTokens,
      totalTokens: log.totalTokens,
      errorMessage: log.errorMessage,
      createdAt: log.createdAt,
      completedAt: log.completedAt,
    })),
  };
}

export async function updateAiSettings(input: AiSettingsInput) {
  const tenantId = requireTenantId();
  const keyUpdates = {
    openaiApiKey: encryptedKeyUpdate(input.openaiApiKey),
    anthropicApiKey: encryptedKeyUpdate(input.anthropicApiKey),
    deepseekApiKey: encryptedKeyUpdate(input.deepseekApiKey),
  };

  const data = {
    activeProvider: input.textProvider ?? input.activeProvider,
    textProvider: input.textProvider,
    visionProvider: input.visionProvider,
    openaiTextModel: normalizeAiModelId(input.openaiTextModel),
    openaiVisionModel: normalizeAiModelId(input.openaiVisionModel),
    anthropicTextModel: normalizeAiModelId(input.anthropicTextModel),
    anthropicVisionModel: normalizeAiModelId(input.anthropicVisionModel),
    deepseekTextModel: normalizeAiModelId(input.deepseekTextModel),
    deepseekVisionModel: normalizeAiModelId(input.deepseekVisionModel) ?? null,
    dailyLimit: input.dailyLimit,
    monthlyLimit: input.monthlyLimit,
    timeoutMs: input.timeoutMs,
    maxBatchSize: input.maxBatchSize,
    defaultPromptTemplateId: input.defaultPromptTemplateId ?? null,
    toneJson: input.toneJson ?? Prisma.JsonNull,
    rulesJson: input.rulesJson ?? Prisma.JsonNull,
    ...(keyUpdates.openaiApiKey !== undefined ? { openaiApiKey: keyUpdates.openaiApiKey } : {}),
    ...(keyUpdates.anthropicApiKey !== undefined ? { anthropicApiKey: keyUpdates.anthropicApiKey } : {}),
    ...(keyUpdates.deepseekApiKey !== undefined ? { deepseekApiKey: keyUpdates.deepseekApiKey } : {}),
  };

  const settings = await prisma.aiSettings.upsert({
    where: { tenantId },
    create: { tenantId, ...data },
    update: data,
  });

  return toResponse(settings);
}

export async function testAiProvider(provider: AiProvider) {
  const tenantId = requireTenantId();
  const settings = await prisma.aiSettings.findUnique({ where: { tenantId } });
  const keyField = providerKeyField[provider];
  const configured = Boolean(settings?.[keyField]);
  const status = configured ? 'CONFIGURED' : 'MISSING_KEY';
  const message = configured
    ? 'Klucz API jest zapisany. Test zapytania do modelu zostanie użyty przy generatorze treści.'
    : 'Brak klucza API dla wybranego dostawcy.';

  const updated = await prisma.aiSettings.upsert({
    where: { tenantId },
    create: {
      tenantId,
      lastTestProvider: provider,
      lastTestStatus: status,
      lastTestAt: new Date(),
      lastTestMessage: message,
    },
    update: {
      lastTestProvider: provider,
      lastTestStatus: status,
      lastTestAt: new Date(),
      lastTestMessage: message,
    },
  });

  return {
    success: configured,
    provider,
    status,
    message,
    settings: toResponse(updated),
  };
}
