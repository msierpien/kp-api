/// <reference lib="dom" />
import { parse } from 'csv-parse/sync';
import { Prisma, WholesalePlatform } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';

type WholesalePreset = 'GODAN' | 'PARTYDECO' | 'CUSTOM';

interface FieldMapping {
  sku: string;
  name: string;
  ean?: string;
  stock?: string;
  price?: string;
  description?: string;
  image?: string;
  category?: string;
}

interface WholesaleProviderConfig {
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping: FieldMapping;
}

export interface WholesaleProvidersQuery {
  page?: number;
  limit?: number;
  search?: string;
  isActive?: boolean;
}

export interface WholesaleMappingsQuery {
  page?: number;
  limit?: number;
  search?: string;
  isMapped?: boolean;
  isActive?: boolean;
}

export interface WholesaleSyncLogsQuery {
  page?: number;
  limit?: number;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface CreateWholesaleProviderInput {
  name: string;
  feedUrl: string;
  platform?: WholesalePlatform;
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping?: FieldMapping;
  syncEnabled?: boolean;
  isActive?: boolean;
}

export interface UpdateWholesaleProviderInput {
  name?: string;
  feedUrl?: string;
  platform?: WholesalePlatform;
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping?: FieldMapping;
  syncEnabled?: boolean;
  isActive?: boolean;
}

export interface SyncWholesaleProviderOptions {
  limit?: number;
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

export interface AutoMapWholesaleProviderOptions {
  activeOnly?: boolean;
}

export interface AutoMapWholesaleProviderResult {
  providerId: string;
  scanned: number;
  mapped: number;
  mappedBySku: number;
  mappedByEan: number;
  skippedNoProduct: number;
}

export interface MapWholesaleProductInput {
  warehouseProductId: string | null;
}

const PRESET_CONFIGS: Record<Exclude<WholesalePreset, 'CUSTOM'>, WholesaleProviderConfig> = {
  GODAN: {
    preset: 'GODAN',
    delimiter: ';',
    fieldMapping: {
      sku: 'Kod produktu',
      ean: 'Kod EAN',
      name: 'Nazwa',
      stock: 'Stan magazynowy',
      price: 'Cena netto jednostkowa',
      description: 'Opis',
      image: 'Zdjęcie',
    },
  },
  PARTYDECO: {
    preset: 'PARTYDECO',
    delimiter: ';',
    fieldMapping: {
      sku: 'code',
      ean: 'ean',
      name: 'name',
      stock: 'stock',
      price: 'price_net',
      description: 'description',
      image: 'photos',
      category: 'category_path',
    },
  },
};

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
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
      include: { _count: { select: { mappings: true, syncLogs: true } } },
    }),
    prisma.wholesaleProvider.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getWholesaleProviderById(id: string) {
  const tenantId = requireTenantId();

  return prisma.wholesaleProvider.findFirst({
    where: { id, tenantId },
    include: { _count: { select: { mappings: true, syncLogs: true } } },
  });
}

