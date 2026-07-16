/// <reference lib="dom" />
import { parse } from 'csv-parse/sync';
import { Prisma } from '@prisma/client';
import prisma from '../../../lib/prisma';
import { getTenantId } from '../../../lib/tenant-context';

export type WholesalePreset = 'GODAN' | 'PARTYDECO' | 'CUSTOM';
export type WholesaleAvailabilityRule = 'STOCK_ONLY' | 'STOCK_OR_FUTURE_DELIVERY';

export interface FieldMapping {
  sku: string;
  name: string;
  ean?: string;
  stock?: string;
  price?: string;
  description?: string;
  image?: string;
  category?: string;
  warehouseAvailableAt?: string;
}

export interface WholesaleProviderConfig {
  preset?: WholesalePreset;
  delimiter?: string;
  availabilityRule?: WholesaleAvailabilityRule;
  feedSafety?: WholesaleFeedSafetyConfig;
  fieldMapping: FieldMapping;
}

export interface WholesaleFeedSafetyConfig {
  minItems: number;
  maxDropPercent: number;
  maxInvalidPercent: number;
}

const DEFAULT_FEED_SAFETY: WholesaleFeedSafetyConfig = {
  minItems: 1,
  maxDropPercent: 40,
  maxInvalidPercent: 5,
};

const PRESET_CONFIGS: Record<Exclude<WholesalePreset, 'CUSTOM'>, WholesaleProviderConfig> = {
  GODAN: {
    preset: 'GODAN',
    delimiter: ';',
    availabilityRule: 'STOCK_ONLY',
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
    availabilityRule: 'STOCK_OR_FUTURE_DELIVERY',
    fieldMapping: {
      sku: 'code',
      ean: 'ean',
      name: 'name',
      stock: 'stock',
      price: 'price_net',
      description: 'description',
      image: 'photos',
      category: 'category_path',
      warehouseAvailableAt: 'availability_date',
    },
  },
};

export function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

export async function assertProviderBelongsToTenant(providerId: string, tenantId: string) {
  const provider = await prisma.wholesaleProvider.findFirst({
    where: { id: providerId, tenantId },
    select: { id: true },
  });
  if (!provider) throw new Error('Provider hurtowni nie znaleziony');
}

export function buildProviderConfig(input: {
  preset?: WholesalePreset;
  delimiter?: string;
  fieldMapping?: FieldMapping;
  availabilityRule?: WholesaleAvailabilityRule;
  feedSafety?: Partial<WholesaleFeedSafetyConfig>;
  feedUrl: string;
  name: string;
}): WholesaleProviderConfig {
  const preset = input.preset ?? detectPreset(input.feedUrl, input.name);
  const presetConfig = preset !== 'CUSTOM' ? PRESET_CONFIGS[preset] : undefined;
  const delimiter = normalizeDelimiter(input.delimiter ?? presetConfig?.delimiter);
  const availabilityRule = normalizeAvailabilityRule(input.availabilityRule ?? presetConfig?.availabilityRule, preset);
  const inputFieldMapping = compactFieldMapping(input.fieldMapping);
  const fieldMapping = presetConfig
    ? { ...presetConfig.fieldMapping, ...inputFieldMapping }
    : inputFieldMapping;

  if (!fieldMapping?.sku || !fieldMapping?.name) {
    throw new Error('Konfiguracja hurtowni wymaga mapowania pól sku i name');
  }

  return {
    preset,
    delimiter,
    availabilityRule,
    feedSafety: normalizeFeedSafety(input.feedSafety),
    fieldMapping: fieldMapping as FieldMapping,
  };
}

export function parseProviderConfig(configJson: unknown): WholesaleProviderConfig {
  const config = (configJson || {}) as Partial<WholesaleProviderConfig>;
  const preset = config.preset ?? 'CUSTOM';
  const presetConfig = preset !== 'CUSTOM' ? PRESET_CONFIGS[preset] : undefined;
  const fieldMapping = presetConfig
    ? { ...presetConfig.fieldMapping, ...compactFieldMapping(config.fieldMapping) }
    : config.fieldMapping;

  if (!fieldMapping?.sku || !fieldMapping?.name) {
    throw new Error('Provider hurtowni nie ma poprawnej konfiguracji CSV');
  }

  return {
    preset,
    delimiter: normalizeDelimiter(config.delimiter ?? presetConfig?.delimiter),
    availabilityRule: resolveWholesaleAvailabilityRule(configJson),
    feedSafety: normalizeFeedSafety(config.feedSafety),
    fieldMapping,
  };
}

export function normalizeFeedSafety(input?: Partial<WholesaleFeedSafetyConfig>): WholesaleFeedSafetyConfig {
  const minItems = Number(input?.minItems ?? DEFAULT_FEED_SAFETY.minItems);
  const maxDropPercent = Number(input?.maxDropPercent ?? DEFAULT_FEED_SAFETY.maxDropPercent);
  const maxInvalidPercent = Number(input?.maxInvalidPercent ?? DEFAULT_FEED_SAFETY.maxInvalidPercent);

  if (!Number.isInteger(minItems) || minItems < 1 || minItems > 1_000_000) {
    throw new Error('Minimalna liczba rekordów feedu musi być liczbą całkowitą od 1 do 1000000');
  }
  if (!Number.isFinite(maxDropPercent) || maxDropPercent < 0 || maxDropPercent > 95) {
    throw new Error('Maksymalny spadek liczby rekordów musi być od 0 do 95%');
  }
  if (!Number.isFinite(maxInvalidPercent) || maxInvalidPercent < 0 || maxInvalidPercent > 100) {
    throw new Error('Maksymalny odsetek błędnych rekordów musi być od 0 do 100%');
  }

  return { minItems, maxDropPercent, maxInvalidPercent };
}

