import { Prisma, WholesalePlatform } from '@prisma/client';
import { createLogger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { publishInventoryToShops } from '../stock/stock-sync.service';
import {
  buildProviderConfig,
  clampPreviewLimit,
  collectColumns,
  fetchFeed,
  normalizeDelimiter,
  normalizeOptionalLeadTimeDays,
  parseCsv,
  parseProviderConfig,
  requireTenantId,
  validateWholesaleSyncInterval,
  type FieldMapping,
  type WholesaleFeedSafetyConfig,
  type WholesaleAvailabilityRule,
  type WholesalePreset,
} from './wholesale/shared';

const logger = createLogger('wholesale-provider-service');

type HydratedWholesaleMappingDiagnostic = {
  id: string;
  providerId: string;
  externalSku: string;
  externalEan: string | null;
  externalName: string | null;
  warehouseProductId: string | null;
  provider: { id: string; name: string };
  warehouseProduct: { id: string; sku: string } | null;
};

export interface WholesaleProvidersQuery {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

export interface CreateWholesaleProviderInput {
  name: string;
  feedUrl: string;
  platform?: WholesalePlatform;
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping?: FieldMapping;
  availabilityRule?: WholesaleAvailabilityRule;
  feedSafety?: Partial<WholesaleFeedSafetyConfig>;
  syncEnabled?: boolean;
  syncInterval?: number;
  leadTimeDays?: number | null;
  isActive?: boolean;
}

export interface UpdateWholesaleProviderInput {
  name?: string;
  feedUrl?: string;
  platform?: WholesalePlatform;
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping?: FieldMapping;
  availabilityRule?: WholesaleAvailabilityRule;
  feedSafety?: Partial<WholesaleFeedSafetyConfig>;
  syncEnabled?: boolean;
  syncInterval?: number;
  leadTimeDays?: number | null;
  isActive?: boolean;
}

export interface BulkUpdateWholesaleProviderLeadTimesInput {
  items: Array<{
    providerId: string;
    leadTimeDays?: number | null;
  }>;
}

export interface BulkUpdateWholesaleProviderLeadTimesResult {
  requested: number;
  updated: number;
  unchanged: number;
  notFound: number;
  errors: Array<{ providerId: string; message: string }>;
}

export interface PreviewWholesaleProviderInput {
  feedUrl: string;
  delimiter?: string;
  limit?: number;
}

export interface PreviewWholesaleProviderResult {
  columns: string[];
  sampleRows: Record<string, string>[];
  totalPreviewRows: number;
  delimiter: string;
}

export interface UpdateWholesaleSyncIntervalInput {
  intervalMinutes: number;
}

export interface WholesaleDiagnosticsResult {
  summary: {
    duplicateProviderGroups: number;
    duplicateSkuGroups: number;
    duplicateEanGroups: number;
  };
  duplicateProviderGroups: Array<{
    key: string;
    canonicalProviderId: string;
    providers: Array<{
      id: string;
      name: string;
      preset: string;
      isActive: boolean;
      syncEnabled: boolean;
      leadTimeDays: number | null;
      mappings: number;
      lastSyncAt: Date | null;
    }>;
  }>;
  duplicateSkuGroups: WholesaleDuplicateMappingGroup[];
  duplicateEanGroups: WholesaleDuplicateMappingGroup[];
}

export interface WholesaleDuplicateMappingGroup {
  value: string;
  providers: number;
  mappings: number;
  linkedMappings: number;
  items: Array<{
    mappingId: string;
    providerId: string;
    providerName: string;
    externalSku: string;
    externalEan: string | null;
    externalName: string | null;
    warehouseProductId: string | null;
    warehouseProductSku: string | null;
  }>;
}

function withLatestWholesaleSyncLog<T extends { syncLogs?: unknown[] }>(provider: T) {
  const { syncLogs, ...rest } = provider;
  return {
    ...rest,
    latestSyncLog: syncLogs?.[0] ?? null,
  };
}

function buildDuplicateProviderGroups(providers: Array<{
  id: string;
  name: string;
  configJson: Prisma.JsonValue | null;
  isActive: boolean;
  syncEnabled: boolean;
  leadTimeDays: number | null;
  lastSyncAt: Date | null;
  _count: { mappings: number };
}>) {
  const groups = new Map<string, typeof providers>();

  for (const provider of providers) {
    const config = parseProviderConfig(provider.configJson);
    const key = normalizeProviderDiagnosticKey(provider.name || config.preset || provider.id);
    const group = groups.get(key) ?? [];
    group.push(provider);
    groups.set(key, group);
  }

  return Array.from(groups.entries())
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => {
      const sorted = [...group].sort((a, b) => {
        const activeScore = Number(b.isActive) - Number(a.isActive);
        if (activeScore !== 0) return activeScore;
        const syncScore = Number(b.syncEnabled) - Number(a.syncEnabled);
        if (syncScore !== 0) return syncScore;
        const leadScore = Number(b.leadTimeDays !== null) - Number(a.leadTimeDays !== null);
        if (leadScore !== 0) return leadScore;
        return b._count.mappings - a._count.mappings;
      });

      return {
        key,
        canonicalProviderId: sorted[0]?.id ?? group[0].id,
        providers: sorted.map((provider) => ({
          id: provider.id,
          name: provider.name,
          preset: parseProviderConfig(provider.configJson).preset ?? 'CUSTOM',
          isActive: provider.isActive,
          syncEnabled: provider.syncEnabled,
          leadTimeDays: provider.leadTimeDays,
          mappings: provider._count.mappings,
          lastSyncAt: provider.lastSyncAt,
        })),
      };
    });
}

async function hydrateDuplicateSkuGroups(tenantId: string, skus: string[]): Promise<WholesaleDuplicateMappingGroup[]> {
  if (skus.length === 0) return [];

  const mappings = await prisma.wholesaleProductMapping.findMany({
    where: { tenantId, isActive: true, externalSku: { in: skus } },
    include: {
      provider: { select: { id: true, name: true } },
      warehouseProduct: { select: { id: true, sku: true } },
    },
    orderBy: [{ externalSku: 'asc' }, { provider: { name: 'asc' } }],
  });

  return buildDuplicateMappingGroups(skus, mappings, (mapping) => mapping.externalSku);
}

async function hydrateDuplicateEanGroups(tenantId: string, eans: string[]): Promise<WholesaleDuplicateMappingGroup[]> {
  if (eans.length === 0) return [];

  const mappings = await prisma.wholesaleProductMapping.findMany({
    where: { tenantId, isActive: true, externalEan: { in: eans } },
    include: {
      provider: { select: { id: true, name: true } },
      warehouseProduct: { select: { id: true, sku: true } },
    },
    orderBy: [{ externalEan: 'asc' }, { provider: { name: 'asc' } }],
  });

  return buildDuplicateMappingGroups(eans, mappings, (mapping) => mapping.externalEan ?? '');
}

function buildDuplicateMappingGroups(
  values: string[],
  mappings: HydratedWholesaleMappingDiagnostic[],
  valueForMapping: (mapping: HydratedWholesaleMappingDiagnostic) => string,
): WholesaleDuplicateMappingGroup[] {
  return values.map((value) => {
    const items = mappings.filter((mapping) => valueForMapping(mapping) === value);
    const providerIds = new Set(items.map((mapping) => mapping.providerId));

    return {
      value,
      providers: providerIds.size,
      mappings: items.length,
      linkedMappings: items.filter((mapping) => mapping.warehouseProductId).length,
      items: items.slice(0, 10).map((mapping) => ({
        mappingId: mapping.id,
        providerId: mapping.providerId,
        providerName: mapping.provider.name,
        externalSku: mapping.externalSku,
        externalEan: mapping.externalEan,
        externalName: mapping.externalName,
        warehouseProductId: mapping.warehouseProductId,
        warehouseProductSku: mapping.warehouseProduct?.sku ?? null,
      })),
    };
  });
}

function normalizeProviderDiagnosticKey(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export async function getWholesaleProviders(query: WholesaleProvidersQuery = {}) {
  const tenantId = requireTenantId();
  const { page = 1, limit = 50, search, isActive } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.WholesaleProviderWhereInput = { tenantId };
  if (isActive !== undefined) where.isActive = isActive;
  if (search) where.name = { contains: search, mode: 'insensitive' };

  const [data, total] = await Promise.all([
    prisma.wholesaleProvider.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { mappings: true, syncLogs: true } },
        syncLogs: {
          take: 1,
          orderBy: { startedAt: 'desc' },
        },
      },
    }),
    prisma.wholesaleProvider.count({ where }),
  ]);

  return {
    data: data.map(withLatestWholesaleSyncLog),
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

export async function getWholesaleProviderById(id: string) {
  const tenantId = requireTenantId();

  return prisma.wholesaleProvider.findFirst({
    where: { id, tenantId },
    include: {
      _count: { select: { mappings: true, syncLogs: true } },
      syncLogs: {
        take: 1,
        orderBy: { startedAt: 'desc' },
      },
    },
  }).then((provider) => provider ? withLatestWholesaleSyncLog(provider) : null);
}

export async function getWholesaleDiagnostics(): Promise<WholesaleDiagnosticsResult> {
  const tenantId = requireTenantId();

  const [providers, skuGroups, eanGroups] = await Promise.all([
    prisma.wholesaleProvider.findMany({
      where: { tenantId },
      include: { _count: { select: { mappings: true } } },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.wholesaleProductMapping.groupBy({
      by: ['externalSku'],
      where: { tenantId, isActive: true },
      _count: { _all: true, providerId: true, warehouseProductId: true },
    }),
    prisma.wholesaleProductMapping.groupBy({
      by: ['externalEan'],
      where: {
        tenantId,
        isActive: true,
        AND: [
          { externalEan: { not: null } },
          { externalEan: { not: '' } },
        ],
      },
      _count: { _all: true, providerId: true, warehouseProductId: true },
    }),
  ]);

  const duplicateProviderGroups = buildDuplicateProviderGroups(providers);
  const duplicateSkuGroups = await hydrateDuplicateSkuGroups(
    tenantId,
    skuGroups
      .filter((group) => group._count._all > 1)
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 50)
      .map((group) => group.externalSku),
  );
  const duplicateEanGroups = await hydrateDuplicateEanGroups(
    tenantId,
    eanGroups
      .filter((group) => group.externalEan && group._count._all > 1)
      .sort((a, b) => b._count._all - a._count._all)
      .slice(0, 50)
      .map((group) => group.externalEan as string),
  );

  return {
    summary: {
      duplicateProviderGroups: duplicateProviderGroups.length,
      duplicateSkuGroups: skuGroups.filter((group) => group._count._all > 1).length,
      duplicateEanGroups: eanGroups.filter((group) => group.externalEan && group._count._all > 1).length,
    },
    duplicateProviderGroups,
    duplicateSkuGroups,
    duplicateEanGroups,
  };
}

export async function createWholesaleProvider(input: CreateWholesaleProviderInput) {
  const tenantId = requireTenantId();
  const config = buildProviderConfig(input);
  const syncInterval = validateWholesaleSyncInterval(input.syncInterval ?? 1440);

  return prisma.wholesaleProvider.create({
    data: {
      tenantId,
      name: input.name.trim(),
      platform: input.platform ?? 'CSV_FEED',
      feedUrl: input.feedUrl.trim(),
      configJson: config as unknown as Prisma.InputJsonValue,
      syncEnabled: input.syncEnabled ?? true,
      syncInterval,
      leadTimeDays: normalizeOptionalLeadTimeDays(input.leadTimeDays),
      isActive: input.isActive ?? true,
    },
  });
}

export async function updateWholesaleProvider(id: string, input: UpdateWholesaleProviderInput) {
  const tenantId = requireTenantId();
  const provider = await prisma.wholesaleProvider.findFirst({ where: { id, tenantId } });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');

  const data: Prisma.WholesaleProviderUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.feedUrl !== undefined) data.feedUrl = input.feedUrl.trim();
  if (input.platform !== undefined) data.platform = input.platform;
  if (input.syncEnabled !== undefined) data.syncEnabled = input.syncEnabled;
  if (input.syncInterval !== undefined) data.syncInterval = validateWholesaleSyncInterval(input.syncInterval);
  if (input.leadTimeDays !== undefined) data.leadTimeDays = normalizeOptionalLeadTimeDays(input.leadTimeDays);
  if (input.isActive !== undefined) data.isActive = input.isActive;
  const shouldSyncLeadTime = input.leadTimeDays !== undefined && input.leadTimeDays !== provider.leadTimeDays;

  if (
    input.preset !== undefined ||
    input.delimiter !== undefined ||
    input.fieldMapping !== undefined ||
    input.availabilityRule !== undefined
    || input.feedSafety !== undefined
  ) {
    const currentConfig = parseProviderConfig(provider.configJson);
    const nextConfig = buildProviderConfig({
      preset: input.preset ?? currentConfig.preset ?? 'CUSTOM',
      delimiter: input.delimiter ?? currentConfig.delimiter,
      fieldMapping: input.fieldMapping ?? currentConfig.fieldMapping,
      availabilityRule: input.availabilityRule ?? currentConfig.availabilityRule,
      feedSafety: input.feedSafety ?? currentConfig.feedSafety,
      name: provider.name,
      feedUrl: provider.feedUrl,
    });
    data.configJson = nextConfig as unknown as Prisma.InputJsonValue;
  }

  const updated = await prisma.wholesaleProvider.update({ where: { id }, data });

  if (shouldSyncLeadTime) {
    enqueueWholesaleProviderLeadTimeStockSync(id, tenantId).catch((error) => {
      logger.error({ err: error, providerId: id }, 'Failed to enqueue stock sync for provider lead time change');
    });
  }

  return updated;
}

export async function bulkUpdateWholesaleProviderLeadTimes(
  input: BulkUpdateWholesaleProviderLeadTimesInput,
): Promise<BulkUpdateWholesaleProviderLeadTimesResult> {
  const tenantId = requireTenantId();
  const itemsByProviderId = new Map<string, number | null>();

  for (const item of input.items ?? []) {
    const providerId = item.providerId?.trim();
    if (!providerId) continue;
    itemsByProviderId.set(providerId, normalizeOptionalLeadTimeDays(item.leadTimeDays));
  }

  if (itemsByProviderId.size === 0) {
    throw new Error('Podaj przynajmniej jednego dostawcę do aktualizacji');
  }

  const providerIds = Array.from(itemsByProviderId.keys());
  const providers = await prisma.wholesaleProvider.findMany({
    where: { tenantId, id: { in: providerIds } },
    select: { id: true, leadTimeDays: true },
  });
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const errors = providerIds
    .filter((providerId) => !providersById.has(providerId))
    .map((providerId) => ({ providerId, message: 'Provider hurtowni nie znaleziony' }));

  let updated = 0;
  let unchanged = 0;
  const changedProviderIds: string[] = [];
  const updateOperations: Prisma.PrismaPromise<unknown>[] = [];

  for (const provider of providers) {
    const nextLeadTimeDays = itemsByProviderId.get(provider.id) ?? null;
    if (nextLeadTimeDays === provider.leadTimeDays) {
      unchanged++;
      continue;
    }
    updated++;
    changedProviderIds.push(provider.id);
    updateOperations.push(prisma.wholesaleProvider.update({
      where: { id: provider.id },
      data: { leadTimeDays: nextLeadTimeDays },
      select: { id: true },
    }));
  }

  if (updateOperations.length > 0) {
    await prisma.$transaction(updateOperations);
  }

  for (const providerId of changedProviderIds) {
    enqueueWholesaleProviderLeadTimeStockSync(providerId, tenantId).catch((error) => {
      logger.error({ err: error, providerId }, 'Failed to enqueue stock sync for provider lead time change');
    });
  }

  return {
    requested: providerIds.length,
    updated,
    unchanged,
    notFound: errors.length,
    errors,
  };
}

export async function updateWholesaleProviderSyncInterval(
  id: string,
  input: UpdateWholesaleSyncIntervalInput,
) {
  const tenantId = requireTenantId();
  const provider = await prisma.wholesaleProvider.findFirst({ where: { id, tenantId } });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');

  const syncInterval = validateWholesaleSyncInterval(input.intervalMinutes);
  return prisma.wholesaleProvider.update({
    where: { id },
    data: { syncInterval },
  });
}

export async function deleteWholesaleProvider(id: string) {
  const tenantId = requireTenantId();
  const provider = await prisma.wholesaleProvider.findFirst({ where: { id, tenantId } });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');

  return prisma.wholesaleProvider.delete({ where: { id } });
}

export async function previewWholesaleProvider(input: PreviewWholesaleProviderInput): Promise<PreviewWholesaleProviderResult> {
  requireTenantId();

  const feedUrl = input.feedUrl?.trim();
  if (!feedUrl) throw new Error('feedUrl jest wymagany');

  const delimiter = normalizeDelimiter(input.delimiter);
  const limit = clampPreviewLimit(input.limit);
  const csvText = await fetchFeed(feedUrl);
  const records = parseCsv(csvText, delimiter);
  const sampleRows = records.slice(0, limit);

  return {
    columns: collectColumns(sampleRows.length > 0 ? sampleRows : records),
    sampleRows,
    totalPreviewRows: sampleRows.length,
    delimiter,
  };
}

async function enqueueWholesaleProviderLeadTimeStockSync(providerId: string, tenantId: string) {
  const products = await prisma.warehouseProduct.findMany({
    where: {
      tenantId,
      isActive: true,
      currentStock: { lte: new Prisma.Decimal(0) },
      wholesaleMappings: {
        some: {
          providerId,
          isActive: true,
          lastKnownStock: { gt: new Prisma.Decimal(0) },
        },
      },
    },
    select: { id: true },
  });

  for (let i = 0; i < products.length; i += 500) {
    await publishInventoryToShops({
      tenantId,
      warehouseProductIds: products.slice(i, i + 500).map((product) => product.id),
      triggeredBy: 'LEAD_TIME_UPDATE',
    });
  }
}