export async function createWholesaleProvider(input: CreateWholesaleProviderInput) {
  const tenantId = requireTenantId();
  const config = buildProviderConfig(input);

  return prisma.wholesaleProvider.create({
    data: {
      tenantId,
      name: input.name.trim(),
      platform: input.platform ?? 'CSV_FEED',
      feedUrl: input.feedUrl.trim(),
      configJson: config as unknown as Prisma.InputJsonValue,
      syncEnabled: input.syncEnabled ?? true,
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
  if (input.isActive !== undefined) data.isActive = input.isActive;

  if (input.preset !== undefined || input.delimiter !== undefined || input.fieldMapping !== undefined) {
    const currentConfig = parseProviderConfig(provider.configJson);
    const nextConfig = buildProviderConfig({
      preset: input.preset ?? currentConfig.preset ?? 'CUSTOM',
      delimiter: input.delimiter ?? currentConfig.delimiter,
      fieldMapping: input.fieldMapping ?? currentConfig.fieldMapping,
      name: provider.name,
      feedUrl: provider.feedUrl,
    });
    data.configJson = nextConfig as unknown as Prisma.InputJsonValue;
  }

  return prisma.wholesaleProvider.update({ where: { id }, data });
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

export async function getWholesaleMappings(providerId: string, query: WholesaleMappingsQuery = {}) {
  const tenantId = requireTenantId();
  await assertProviderBelongsToTenant(providerId, tenantId);

  const { page = 1, limit = 50, search, isMapped, isActive } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.WholesaleProductMappingWhereInput = { tenantId, providerId };
  if (isActive !== undefined) where.isActive = isActive;
  if (isMapped !== undefined) where.warehouseProductId = isMapped ? { not: null } : null;
  if (search) {
    where.OR = [
      { externalSku: { contains: search, mode: 'insensitive' } },
      { externalName: { contains: search, mode: 'insensitive' } },
      { externalEan: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [data, total] = await Promise.all([
    prisma.wholesaleProductMapping.findMany({
      where,
      skip,
      take: limit,
      orderBy: { externalName: 'asc' },
      include: { provider: true, warehouseProduct: { include: { catalog: true } } },
    }),
    prisma.wholesaleProductMapping.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function mapWholesaleProduct(mappingId: string, input: MapWholesaleProductInput) {
  const tenantId = requireTenantId();
  const mapping = await prisma.wholesaleProductMapping.findFirst({ where: { id: mappingId, tenantId } });
  if (!mapping) throw new Error('Mapowanie produktu hurtowni nie znalezione');

  if (input.warehouseProductId) {
    const product = await prisma.warehouseProduct.findFirst({
      where: { id: input.warehouseProductId, tenantId },
    });
    if (!product) throw new Error('Produkt magazynowy nie znaleziony');
  }

  return prisma.wholesaleProductMapping.update({
    where: { id: mappingId },
    data: { warehouseProductId: input.warehouseProductId },
    include: { provider: true, warehouseProduct: { include: { catalog: true } } },
  });
}

export async function autoMapWholesaleProvider(
  providerId: string,
  options: AutoMapWholesaleProviderOptions = {},
): Promise<AutoMapWholesaleProviderResult> {
  const tenantId = requireTenantId();
  await assertProviderBelongsToTenant(providerId, tenantId);

  const mappings = await prisma.wholesaleProductMapping.findMany({
    where: {
      tenantId,
      providerId,
      warehouseProductId: null,
      ...(options.activeOnly ?? true ? { isActive: true } : {}),
    },
    orderBy: { externalSku: 'asc' },
  });

  const result: AutoMapWholesaleProviderResult = {
    providerId,
    scanned: mappings.length,
    mapped: 0,
    mappedBySku: 0,
    mappedByEan: 0,
    skippedNoProduct: 0,
  };

  for (const mapping of mappings) {
    let product = await prisma.warehouseProduct.findUnique({
      where: { tenantId_sku: { tenantId, sku: mapping.externalSku } },
      select: { id: true },
    });
    let matchedBy: 'SKU' | 'EAN' | null = product ? 'SKU' : null;

    if (!product && mapping.externalEan) {
      const barcode = await prisma.warehouseProductBarcode.findFirst({
        where: { tenantId, ean: mapping.externalEan, isActive: true },
        select: { warehouseProductId: true },
      });

      if (barcode) {
        product = { id: barcode.warehouseProductId };
        matchedBy = 'EAN';
      }
    }

    if (!product) {
      result.skippedNoProduct++;
      continue;
    }

    await prisma.wholesaleProductMapping.update({
      where: { id: mapping.id },
      data: { warehouseProductId: product.id },
    });

    result.mapped++;
    if (matchedBy === 'SKU') result.mappedBySku++;
    if (matchedBy === 'EAN') result.mappedByEan++;
  }

  return result;
}

export async function getWholesaleSyncLogs(providerId: string, query: WholesaleSyncLogsQuery = {}) {
  const tenantId = requireTenantId();
  await assertProviderBelongsToTenant(providerId, tenantId);

  const { page = 1, limit = 50, status, dateFrom, dateTo } = query;
  const skip = (page - 1) * limit;

  const where: Prisma.WholesaleSyncLogWhereInput = { tenantId, providerId };
  if (status) where.status = status;
  if (dateFrom || dateTo) {
    where.startedAt = {};
    if (dateFrom) where.startedAt.gte = new Date(dateFrom);
    if (dateTo) where.startedAt.lte = new Date(dateTo);
  }

  const [data, total] = await Promise.all([
    prisma.wholesaleSyncLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { startedAt: 'desc' },
      include: { provider: true },
    }),
    prisma.wholesaleSyncLog.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function syncWholesaleProvider(providerId: string, options: SyncWholesaleProviderOptions = {}) {
  const tenantId = requireTenantId();
  const startedAt = new Date();
  const provider = await prisma.wholesaleProvider.findFirst({ where: { id: providerId, tenantId } });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');
  if (!provider.isActive) throw new Error('Provider hurtowni jest nieaktywny');
  if (provider.platform !== 'CSV_FEED') throw new Error(`Sync nie obsługuje jeszcze platformy ${provider.platform}`);

  const log = await prisma.wholesaleSyncLog.create({
    data: { tenantId, providerId, status: 'PROCESSING', startedAt },
  });

  try {
    const config = parseProviderConfig(provider.configJson);
    const csvText = await fetchFeed(provider.feedUrl);
    const records = parseCsv(csvText, config.delimiter ?? ';');
    const limitedRecords = options.limit ? records.slice(0, options.limit) : records;

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const record of limitedRecords) {
      const mapped = mapCsvRecord(record, config.fieldMapping);
      if (!mapped.externalSku) {
        skipped++;
        continue;
      }

      const existing = await prisma.wholesaleProductMapping.findUnique({
        where: { providerId_externalSku: { providerId, externalSku: mapped.externalSku } },
      });

      await prisma.wholesaleProductMapping.upsert({
        where: { providerId_externalSku: { providerId, externalSku: mapped.externalSku } },
        create: {
          tenantId,
          providerId,
          externalSku: mapped.externalSku,
          externalEan: mapped.externalEan,
          externalName: mapped.externalName,
          externalCategory: mapped.externalCategory,
          lastKnownStock: mapped.lastKnownStock,
          lastKnownPrice: mapped.lastKnownPrice,
          payloadJson: record as Prisma.InputJsonValue,
          isActive: true,
          lastSyncAt: new Date(),
        },
        update: {
          externalEan: mapped.externalEan,
          externalName: mapped.externalName,
          externalCategory: mapped.externalCategory,
          lastKnownStock: mapped.lastKnownStock,
          lastKnownPrice: mapped.lastKnownPrice,
          payloadJson: record as Prisma.InputJsonValue,
          isActive: true,
          lastSyncAt: new Date(),
        },
      });

      if (existing) updated++;
      else created++;
    }

    const finishedLog = await prisma.wholesaleSyncLog.update({
      where: { id: log.id },
      data: {
        status: 'SUCCESS',
        itemsFetched: limitedRecords.length,
        mappingsCreated: created,
        mappingsUpdated: updated,
        skipped,
        finishedAt: new Date(),
      },
    });

    await prisma.wholesaleProvider.update({
      where: { id: providerId },
      data: { lastSyncAt: new Date() },
    });

    return finishedLog;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Nieznany błąd sync hurtowni';
    await prisma.wholesaleSyncLog.update({
      where: { id: log.id },
      data: {
        status: 'FAILED',
        errorMessage: message,
        finishedAt: new Date(),
      },
    });
    throw error;
  }
}

async function assertProviderBelongsToTenant(providerId: string, tenantId: string) {
  const provider = await prisma.wholesaleProvider.findFirst({
    where: { id: providerId, tenantId },
    select: { id: true },
  });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');
}

function buildProviderConfig(input: {
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping?: FieldMapping;
  feedUrl: string;
  name: string;
}): WholesaleProviderConfig {
  const preset = input.preset ?? detectPreset(input.feedUrl, input.name);
  const presetConfig = preset !== 'CUSTOM' ? PRESET_CONFIGS[preset] : undefined;
  const delimiter = normalizeDelimiter(input.delimiter ?? presetConfig?.delimiter);
  const fieldMapping = input.fieldMapping ?? presetConfig?.fieldMapping;

  if (!fieldMapping?.sku || !fieldMapping?.name) {
    throw new Error('Konfiguracja hurtowni wymaga mapowania pól sku i name');
  }

  return { preset, delimiter, fieldMapping };
}

function parseProviderConfig(configJson: unknown): WholesaleProviderConfig {
  const config = (configJson || {}) as Partial<WholesaleProviderConfig>;
  if (!config.fieldMapping?.sku || !config.fieldMapping?.name) {
    throw new Error('Provider hurtowni nie ma poprawnej konfiguracji CSV');
  }

  return {
    preset: config.preset ?? 'CUSTOM',
    delimiter: normalizeDelimiter(config.delimiter),
    fieldMapping: config.fieldMapping,
  };
}

function detectPreset(feedUrl: string, name: string): WholesalePreset {
  const value = `${feedUrl} ${name}`.toLowerCase();
  if (value.includes('godan')) return 'GODAN';
  if (value.includes('partydeco') || value.includes('party deco')) return 'PARTYDECO';
  return 'CUSTOM';
}

async function fetchFeed(feedUrl: string) {
  const response = await fetch(feedUrl);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Błąd pobierania feedu hurtowni: ${response.status} ${text.slice(0, 200)}`);
  }
  return response.text();
}

function parseCsv(csvText: string, delimiter: string): Record<string, string>[] {
  return parse(csvText, {
    bom: true,
    columns: true,
    delimiter,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];
}

function normalizeDelimiter(delimiter?: string) {
  if (!delimiter) return ';';
  if (delimiter === '\\t') return '\t';
  if (delimiter.length !== 1) throw new Error('Separator CSV musi mieć dokładnie jeden znak');
  return delimiter;
}

function clampPreviewLimit(limit?: number) {
  if (limit === undefined) return 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Limit preview musi być liczbą całkowitą od 1 do 50');
  }
  return limit;
}

function collectColumns(records: Record<string, string>[]) {
  const columns = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) columns.add(key);
  }
  return Array.from(columns);
}

function mapCsvRecord(record: Record<string, string>, fieldMapping: FieldMapping) {
  return {
    externalSku: readField(record, fieldMapping.sku),
    externalEan: readOptionalField(record, fieldMapping.ean),
    externalName: readOptionalField(record, fieldMapping.name),
    externalCategory: readOptionalField(record, fieldMapping.category),
    lastKnownStock: parseDecimal(readOptionalField(record, fieldMapping.stock), 3),
    lastKnownPrice: parseDecimal(readOptionalField(record, fieldMapping.price), 2),
  };
}

function readField(record: Record<string, string>, fieldName: string) {
  return String(record[fieldName] ?? '').trim();
}

function readOptionalField(record: Record<string, string>, fieldName?: string) {
  if (!fieldName) return null;
  const value = readField(record, fieldName);
  return value || null;
}

function parseDecimal(value: string | null, scale: number) {
  if (!value) return null;
  const normalized = value.replace(/\s/g, '').replace(',', '.');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return new Prisma.Decimal(parsed.toFixed(scale));
}