export function resolveWholesaleAvailabilityRule(configJson: unknown): WholesaleAvailabilityRule {
  const config = (configJson || {}) as Partial<WholesaleProviderConfig>;
  const preset = config.preset ?? 'CUSTOM';
  return normalizeAvailabilityRule(config.availabilityRule, preset);
}

export async function fetchFeed(feedUrl: string) {
  const response = await fetch(feedUrl);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Błąd pobierania feedu hurtowni: ${response.status} ${text.slice(0, 200)}`);
  }
  return response.text();
}

export function parseCsv(csvText: string, delimiter: string): Record<string, string>[] {
  return parse(csvText, {
    bom: true,
    columns: true,
    delimiter,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as Record<string, string>[];
}

export function normalizeDelimiter(delimiter?: string) {
  if (!delimiter) return ';';
  if (delimiter === '\\t') return '\t';
  if (delimiter.length !== 1) throw new Error('Separator CSV musi mieć dokładnie jeden znak');
  return delimiter;
}

export function clampPreviewLimit(limit?: number) {
  if (limit === undefined) return 5;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Limit preview musi być liczbą całkowitą od 1 do 50');
  }
  return limit;
}

export function validateWholesaleSyncInterval(intervalMinutes: number) {
  if (!Number.isInteger(intervalMinutes)) {
    throw new Error('Interwał synchronizacji hurtowni musi być liczbą całkowitą');
  }

  if (intervalMinutes < 30) {
    throw new Error('Interwał synchronizacji hurtowni musi wynosić minimum 30 minut');
  }

  if (intervalMinutes > 1440) {
    throw new Error('Interwał synchronizacji hurtowni nie może przekraczać 1440 minut');
  }

  return intervalMinutes;
}

export function normalizeOptionalLeadTimeDays(value: number | null | undefined) {
  if (value === undefined || value === null) return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new Error('Czas wysyłki dostawcy musi być liczbą całkowitą od 0 do 365 dni');
  }
  return days;
}

export function isPositiveDecimal(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === undefined || value === null) return false;
  return new Prisma.Decimal(value).gt(0);
}

export function sameDateOnly(a?: Date | null, b?: Date | null) {
  return dateOnlyString(a) === dateOnlyString(b);
}

export function collectColumns(records: Record<string, string>[]) {
  const columns = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record)) columns.add(key);
  }
  return Array.from(columns);
}

export function mapCsvRecord(record: Record<string, string>, fieldMapping: FieldMapping) {
  return {
    externalSku: readField(record, fieldMapping.sku),
    externalEan: readOptionalField(record, fieldMapping.ean),
    externalName: readOptionalField(record, fieldMapping.name),
    externalCategory: readOptionalField(record, fieldMapping.category),
    lastKnownStock: parseDecimal(readOptionalField(record, fieldMapping.stock), 3),
    lastKnownPrice: parseDecimal(readOptionalField(record, fieldMapping.price), 2),
    warehouseAvailableAt: parseWarehouseAvailableAt(readOptionalField(record, fieldMapping.warehouseAvailableAt)),
  };
}

function compactFieldMapping(fieldMapping?: FieldMapping): Partial<FieldMapping> {
  if (!fieldMapping) return {};
  return Object.fromEntries(
    Object.entries(fieldMapping)
      .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value])
      .filter(([, value]) => Boolean(value)),
  ) as Partial<FieldMapping>;
}

function detectPreset(feedUrl: string, name: string): WholesalePreset {
  const value = `${feedUrl} ${name}`.toLowerCase();
  if (value.includes('godan')) return 'GODAN';
  if (value.includes('partydeco') || value.includes('party deco')) return 'PARTYDECO';
  return 'CUSTOM';
}

function normalizeAvailabilityRule(value: unknown, preset: WholesalePreset): WholesaleAvailabilityRule {
  if (value === 'STOCK_ONLY' || value === 'STOCK_OR_FUTURE_DELIVERY') return value;
  if (preset === 'PARTYDECO') return 'STOCK_OR_FUTURE_DELIVERY';
  return 'STOCK_ONLY';
}

function dateOnlyString(value?: Date | null) {
  return value ? value.toISOString().slice(0, 10) : null;
}

function parseWarehouseAvailableAt(value?: string | null) {
  const normalized = normalizeDateOnly(value);
  return normalized ? new Date(`${normalized}T00:00:00.000Z`) : null;
}

function normalizeDateOnly(value?: string | null) {
  const raw = value?.trim();
  if (!raw) return null;

  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return validDateOnly(isoMatch[1], isoMatch[2], isoMatch[3]);

  const slashMatch = raw.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashMatch) return validDateOnly(slashMatch[1], slashMatch[2], slashMatch[3]);

  const polishMatch = raw.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/);
  if (polishMatch) return validDateOnly(polishMatch[3], polishMatch[2], polishMatch[1]);

  return null;
}

function validDateOnly(year: string, month: string, day: string) {
  const normalized = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) return null;
  return normalized;
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
