import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { getTenantId } from '../../lib/tenant-context';
import { syncProductPricesBulkForTenant } from '../price/price-sync.service';
import type { PriceSyncTriggeredBy } from '../queue/price-sync.queue';
import { PrestaShopClient, type PrestaShopCategoryDetails } from '../prestashop/prestashop-client';

export type PricingRuleLevel = 'GLOBAL' | 'SHOP' | 'CATALOG' | 'GROUP' | 'PRODUCT';
export type PricingPriceMode = 'MARGIN' | 'FIXED';
export type PricingRoundingMode = 'END_99' | 'TENTH' | 'CENT';
export type PricingSyncMode = 'AUTO' | 'CONFIRM' | 'MANUAL';
export type PricingRuleOrigin = 'MANUAL' | 'COMPETITOR_AUTO' | 'COMPETITOR_MANUAL' | 'SYSTEM';
export type PricingWarningCode = 'MISSING_COST' | 'BELOW_COST' | 'BELOW_MIN_PROFIT' | null;
export type PricingInfoCode = 'ABNORMAL_PROFIT' | null;
export type PricingPriceSource = 'CLEARANCE' | 'PRODUCT' | 'GROUP' | 'CATALOG' | 'SHOP' | 'DEFAULT' | 'CEILING_FALLBACK';
export type PricingCostSource = 'DOCUMENT' | 'WHOLESALE' | null;
export type PricingActionScope = 'SELECTED' | 'FILTERED' | 'GROUP' | 'CATEGORY' | 'SHOP';
export type ClearanceScope = 'PRODUCT' | 'GROUP';

export interface PricingRuleInput {
  level: PricingRuleLevel;
  shopId?: string | null;
  catalogId?: string | null;
  priceGroupId?: string | null;
  warehouseProductId?: string | null;
  marginPercent?: number | null;
  minProfit?: number | null;
  fixedNetPrice?: number | null;
  priceMode?: PricingPriceMode;
  costCeilingEnabled?: boolean | null;
  vatRate?: number | null;
  roundingMode?: PricingRoundingMode | null;
  syncMode?: PricingSyncMode | null;
  origin?: PricingRuleOrigin;
  isActive?: boolean;
}

export interface PricingRulesQuery {
  level?: PricingRuleLevel;
  shopId?: string;
  catalogId?: string;
  priceGroupId?: string;
  warehouseProductId?: string;
  isActive?: boolean;
  origin?: PricingRuleOrigin;
}

export interface PricingProductsInput {
  productIds?: string[];
  shopIds?: string[];
  catalogId?: string;
  priceGroupId?: string;
  scope?: PricingActionScope;
  filters?: PricingProductsQuery;
  allowBelowCostSync?: boolean;
  triggeredBy?: PriceSyncTriggeredBy;
}

export interface PricingProductsQuery {
  shopId: string;
  search?: string;
  priceGroupId?: string;
  categoryId?: string;
  categoryIds?: string;
  groupVariants?: boolean | string;
  source?: PricingPriceSource | 'ALL';
  status?: 'ALL' | 'READY' | 'MISSING_PRICE' | 'WARNING' | 'ALERT' | 'NO_GROUP' | 'OVERRIDES_GROUP' | 'BELOW_COST';
  ruleOrigin?: PricingRuleOrigin | 'ALL' | 'FIXED_MANUAL' | 'FIXED_COMPETITOR_AUTO' | 'FIXED_ANY';
  page?: number | string;
  limit?: number | string;
}

export interface BulkUpdatePricesInput extends PricingProductsInput {
  marginPercent?: number | null;
  minProfit?: number | null;
  fixedNetPrice?: number | null;
  priceMode?: PricingPriceMode;
  costCeilingEnabled?: boolean | null;
  vatRate?: number | null;
  roundingMode?: PricingRoundingMode | null;
  syncMode?: PricingSyncMode | null;
}

export interface PricingSettingsInput {
  defaultMarginPercent?: number;
  defaultMinProfit?: number;
  defaultVatRate?: number;
  defaultRoundingMode?: PricingRoundingMode;
  defaultSyncMode?: PricingSyncMode;
  costCeilingEnabledDefault?: boolean;
  abnormalProfitThreshold?: number;
  variantGroupingEnabled?: boolean;
  competitorAutoPricingEnabled?: boolean;
  competitorAutoPricingShopId?: string | null;
  competitorAutoPricingIntervalMinutes?: number;
  competitorAutoPricingMinMarkupPercent?: number;
  competitorAutoPricingBelowMarketTolerancePercent?: number;
  competitorAutoPricingAboveMarketTolerancePercent?: number;
}

export interface PriceGroupInput {
  name: string;
  description?: string | null;
  priority?: number;
  isActive?: boolean;
}

export interface PriceGroupMembersInput {
  productIds: string[];
}

export interface PriceGroupMembersQuery {
  page?: number | string;
  limit?: number | string;
  search?: string;
  shopId?: string;
}

export interface PriceGroupPriceInput {
  shopId?: string | null;
  marginPercent?: number | null;
  minProfit?: number | null;
  fixedNetPrice?: number | null;
  priceMode?: PricingPriceMode;
  costCeilingEnabled?: boolean | null;
  vatRate?: number | null;
  roundingMode?: PricingRoundingMode | null;
  syncMode?: PricingSyncMode | null;
}

export interface RevertProductToGroupInput {
  shopId: string;
}

export interface ClearanceQuery {
  scope?: ClearanceScope;
  warehouseProductId?: string;
  priceGroupId?: string;
  shopId?: string;
  isActive?: boolean | string;
  page?: number | string;
  limit?: number | string;
}

export interface ClearanceInput {
  scope: ClearanceScope;
  warehouseProductId?: string | null;
  priceGroupId?: string | null;
  shopId?: string | null;
  clearanceNetPrice: number;
  reason?: string | null;
  validFrom?: string | Date | null;
  validTo?: string | Date | null;
  isActive?: boolean;
}

const DEFAULT_PRICING = {
  marginPercent: 30,
  minProfit: 1,
  vatRate: 23,
  roundingMode: 'END_99' as PricingRoundingMode,
  syncMode: 'CONFIRM' as PricingSyncMode,
  costCeilingEnabledDefault: true,
  abnormalProfitThreshold: 200,
  variantGroupingEnabled: true,
  competitorAutoPricingIntervalMinutes: 1440,
  competitorAutoPricingMinMarkupPercent: 40,
  competitorAutoPricingBelowMarketTolerancePercent: 1,
  competitorAutoPricingAboveMarketTolerancePercent: 5,
};

const MAX_PRICING_PRODUCTS = 500;
const MAX_PRICING_LIST_PRODUCTS = 5000;
const CATEGORY_LISTING_CACHE_TTL_MS = 5 * 60 * 1000;
const CATEGORY_LISTING_MAX_PAGES = 50;

const categoryListingProductIdsCache = new Map<string, { expiresAt: number; externalProductIds: string[] }>();

const productPricingInclude = {
  catalog: { select: { id: true, name: true } },
  barcodes: { where: { isActive: true }, select: { ean: true, isPrimary: true } },
  shopProductMappings: { where: { isActive: true }, select: { shopId: true } },
  wholesaleMappings: {
    where: {
      isActive: true,
      lastKnownPrice: { gt: 0 },
      provider: { isActive: true },
    },
    orderBy: [
      { lastKnownPrice: 'asc' },
      { lastSyncAt: 'desc' },
    ],
    take: 1,
    select: {
      lastKnownPrice: true,
      provider: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.WarehouseProductInclude;

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

function decimal(value: Prisma.Decimal.Value | null | undefined) {
  if (value === null || value === undefined) return null;
  return new Prisma.Decimal(value);
}

function numberOrNull(value: Prisma.Decimal.Value | null | undefined) {
  const asDecimal = decimal(value);
  return asDecimal ? Number(asDecimal) : null;
}

function toMoney(value: Prisma.Decimal) {
  return new Prisma.Decimal(value.toFixed(2));
}

function assertNonNegative(value: number | null | undefined, label: string) {
  if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} nie może być ujemne`);
  }
}

function normalizePage(value: number | string | undefined, fallback: number, max?: number) {
  const parsed = Number(value ?? fallback);
  const safe = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  return max ? Math.min(safe, max) : safe;
}

function normalizeSearch(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeBoolean(value: boolean | string | undefined, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'tak'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'nie'].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeOptionalDate(value: string | Date | null | undefined, label: string) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} ma nieprawidłową datę`);
  return date;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

function normalizeCategoryIdSet(query: PricingProductsQuery) {
  const ids = [query.categoryId, query.categoryIds]
    .flatMap((value) => String(value ?? '').split(','))
    .map((value) => value.trim())
    .filter((value) => value && value !== 'ALL');
  return new Set(ids);
}

function normalizeCategoryId(value: unknown) {
  const id = String(value ?? '').trim();
  return id && id !== 'ALL' ? id : null;
}

function categorySlug(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function validatePriceMode(value: PricingPriceMode | undefined) {
  if (value && !['MARGIN', 'FIXED'].includes(value)) throw new Error('Nieprawidłowy tryb ceny');
}

function validateRounding(value: PricingRoundingMode | null | undefined) {
  if (value && !['END_99', 'TENTH', 'CENT'].includes(value)) throw new Error('Nieprawidłowy tryb zaokrąglania');
}

function validateSync(value: PricingSyncMode | null | undefined) {
  if (value && !['AUTO', 'CONFIRM', 'MANUAL'].includes(value)) throw new Error('Nieprawidłowy tryb synchronizacji');
}

function validateOrigin(value: PricingRuleOrigin | null | undefined) {
  if (value && !['MANUAL', 'COMPETITOR_AUTO', 'COMPETITOR_MANUAL', 'SYSTEM'].includes(value)) {
    throw new Error('Nieprawidłowe źródło reguły cennika');
  }
}

function normalizeRuleInput(input: PricingRuleInput) {
  assertNonNegative(input.marginPercent, 'Marża');
  assertNonNegative(input.minProfit, 'Minimalny zysk');
  assertNonNegative(input.fixedNetPrice, 'Cena stała');
  assertNonNegative(input.vatRate, 'VAT');
  validatePriceMode(input.priceMode);
  validateRounding(input.roundingMode);
  validateSync(input.syncMode);
  validateOrigin(input.origin);

  if (!['GLOBAL', 'SHOP', 'CATALOG', 'GROUP', 'PRODUCT'].includes(input.level)) {
    throw new Error('Nieprawidłowy poziom reguły cennika');
  }
  if (input.level === 'SHOP' && !input.shopId) throw new Error('Reguła sklepu wymaga sklepu');
  if (input.level === 'CATALOG' && !input.catalogId) throw new Error('Reguła katalogu wymaga katalogu');
  if (input.level === 'GROUP' && !input.priceGroupId) throw new Error('Reguła grupy wymaga grupy cenowej');
  if (input.level === 'PRODUCT' && !input.warehouseProductId) throw new Error('Reguła produktu wymaga produktu');

  const priceMode = input.priceMode ?? (input.fixedNetPrice !== null && input.fixedNetPrice !== undefined ? 'FIXED' : 'MARGIN');
  if (priceMode === 'FIXED' && (input.fixedNetPrice === null || input.fixedNetPrice === undefined)) {
    throw new Error('Cena stała wymaga kwoty netto');
  }

  return {
    level: input.level,
    shopId: input.shopId ?? null,
    catalogId: input.level === 'CATALOG' ? input.catalogId ?? null : null,
    priceGroupId: input.level === 'GROUP' ? input.priceGroupId ?? null : null,
    warehouseProductId: input.level === 'PRODUCT' ? input.warehouseProductId ?? null : null,
    marginPercent: input.marginPercent ?? null,
    minProfit: input.minProfit ?? null,
    fixedNetPrice: priceMode === 'FIXED' ? input.fixedNetPrice ?? null : null,
    priceMode,
    costCeilingEnabled: input.costCeilingEnabled ?? null,
    vatRate: input.vatRate ?? null,
    roundingMode: input.roundingMode ?? null,
    syncMode: input.syncMode ?? null,
    origin: input.origin ?? 'MANUAL',
    isActive: input.isActive ?? true,
  };
}

async function ensurePricingSettings(tenantId: string) {
  const existing = await prisma.warehousePricingSettings.findUnique({ where: { tenantId } });
  if (existing) return existing;

  const globalRule = await prisma.warehousePricingRule.findFirst({
    where: { tenantId, level: 'GLOBAL', isActive: true },
    orderBy: { updatedAt: 'desc' },
  });

  return prisma.warehousePricingSettings.create({
    data: {
      tenantId,
      defaultMarginPercent: globalRule?.marginPercent ?? DEFAULT_PRICING.marginPercent,
      defaultMinProfit: globalRule?.minProfit ?? DEFAULT_PRICING.minProfit,
      defaultVatRate: globalRule?.vatRate ?? DEFAULT_PRICING.vatRate,
      defaultRoundingMode: globalRule?.roundingMode ?? DEFAULT_PRICING.roundingMode,
      defaultSyncMode: globalRule?.syncMode ?? DEFAULT_PRICING.syncMode,
      costCeilingEnabledDefault: DEFAULT_PRICING.costCeilingEnabledDefault,
      abnormalProfitThreshold: DEFAULT_PRICING.abnormalProfitThreshold,
      variantGroupingEnabled: DEFAULT_PRICING.variantGroupingEnabled,
      competitorAutoPricingEnabled: false,
      competitorAutoPricingIntervalMinutes: DEFAULT_PRICING.competitorAutoPricingIntervalMinutes,
      competitorAutoPricingMinMarkupPercent: DEFAULT_PRICING.competitorAutoPricingMinMarkupPercent,
      competitorAutoPricingBelowMarketTolerancePercent: DEFAULT_PRICING.competitorAutoPricingBelowMarketTolerancePercent,
      competitorAutoPricingAboveMarketTolerancePercent: DEFAULT_PRICING.competitorAutoPricingAboveMarketTolerancePercent,
    },
  });
}

export async function getPricingSettings() {
  return ensurePricingSettings(requireTenantId());
}

export async function updatePricingSettings(input: PricingSettingsInput) {
  const tenantId = requireTenantId();
  const existingSettings = await ensurePricingSettings(tenantId);
  assertNonNegative(input.defaultMarginPercent, 'Domyślna marża');
  assertNonNegative(input.defaultMinProfit, 'Domyślny minimalny zysk');
  assertNonNegative(input.defaultVatRate, 'Domyślny VAT');
  assertNonNegative(input.abnormalProfitThreshold, 'Próg alertu');
  assertNonNegative(input.competitorAutoPricingMinMarkupPercent, 'Minimalny narzut automatu konkurencji');
  assertNonNegative(input.competitorAutoPricingBelowMarketTolerancePercent, 'Tolerancja poniżej rynku');
  assertNonNegative(input.competitorAutoPricingAboveMarketTolerancePercent, 'Tolerancja powyżej rynku');
  validateRounding(input.defaultRoundingMode);
  validateSync(input.defaultSyncMode);
  if (
    input.competitorAutoPricingIntervalMinutes !== undefined
    && (!Number.isInteger(input.competitorAutoPricingIntervalMinutes) || input.competitorAutoPricingIntervalMinutes < 60 || input.competitorAutoPricingIntervalMinutes > 10080)
  ) {
    throw new Error('Interwał automatu cen konkurencji musi być od 60 do 10080 minut');
  }
  const effectiveCompetitorShopId = input.competitorAutoPricingShopId === undefined
    ? existingSettings.competitorAutoPricingShopId
    : input.competitorAutoPricingShopId;
  if (input.competitorAutoPricingEnabled === true && !effectiveCompetitorShopId) {
    throw new Error('Włączony automat cen konkurencji wymaga wybranego sklepu');
  }

  if (input.competitorAutoPricingShopId !== undefined && input.competitorAutoPricingShopId !== null) {
    const shop = await prisma.shop.findFirst({
      where: { id: input.competitorAutoPricingShopId, tenantId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!shop) throw new Error('Wybrany sklep automatu cen konkurencji nie istnieje albo jest nieaktywny');
  }

  return prisma.warehousePricingSettings.update({
    where: { tenantId },
    data: {
      ...(input.defaultMarginPercent !== undefined ? { defaultMarginPercent: input.defaultMarginPercent } : {}),
      ...(input.defaultMinProfit !== undefined ? { defaultMinProfit: input.defaultMinProfit } : {}),
      ...(input.defaultVatRate !== undefined ? { defaultVatRate: input.defaultVatRate } : {}),
      ...(input.defaultRoundingMode !== undefined ? { defaultRoundingMode: input.defaultRoundingMode } : {}),
      ...(input.defaultSyncMode !== undefined ? { defaultSyncMode: input.defaultSyncMode } : {}),
      ...(input.costCeilingEnabledDefault !== undefined ? { costCeilingEnabledDefault: input.costCeilingEnabledDefault } : {}),
      ...(input.abnormalProfitThreshold !== undefined ? { abnormalProfitThreshold: input.abnormalProfitThreshold } : {}),
      ...(input.variantGroupingEnabled !== undefined ? { variantGroupingEnabled: input.variantGroupingEnabled } : {}),
      ...(input.competitorAutoPricingEnabled !== undefined ? { competitorAutoPricingEnabled: input.competitorAutoPricingEnabled } : {}),
      ...(input.competitorAutoPricingShopId !== undefined ? { competitorAutoPricingShopId: input.competitorAutoPricingShopId } : {}),
      ...(input.competitorAutoPricingIntervalMinutes !== undefined ? { competitorAutoPricingIntervalMinutes: input.competitorAutoPricingIntervalMinutes } : {}),
      ...(input.competitorAutoPricingMinMarkupPercent !== undefined ? { competitorAutoPricingMinMarkupPercent: input.competitorAutoPricingMinMarkupPercent } : {}),
      ...(input.competitorAutoPricingBelowMarketTolerancePercent !== undefined ? { competitorAutoPricingBelowMarketTolerancePercent: input.competitorAutoPricingBelowMarketTolerancePercent } : {}),
      ...(input.competitorAutoPricingAboveMarketTolerancePercent !== undefined ? { competitorAutoPricingAboveMarketTolerancePercent: input.competitorAutoPricingAboveMarketTolerancePercent } : {}),
      ...(input.competitorAutoPricingEnabled === false ? { competitorAutoPricingLastErrorAt: null, competitorAutoPricingLastErrorMessage: null } : {}),
    },
  });
}

export async function getPricingRules(query: PricingRulesQuery = {}) {
  const tenantId = requireTenantId();
  const where: Prisma.WarehousePricingRuleWhereInput = { tenantId };
  if (query.level) where.level = query.level;
  if (query.shopId) where.shopId = query.shopId;
  if (query.catalogId) where.catalogId = query.catalogId;
  if (query.priceGroupId) where.priceGroupId = query.priceGroupId;
  if (query.warehouseProductId) where.warehouseProductId = query.warehouseProductId;
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.origin) where.origin = query.origin;

  return prisma.warehousePricingRule.findMany({
    where,
    orderBy: [{ level: 'asc' }, { updatedAt: 'desc' }],
    include: {
      shop: { select: { id: true, name: true } },
      catalog: { select: { id: true, name: true } },
      priceGroup: { select: { id: true, name: true, priority: true } },
      warehouseProduct: { select: { id: true, sku: true, name: true } },
    },
  });
}

export async function createPricingRule(input: PricingRuleInput) {
  const tenantId = requireTenantId();
  const data = normalizeRuleInput(input);
  await assertRuleTargets(tenantId, data);
  return prisma.warehousePricingRule.create({ data: { tenantId, ...data } });
}

export async function updatePricingRule(id: string, input: Partial<PricingRuleInput>) {
  const tenantId = requireTenantId();
  const existing = await prisma.warehousePricingRule.findFirst({ where: { id, tenantId } });
  if (!existing) throw new Error('Reguła cennika nie znaleziona');

  const merged = normalizeRuleInput({
    level: (input.level ?? existing.level) as PricingRuleLevel,
    shopId: input.shopId === undefined ? existing.shopId : input.shopId,
    catalogId: input.catalogId === undefined ? existing.catalogId : input.catalogId,
    priceGroupId: input.priceGroupId === undefined ? existing.priceGroupId : input.priceGroupId,
    warehouseProductId: input.warehouseProductId === undefined ? existing.warehouseProductId : input.warehouseProductId,
    marginPercent: input.marginPercent === undefined ? numberOrNull(existing.marginPercent) : input.marginPercent,
    minProfit: input.minProfit === undefined ? numberOrNull(existing.minProfit) : input.minProfit,
    fixedNetPrice: input.fixedNetPrice === undefined ? numberOrNull(existing.fixedNetPrice) : input.fixedNetPrice,
    priceMode: (input.priceMode ?? existing.priceMode) as PricingPriceMode,
    costCeilingEnabled: input.costCeilingEnabled === undefined ? existing.costCeilingEnabled : input.costCeilingEnabled,
    vatRate: input.vatRate === undefined ? numberOrNull(existing.vatRate) : input.vatRate,
    roundingMode: input.roundingMode === undefined ? existing.roundingMode as PricingRoundingMode | null : input.roundingMode,
    syncMode: input.syncMode === undefined ? existing.syncMode as PricingSyncMode | null : input.syncMode,
    origin: input.origin === undefined ? existing.origin as PricingRuleOrigin : input.origin,
    isActive: input.isActive ?? existing.isActive,
  });

  await assertRuleTargets(tenantId, merged);
  return prisma.warehousePricingRule.update({ where: { id }, data: merged });
}

export async function deletePricingRule(id: string) {
  const tenantId = requireTenantId();
  const existing = await prisma.warehousePricingRule.findFirst({ where: { id, tenantId } });
  if (!existing) throw new Error('Reguła cennika nie znaleziona');
  await prisma.warehousePricingRule.delete({ where: { id } });
  return { deleted: true };
}

async function assertRuleTargets(tenantId: string, input: ReturnType<typeof normalizeRuleInput>) {
  const checks = [];
  if (input.shopId) checks.push(prisma.shop.findFirst({ where: { id: input.shopId, tenantId }, select: { id: true } }));
  if (input.catalogId) checks.push(prisma.warehouseCatalog.findFirst({ where: { id: input.catalogId, tenantId }, select: { id: true } }));
  if (input.priceGroupId) checks.push(prisma.warehousePriceGroup.findFirst({ where: { id: input.priceGroupId, tenantId }, select: { id: true } }));
  if (input.warehouseProductId) checks.push(prisma.warehouseProduct.findFirst({ where: { id: input.warehouseProductId, tenantId }, select: { id: true } }));
  const result = await Promise.all(checks);
  if (result.some((item) => !item)) throw new Error('Cel reguły cennika nie istnieje');
}

async function resolveProductsAndShops(tenantId: string, input: PricingProductsInput, take = MAX_PRICING_PRODUCTS) {
  const productWhere: Prisma.WarehouseProductWhereInput = {
    tenantId,
    isActive: true,
    ...(input.productIds?.length ? { id: { in: input.productIds.slice(0, take) } } : {}),
    ...(input.catalogId ? { catalogId: input.catalogId } : {}),
    ...(input.priceGroupId ? { priceGroupMembers: { some: { priceGroupId: input.priceGroupId } } } : {}),
  };

  const shopWhere: Prisma.ShopWhereInput = {
    tenantId,
    status: 'ACTIVE',
    ...(input.shopIds?.length ? { id: { in: input.shopIds } } : {}),
  };

  const [products, shops] = await Promise.all([
    prisma.warehouseProduct.findMany({
      where: productWhere,
      take,
      include: productPricingInclude,
      orderBy: { name: 'asc' },
    }),
    prisma.shop.findMany({ where: shopWhere, select: { id: true, name: true } }),
  ]);

  return { products, shops };
}

type ProductForPricing = Awaited<ReturnType<typeof resolveProductsAndShops>>['products'][number];
type ShopForPricing = Awaited<ReturnType<typeof resolveProductsAndShops>>['shops'][number];
type RuleForPricing = Awaited<ReturnType<typeof loadPricingRules>>[number];
type ClearanceForPricing = Awaited<ReturnType<typeof loadActiveClearances>>[number];
type SettingsForPricing = Awaited<ReturnType<typeof ensurePricingSettings>>;
type ProductForPricingList = ProductForPricing & {
  productChannelSnapshots?: Array<{
    shopId: string;
    payloadJson: Prisma.JsonValue;
  }>;
};

interface PriceGroupInfo {
  id: string;
  name: string;
  priority: number;
}

interface PricingState {
  settings: SettingsForPricing;
  rules: RuleForPricing[];
  clearances: ClearanceForPricing[];
  groupsByProduct: Map<string, PriceGroupInfo[]>;
}

async function loadPricingRules(tenantId: string) {
  return prisma.warehousePricingRule.findMany({
    where: { tenantId, isActive: true },
    include: { priceGroup: { select: { id: true, name: true, priority: true } } },
    orderBy: { updatedAt: 'desc' },
  });
}

async function loadActiveClearances(tenantId: string) {
  const now = new Date();
  return prisma.warehouseClearance.findMany({
    where: {
      tenantId,
      isActive: true,
      OR: [{ validFrom: null }, { validFrom: { lte: now } }],
      AND: [{ OR: [{ validTo: null }, { validTo: { gte: now } }] }],
    },
    include: {
      priceGroup: { select: { id: true, name: true, priority: true } },
      warehouseProduct: { select: { id: true, sku: true, name: true } },
      shop: { select: { id: true, name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });
}

async function loadPricingState(tenantId: string): Promise<PricingState> {
  const [settings, rules, clearances, members] = await Promise.all([
    ensurePricingSettings(tenantId),
    loadPricingRules(tenantId),
    loadActiveClearances(tenantId),
    prisma.warehousePriceGroupMember.findMany({
      where: { tenantId, priceGroup: { isActive: true } },
      include: { priceGroup: { select: { id: true, name: true, priority: true } } },
    }),
  ]);
  const groupsByProduct = new Map<string, PriceGroupInfo[]>();
  for (const member of members) {
    const list = groupsByProduct.get(member.warehouseProductId) ?? [];
    list.push(member.priceGroup);
    groupsByProduct.set(member.warehouseProductId, list);
  }
  for (const groups of groupsByProduct.values()) {
    groups.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
  }
  return { settings, rules, clearances, groupsByProduct };
}

function rulePriority(rule: RuleForPricing, product: ProductForPricing, shopId: string, productGroups: PriceGroupInfo[]) {
  const groupIds = new Set(productGroups.map((group) => group.id));
  if (rule.level === 'PRODUCT' && rule.warehouseProductId === product.id && rule.shopId === shopId) return 70;
  if (rule.level === 'PRODUCT' && rule.warehouseProductId === product.id && !rule.shopId) return 60;
  if (rule.level === 'GROUP' && rule.priceGroupId && groupIds.has(rule.priceGroupId) && rule.shopId === shopId) return 58;
  if (rule.level === 'GROUP' && rule.priceGroupId && groupIds.has(rule.priceGroupId) && !rule.shopId) return 56;
  if (rule.level === 'CATALOG' && rule.catalogId === product.catalogId && rule.shopId === shopId) return 50;
  if (rule.level === 'CATALOG' && rule.catalogId === product.catalogId && !rule.shopId) return 40;
  if (rule.level === 'SHOP' && rule.shopId === shopId) return 30;
  if (rule.level === 'GLOBAL') return 5;
  return 0;
}

function resolveRule(product: ProductForPricing, shopId: string, state: PricingState) {
  const productGroups = state.groupsByProduct.get(product.id) ?? [];
  return state.rules
    .map((rule) => ({
      rule,
      priority: rulePriority(rule, product, shopId, productGroups),
      groupPriority: rule.level === 'GROUP' ? rule.priceGroup?.priority ?? 0 : 0,
    }))
    .filter((item) => item.priority > 0)
    .sort((a, b) =>
      b.priority - a.priority ||
      b.groupPriority - a.groupPriority ||
      b.rule.updatedAt.getTime() - a.rule.updatedAt.getTime(),
    )[0]?.rule ?? null;
}

export function roundPrice(value: Prisma.Decimal, mode: PricingRoundingMode) {
  const n = Number(value);
  if (!Number.isFinite(n)) return new Prisma.Decimal(0);
  if (mode === 'TENTH') return new Prisma.Decimal((Math.ceil(n * 10) / 10).toFixed(2));
  if (mode === 'CENT') return new Prisma.Decimal((Math.ceil(n * 100) / 100).toFixed(2));

  const cents = Math.round((n - Math.floor(n)) * 100);
  if (cents === 0 || cents === 99) return new Prisma.Decimal(n.toFixed(2));
  const ceil = Math.ceil(n);
  const candidate = ceil <= 0 ? 0.99 : ceil - 0.01;
  return new Prisma.Decimal((candidate + 0.0000001 < n ? candidate + 1 : candidate).toFixed(2));
}

function marginNetPrice(costBasis: Prisma.Decimal, marginPercent: Prisma.Decimal, minProfit: Prisma.Decimal) {
  return costBasis.plus(Prisma.Decimal.max(costBasis.mul(marginPercent).div(100), minProfit));
}

function sourceFromRule(rule: RuleForPricing | null): PricingPriceSource {
  if (rule?.level === 'PRODUCT') return 'PRODUCT';
  if (rule?.level === 'GROUP') return 'GROUP';
  if (rule?.level === 'CATALOG') return 'CATALOG';
  if (rule?.level === 'SHOP') return 'SHOP';
  return 'DEFAULT';
}

function resolveCostBasis(product: ProductForPricing): { costBasis: Prisma.Decimal | null; costSource: PricingCostSource } {
  const documentCost = decimal(product.averagePurchaseCost) ?? decimal(product.purchasePrice);
  if (documentCost) return { costBasis: documentCost, costSource: 'DOCUMENT' };

  const wholesaleCost = decimal(product.wholesaleMappings[0]?.lastKnownPrice);
  if (wholesaleCost) return { costBasis: wholesaleCost, costSource: 'WHOLESALE' };

  return { costBasis: null, costSource: null };
}

function categoryIdsFromSnapshotPayload(payloadJson: Prisma.JsonValue | null | undefined) {
  const root = toRecord(payloadJson);
  const parameters = toRecord(root.parameters);
  const identity = toRecord(root.identity);
  const rawCategories = toArray(root.categories).length > 0 ? toArray(root.categories) : toArray(parameters.categories);
  const ids = new Set<string>();

  for (const item of rawCategories) {
    const directId = stringValue(item);
    if (directId) {
      ids.add(directId);
      continue;
    }

    const category = toRecord(item);
    const id = stringValue(category.id ?? category.categoryId ?? category.id_category);
    if (id) ids.add(id);
  }

  const defaultId = stringValue(identity.idCategoryDefault ?? identity.defaultCategoryId ?? identity.id_category_default);
  if (defaultId) ids.add(defaultId);

  return ids;
}

function snapshotCategoryIds(product: ProductForPricingList, shopId: string) {
  const snapshot = product.productChannelSnapshots?.find((item) => item.shopId === shopId) ?? null;
  return categoryIdsFromSnapshotPayload(snapshot?.payloadJson);
}

function productMatchesCategories(product: ProductForPricingList, shopId: string, categoryIds: Set<string>) {
  if (categoryIds.size === 0) return true;
  const productCategoryIds = snapshotCategoryIds(product, shopId);
  for (const categoryId of categoryIds) {
    if (productCategoryIds.has(categoryId)) return true;
  }
  return false;
}

function clearancePriority(clearance: ClearanceForPricing, product: ProductForPricing, shopId: string, productGroups: PriceGroupInfo[]) {
  const groupIds = new Set(productGroups.map((group) => group.id));
  const shopMatches = clearance.shopId === shopId;
  const globalShop = !clearance.shopId;

  if (clearance.scope === 'PRODUCT' && clearance.warehouseProductId === product.id && shopMatches) return 100;
  if (clearance.scope === 'PRODUCT' && clearance.warehouseProductId === product.id && globalShop) return 98;
  if (clearance.scope === 'GROUP' && clearance.priceGroupId && groupIds.has(clearance.priceGroupId) && shopMatches) return 96;
  if (clearance.scope === 'GROUP' && clearance.priceGroupId && groupIds.has(clearance.priceGroupId) && globalShop) return 94;
  return 0;
}

function pickActiveClearance(product: ProductForPricing, shopId: string, state: PricingState, productGroups: PriceGroupInfo[]) {
  return (state.clearances ?? [])
    .map((clearance) => ({
      clearance,
      priority: clearancePriority(clearance, product, shopId, productGroups),
      groupPriority: clearance.scope === 'GROUP' ? clearance.priceGroup?.priority ?? 0 : 0,
    }))
    .filter((item) => item.priority > 0)
    .sort((a, b) =>
      b.priority - a.priority ||
      b.groupPriority - a.groupPriority ||
      b.clearance.updatedAt.getTime() - a.clearance.updatedAt.getTime(),
    )[0]?.clearance ?? null;
}

type PricingCategoryShop = {
  id: string;
  tenantId: string;
  name: string;
  platform: string;
  baseUrl: string;
  apiKey: string;
  configJson: Prisma.JsonValue | null;
};

function publicCategoryUrl(shop: PricingCategoryShop, category: PrestaShopCategoryDetails) {
  const baseUrl = shop.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '');
  const rewrite = category.linkRewrite?.trim() || categorySlug(category.name) || category.id;
  return `${baseUrl}/${encodeURIComponent(category.id)}-${encodeURIComponent(rewrite)}`;
}

async function fetchPublicCategoryProductIds(shop: PricingCategoryShop, categoryId: string) {
  if (shop.platform !== 'PRESTASHOP') return [];

  const cacheKey = `${shop.id}:${categoryId}`;
  const cached = categoryListingProductIdsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.externalProductIds;

  try {
    const config = toRecord(shop.configJson);
    const client = new PrestaShopClient({
      baseUrl: shop.baseUrl,
      apiKey: decrypt(shop.apiKey),
      authType: stringValue(config.authType) === 'ADMIN_API' ? 'ADMIN_API' : 'WEB_SERVICE',
      adminApiConfig: config.authType === 'ADMIN_API' ? (config.adminApi as any) : undefined,
    });
    const category = await client.fetchCategory(categoryId);
    const baseUrl = publicCategoryUrl(shop, category);
    const externalProductIds = new Set<string>();

    for (let page = 1; page <= CATEGORY_LISTING_MAX_PAGES; page++) {
      const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
      const response = await fetch(url, {
        headers: { 'user-agent': 'KP Admin category pricing lookup' },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) break;

      const html = await response.text();
      for (const match of html.matchAll(/data-id-product=["'](\d+)["']/g)) {
        if (match[1]) externalProductIds.add(match[1]);
      }

      const nextPagePattern = new RegExp(`[?&]page=${page + 1}(?:["'&<])`);
      if (!nextPagePattern.test(html)) break;
    }

    const result = Array.from(externalProductIds);
    categoryListingProductIdsCache.set(cacheKey, {
      expiresAt: Date.now() + CATEGORY_LISTING_CACHE_TTL_MS,
      externalProductIds: result,
    });
    return result;
  } catch {
    categoryListingProductIdsCache.set(cacheKey, {
      expiresAt: Date.now() + 30_000,
      externalProductIds: [],
    });
    return [];
  }
}

async function resolveCategoryWarehouseProductIds(
  tenantId: string,
  shop: PricingCategoryShop,
  query: PricingProductsQuery,
  categoryIds: Set<string>,
) {
  const productIds = new Set<string>();

  const snapshots = await prisma.productChannelSnapshot.findMany({
    where: { tenantId, shopId: shop.id },
    select: { warehouseProductId: true, shopId: true, payloadJson: true },
  });
  for (const snapshot of snapshots) {
    const snapshotCategoryIds = categoryIdsFromSnapshotPayload(snapshot.payloadJson);
    if (Array.from(categoryIds).some((categoryId) => snapshotCategoryIds.has(categoryId))) {
      productIds.add(snapshot.warehouseProductId);
    }
  }

  const selectedCategoryId = normalizeCategoryId(query.categoryId);
  if (selectedCategoryId) {
    const externalProductIds = await fetchPublicCategoryProductIds(shop, selectedCategoryId);
    if (externalProductIds.length > 0) {
      const mappings = await prisma.shopProductMapping.findMany({
        where: {
          tenantId,
          shopId: shop.id,
          isActive: true,
          externalProductId: { in: externalProductIds },
          warehouseProductId: { not: null },
        },
        select: { warehouseProductId: true },
      });
      for (const mapping of mappings) {
        if (mapping.warehouseProductId) productIds.add(mapping.warehouseProductId);
      }
    }
  }

  return productIds;
}

function skuFamilyBase(sku: string) {
  const normalized = sku.trim().replace(/\s+/g, '').toUpperCase();
  if (!normalized || !normalized.includes('-')) return null;
  const parts = normalized.split('-').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.length >= 3) return parts.slice(0, -1).join('-');
  if (!/[A-Z]/.test(parts[0])) return null;
  return parts[0];
}

function variantFamily(product: ProductForPricing) {
  const base = skuFamilyBase(product.sku);
  if (!base) {
    return {
      variantFamilyKey: `product:${product.id}`,
      variantFamilyName: product.name,
      variantFamilySource: 'SELF',
      variantSortKey: product.sku,
    };
  }

  return {
    variantFamilyKey: `sku:${base}`,
    variantFamilyName: base,
    variantFamilySource: 'SKU',
    variantSortKey: product.sku,
  };
}

function calculatePrice(product: ProductForPricing, shop: ShopForPricing, state: PricingState) {
  const rule = resolveRule(product, shop.id, state);
  const productGroups = state.groupsByProduct.get(product.id) ?? [];
  const primaryGroup = productGroups[0] ?? null;
  const ruleGroup = rule?.priceGroup ?? null;
  const visibleGroup = ruleGroup ?? primaryGroup;
  const family = variantFamily(product);
  const { costBasis, costSource } = resolveCostBasis(product);
  const marginPercent = decimal(rule?.marginPercent) ?? decimal(state.settings.defaultMarginPercent) ?? new Prisma.Decimal(DEFAULT_PRICING.marginPercent);
  const minProfit = decimal(rule?.minProfit) ?? decimal(state.settings.defaultMinProfit) ?? new Prisma.Decimal(DEFAULT_PRICING.minProfit);
  const vatRate = decimal(rule?.vatRate) ?? decimal(state.settings.defaultVatRate) ?? new Prisma.Decimal(DEFAULT_PRICING.vatRate);
  const roundingMode = (rule?.roundingMode ?? state.settings.defaultRoundingMode ?? DEFAULT_PRICING.roundingMode) as PricingRoundingMode;
  const syncMode = (rule?.syncMode ?? state.settings.defaultSyncMode ?? DEFAULT_PRICING.syncMode) as PricingSyncMode;
  const fixedNetPrice = decimal(rule?.fixedNetPrice);
  const priceMode = (rule?.priceMode ?? (fixedNetPrice ? 'FIXED' : 'MARGIN')) as PricingPriceMode;
  const costCeilingEnabled = rule?.costCeilingEnabled ?? state.settings.costCeilingEnabledDefault ?? DEFAULT_PRICING.costCeilingEnabledDefault;
  const baseSource = sourceFromRule(rule);
  const overridesGroup = baseSource === 'PRODUCT' && productGroups.length > 0;
  const clearance = pickActiveClearance(product, shop.id, state, productGroups);

  if (clearance) {
    const clearanceGroup = clearance.priceGroup ?? visibleGroup;
    const netPrice = toMoney(decimal(clearance.clearanceNetPrice)!);
    const grossPrice = toMoney(netPrice.mul(new Prisma.Decimal(1).plus(vatRate.div(100))));
    const profitAmount = costBasis ? toMoney(netPrice.minus(costBasis)) : null;
    const realizedMarginPercent = costBasis && profitAmount ? Number(profitAmount.div(costBasis).mul(100).toFixed(3)) : null;
    let warningCode: PricingWarningCode = null;
    let warningMessage: string | null = null;

    if (!costBasis) {
      warningCode = 'MISSING_COST';
      warningMessage = 'Brak kosztu bazowego produktu';
    } else if (netPrice.lessThan(costBasis)) {
      warningCode = 'BELOW_COST';
      warningMessage = 'Cena wyprzedażowa jest niższa od kosztu bazowego';
    } else if (profitAmount && profitAmount.lessThan(minProfit)) {
      warningCode = 'BELOW_MIN_PROFIT';
      warningMessage = 'Cena wyprzedażowa jest poniżej minimalnego zysku';
    }

    return {
      shopId: shop.id,
      shopName: shop.name,
      warehouseProductId: product.id,
      sku: product.sku,
      name: product.name,
      catalogName: product.catalog?.name ?? null,
      primaryEan: product.barcodes.find((barcode) => barcode.isPrimary)?.ean ?? product.barcodes[0]?.ean ?? null,
      pricingRuleId: null,
      pricingRuleLevel: null,
      ruleOrigin: null,
      priceSource: 'CLEARANCE' as PricingPriceSource,
      priceMode: 'FIXED' as PricingPriceMode,
      priceGroupId: clearanceGroup?.id ?? null,
      priceGroupName: clearanceGroup?.name ?? null,
      clearanceId: clearance.id,
      clearanceUntil: clearance.validTo ?? null,
      costBasis: numberOrNull(costBasis),
      costSource,
      netPrice: Number(netPrice),
      grossPrice: Number(grossPrice),
      marginPercent: realizedMarginPercent ?? Number(marginPercent),
      configuredMarginPercent: Number(marginPercent),
      realizedMarginPercent,
      profitAmount: numberOrNull(profitAmount),
      warningCode,
      warningMessage,
      infoCode: null as PricingInfoCode,
      overridesGroup,
      syncMode,
      ...family,
    };
  }

  if (!costBasis && !(priceMode === 'FIXED' && fixedNetPrice)) {
    return {
      shopId: shop.id,
      shopName: shop.name,
      warehouseProductId: product.id,
      sku: product.sku,
      name: product.name,
      catalogName: product.catalog?.name ?? null,
      primaryEan: product.barcodes.find((barcode) => barcode.isPrimary)?.ean ?? product.barcodes[0]?.ean ?? null,
      pricingRuleId: rule?.id ?? null,
      pricingRuleLevel: rule?.level ?? null,
      ruleOrigin: rule?.origin ?? null,
      priceSource: baseSource,
      priceMode,
      priceGroupId: visibleGroup?.id ?? null,
      priceGroupName: visibleGroup?.name ?? null,
      clearanceId: null,
      clearanceUntil: null,
      costBasis: null,
      costSource,
      netPrice: null,
      grossPrice: null,
      marginPercent: Number(marginPercent),
      configuredMarginPercent: Number(marginPercent),
      realizedMarginPercent: null,
      profitAmount: null,
      warningCode: 'MISSING_COST' as PricingWarningCode,
      warningMessage: 'Brak kosztu bazowego produktu',
      infoCode: null as PricingInfoCode,
      overridesGroup,
      syncMode,
      ...family,
    };
  }

  let priceSource = baseSource;
  let rawNetPrice: Prisma.Decimal;
  if (priceMode === 'FIXED' && fixedNetPrice) {
    if (costBasis && costCeilingEnabled && costBasis.plus(minProfit).greaterThan(fixedNetPrice)) {
      rawNetPrice = marginNetPrice(costBasis, marginPercent, minProfit);
      priceSource = 'CEILING_FALLBACK';
    } else {
      rawNetPrice = fixedNetPrice;
    }
  } else {
    rawNetPrice = marginNetPrice(costBasis!, marginPercent, minProfit);
  }

  const shouldRound = !(priceMode === 'FIXED' && priceSource !== 'CEILING_FALLBACK');
  const netPrice = toMoney(shouldRound ? roundPrice(rawNetPrice, roundingMode) : rawNetPrice);
  const grossPrice = toMoney(netPrice.mul(new Prisma.Decimal(1).plus(vatRate.div(100))));
  const profitAmount = costBasis ? toMoney(netPrice.minus(costBasis)) : null;
  const realizedMarginPercent = costBasis && profitAmount ? Number(profitAmount.div(costBasis).mul(100).toFixed(3)) : null;

  let warningCode: PricingWarningCode = null;
  let warningMessage: string | null = null;
  if (!costBasis) {
    warningCode = 'MISSING_COST';
    warningMessage = 'Brak kosztu bazowego produktu';
  } else if (netPrice.lessThan(costBasis)) {
    warningCode = 'BELOW_COST';
    warningMessage = 'Cena sprzedaży jest niższa od kosztu bazowego';
  } else if (profitAmount && profitAmount.lessThan(minProfit)) {
    warningCode = 'BELOW_MIN_PROFIT';
    warningMessage = 'Cena sprzedaży jest poniżej minimalnego zysku';
  }

  const threshold = Number(state.settings.abnormalProfitThreshold ?? DEFAULT_PRICING.abnormalProfitThreshold);
  const normalMargin = Number(marginPercent);
  const infoCode: PricingInfoCode = realizedMarginPercent !== null && normalMargin > 0 && realizedMarginPercent >= normalMargin * (threshold / 100)
    ? 'ABNORMAL_PROFIT'
    : null;

  return {
    shopId: shop.id,
    shopName: shop.name,
    warehouseProductId: product.id,
    sku: product.sku,
    name: product.name,
    catalogName: product.catalog?.name ?? null,
    primaryEan: product.barcodes.find((barcode) => barcode.isPrimary)?.ean ?? product.barcodes[0]?.ean ?? null,
    pricingRuleId: rule?.id ?? null,
    pricingRuleLevel: rule?.level ?? null,
    ruleOrigin: rule?.origin ?? null,
    priceSource,
    priceMode,
    priceGroupId: visibleGroup?.id ?? null,
    priceGroupName: visibleGroup?.name ?? null,
    clearanceId: null,
    clearanceUntil: null,
    costBasis: numberOrNull(costBasis),
    costSource,
    netPrice: Number(netPrice),
    grossPrice: Number(grossPrice),
    marginPercent: realizedMarginPercent ?? Number(marginPercent),
    configuredMarginPercent: Number(marginPercent),
    realizedMarginPercent,
    profitAmount: numberOrNull(profitAmount),
    warningCode,
    warningMessage,
    infoCode,
    overridesGroup,
    syncMode,
    ...family,
  };
}

type BasePricingItem = ReturnType<typeof calculatePrice>;
type PricingItem = BasePricingItem & {
  isVariantFamily?: boolean;
  variantCount?: number;
  variantProductIds?: string[];
  variants?: PricingItem[];
  familyStats?: {
    minCostBasis: number | null;
    maxCostBasis: number | null;
    minNetPrice: number | null;
    maxNetPrice: number | null;
    minGrossPrice: number | null;
    maxGrossPrice: number | null;
    ready: number;
    warnings: number;
    missingPrice: number;
    overridesGroup: number;
  };
};

export async function previewPricingForTenant(tenantId: string, input: PricingProductsInput = {}) {
  const resolvedInput = await resolveScopedPricingInput(tenantId, input);
  const [{ products, shops }, state] = await Promise.all([
    resolveProductsAndShops(tenantId, resolvedInput),
    loadPricingState(tenantId),
  ]);
  const shopById = new Map(shops.map((shop) => [shop.id, shop]));
  const items: PricingItem[] = [];

  for (const product of products) {
    const mappedShopIds = new Set(product.shopProductMappings.map((mapping) => mapping.shopId));
    const targetShops = resolvedInput.shopIds?.length
      ? resolvedInput.shopIds.map((shopId) => shopById.get(shopId)).filter(Boolean) as ShopForPricing[]
      : shops.filter((shop) => mappedShopIds.has(shop.id));
    for (const shop of targetShops) items.push(calculatePrice(product, shop, state));
  }

  return buildPricingResponse(items);
}

export async function previewPricing(input: PricingProductsInput = {}) {
  return previewPricingForTenant(requireTenantId(), input);
}

export async function recalculatePricingForTenant(tenantId: string, input: PricingProductsInput = {}) {
  const result = await previewPricingForTenant(tenantId, input);

  for (const item of result.items) {
    await prisma.warehouseProductShopPrice.upsert({
      where: {
        warehouseProductId_shopId: {
          warehouseProductId: item.warehouseProductId,
          shopId: item.shopId,
        },
      },
      create: {
        tenantId,
        warehouseProductId: item.warehouseProductId,
        shopId: item.shopId,
        pricingRuleId: item.pricingRuleId,
        pricingRuleLevel: item.pricingRuleLevel,
        priceSource: item.priceSource,
        priceMode: item.priceMode,
        priceGroupId: item.priceGroupId,
        priceGroupName: item.priceGroupName,
        clearanceId: item.clearanceId,
        clearanceUntil: item.clearanceUntil,
        costBasis: item.costBasis,
        netPrice: item.netPrice,
        grossPrice: item.grossPrice,
        marginPercent: item.marginPercent,
        configuredMarginPercent: item.configuredMarginPercent,
        realizedMarginPercent: item.realizedMarginPercent,
        profitAmount: item.profitAmount,
        warningCode: item.warningCode,
        warningMessage: item.warningMessage,
        infoCode: item.infoCode,
        overridesGroup: item.overridesGroup,
        syncMode: item.syncMode,
      },
      update: {
        pricingRuleId: item.pricingRuleId,
        pricingRuleLevel: item.pricingRuleLevel,
        priceSource: item.priceSource,
        priceMode: item.priceMode,
        priceGroupId: item.priceGroupId,
        priceGroupName: item.priceGroupName,
        clearanceId: item.clearanceId,
        clearanceUntil: item.clearanceUntil,
        costBasis: item.costBasis,
        netPrice: item.netPrice,
        grossPrice: item.grossPrice,
        marginPercent: item.marginPercent,
        configuredMarginPercent: item.configuredMarginPercent,
        realizedMarginPercent: item.realizedMarginPercent,
        profitAmount: item.profitAmount,
        warningCode: item.warningCode,
        warningMessage: item.warningMessage,
        infoCode: item.infoCode,
        overridesGroup: item.overridesGroup,
        syncMode: item.syncMode,
        calculatedAt: new Date(),
      },
    });
  }

  return result;
}

export async function recalculatePricing(input: PricingProductsInput = {}) {
  return recalculatePricingForTenant(requireTenantId(), input);
}

export async function bulkUpdateProductPrices(input: BulkUpdatePricesInput) {
  const tenantId = requireTenantId();
  if (!input.productIds?.length) throw new Error('Wybierz produkty do masowej edycji cen');
  const rules = [];

  for (const productId of input.productIds.slice(0, MAX_PRICING_PRODUCTS)) {
    const data = normalizeRuleInput({
      level: 'PRODUCT',
      warehouseProductId: productId,
      shopId: input.shopIds?.length === 1 ? input.shopIds[0] : null,
      marginPercent: input.marginPercent,
      minProfit: input.minProfit,
      fixedNetPrice: input.fixedNetPrice,
      priceMode: input.priceMode,
      costCeilingEnabled: input.costCeilingEnabled,
      vatRate: input.vatRate,
      roundingMode: input.roundingMode,
      syncMode: input.syncMode,
      isActive: true,
    });
    await assertRuleTargets(tenantId, data);

    const existingRules = await prisma.warehousePricingRule.findMany({
      where: {
        tenantId,
        level: 'PRODUCT',
        warehouseProductId: data.warehouseProductId,
        shopId: data.shopId,
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const primary = existingRules[0];
    if (primary) {
      rules.push(await prisma.warehousePricingRule.update({
        where: { id: primary.id },
        data,
      }));
      if (existingRules.length > 1) {
        await prisma.warehousePricingRule.updateMany({
          where: {
            id: { in: existingRules.slice(1).map((rule) => rule.id) },
            tenantId,
          },
          data: { isActive: false },
        });
      }
    } else {
      rules.push(await prisma.warehousePricingRule.create({ data: { tenantId, ...data } }));
    }
  }

  const preview = await recalculatePricing({ productIds: input.productIds, shopIds: input.shopIds });
  const autoSyncItems = preview.items.filter((item) => item.syncMode === 'AUTO' && item.netPrice !== null && item.warningCode !== 'BELOW_COST');
  if (autoSyncItems.length > 0) await syncPricing({ productIds: input.productIds, shopIds: input.shopIds });

  return { createdRules: rules.length, skippedAutoSyncBelowCost: preview.items.filter((item) => item.syncMode === 'AUTO' && item.warningCode === 'BELOW_COST').length, ...preview };
}

export async function syncPricingForTenant(tenantId: string, input: PricingProductsInput = {}) {
  const preview = await recalculatePricingForTenant(tenantId, input);
  let enqueued = 0;
  let synced = 0;
  const errors: Array<{ warehouseProductId: string; shopId: string; message: string }> = [];
  const readyItems: Array<{ warehouseProductId: string; shopId: string; price: number; triggeredBy: PriceSyncTriggeredBy }> = [];

  for (const item of preview.items) {
    if (item.netPrice === null) {
      errors.push({ warehouseProductId: item.warehouseProductId, shopId: item.shopId, message: item.warningMessage ?? 'Brak ceny do synchronizacji' });
      continue;
    }
    if (item.warningCode === 'BELOW_COST' && !input.allowBelowCostSync) {
      errors.push({
        warehouseProductId: item.warehouseProductId,
        shopId: item.shopId,
        message: 'Cena jest poniżej kosztu. Potwierdź synchronizację poniżej kosztu, aby wysłać ją do sklepu.',
      });
      continue;
    }
    readyItems.push({
      warehouseProductId: item.warehouseProductId,
      shopId: item.shopId,
      price: item.netPrice,
      triggeredBy: input.triggeredBy ?? 'MANUAL',
    });
  }

  if (readyItems.length > 0) {
    const result = await syncProductPricesBulkForTenant(tenantId, readyItems);
    enqueued += result.enqueued;
    synced += result.synced;
    errors.push(...result.errors);
  }

  return { ...preview, enqueued, synced, errors };
}

export async function syncPricing(input: PricingProductsInput = {}) {
  return syncPricingForTenant(requireTenantId(), input);
}

function numericValues(items: PricingItem[], field: keyof PricingItem) {
  return items
    .map((item) => Number(item[field]))
    .filter((value) => Number.isFinite(value));
}

function minOrNull(values: number[]) {
  return values.length ? Math.min(...values) : null;
}

function maxOrNull(values: number[]) {
  return values.length ? Math.max(...values) : null;
}

function commonPrefix(values: string[]) {
  if (values.length === 0) return '';
  let prefix = values[0] ?? '';
  for (const value of values.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < value.length && prefix[index]?.toLowerCase() === value[index]?.toLowerCase()) {
      index += 1;
    }
    prefix = prefix.slice(0, index);
    if (!prefix) break;
  }
  return prefix.replace(/[\s,;:./\\()[\]{}_-]+$/g, '').trim();
}

function familyDisplayName(items: PricingItem[], fallback: string) {
  const prefix = commonPrefix(items.map((item) => item.name ?? '').filter(Boolean));
  if (prefix.length >= 8) return prefix;
  const firstName = items[0]?.name?.replace(/\s+[-–—]\s+.*$/, '').replace(/,\s*.*$/, '').trim();
  return firstName && firstName.length >= 8 ? firstName : fallback;
}

function decorateVariantFamily(items: PricingItem[]) {
  if (items.length === 0) return [];
  const variantProductIds = items.map((item) => item.warehouseProductId);
  const variantCount = items.length;
  const costValues = numericValues(items, 'costBasis');
  const netValues = numericValues(items, 'netPrice');
  const grossValues = numericValues(items, 'grossPrice');

  return items.map((item) => ({
    ...item,
    variantCount,
    variantProductIds,
    familyStats: {
      minCostBasis: minOrNull(costValues),
      maxCostBasis: maxOrNull(costValues),
      minNetPrice: minOrNull(netValues),
      maxNetPrice: maxOrNull(netValues),
      minGrossPrice: minOrNull(grossValues),
      maxGrossPrice: maxOrNull(grossValues),
      ready: items.filter((variant) => variant.netPrice !== null).length,
      warnings: items.filter((variant) => variant.warningCode).length,
      missingPrice: items.filter((variant) => variant.netPrice === null).length,
      overridesGroup: items.filter((variant) => variant.overridesGroup).length,
    },
  }));
}

function groupVariantPricingItems(items: PricingItem[]) {
  const groups = new Map<string, PricingItem[]>();
  for (const item of items) {
    const key = item.variantFamilyKey || `product:${item.warehouseProductId}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const result: PricingItem[] = [];
  for (const groupItems of groups.values()) {
    const sorted = [...groupItems].sort((a, b) => String(a.variantSortKey ?? a.sku).localeCompare(String(b.variantSortKey ?? b.sku)));
    const decorated = decorateVariantFamily(sorted);
    if (decorated.length <= 1) {
      result.push(decorated[0]);
      continue;
    }

    const representative = decorated.find((item) => !item.warningCode && item.netPrice !== null)
      ?? decorated.find((item) => item.netPrice !== null)
      ?? decorated[0];
    result.push({
      ...representative,
      isVariantFamily: true,
      variantFamilyName: familyDisplayName(decorated, representative.variantFamilyName ?? representative.name),
      variantCount: decorated.length,
      variantProductIds: decorated.map((item) => item.warehouseProductId),
      variants: decorated,
      familyStats: decorated[0].familyStats,
    });
  }

  return result;
}

function decorateFlatVariantPricingItems(items: PricingItem[]) {
  const grouped = new Map<string, PricingItem[]>();
  for (const item of items) {
    const key = item.variantFamilyKey || `product:${item.warehouseProductId}`;
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }

  return items.map((item) => {
    const variants = grouped.get(item.variantFamilyKey || `product:${item.warehouseProductId}`) ?? [item];
    const decorated = decorateVariantFamily(variants);
    return decorated.find((variant) => variant.warehouseProductId === item.warehouseProductId) ?? item;
  });
}

function itemMatchesRuleOriginFilter(item: PricingItem, ruleOrigin?: PricingProductsQuery['ruleOrigin']) {
  if (!ruleOrigin || ruleOrigin === 'ALL') return true;
  if (ruleOrigin === 'FIXED_MANUAL') return item.priceMode === 'FIXED' && item.ruleOrigin === 'MANUAL';
  if (ruleOrigin === 'FIXED_COMPETITOR_AUTO') return item.priceMode === 'FIXED' && item.ruleOrigin === 'COMPETITOR_AUTO';
  if (ruleOrigin === 'FIXED_ANY') return item.priceMode === 'FIXED';
  return item.ruleOrigin === ruleOrigin;
}

function itemMatchesPricingFilters(
  item: PricingItem,
  source?: PricingPriceSource | 'ALL',
  status?: PricingProductsQuery['status'],
  ruleOrigin?: PricingProductsQuery['ruleOrigin'],
) {
  const sourceFilter = source && source !== 'ALL' ? source : null;
  const statusFilter = status && status !== 'ALL' ? status : null;
  if (sourceFilter && item.priceSource !== sourceFilter) return false;
  if (!itemMatchesRuleOriginFilter(item, ruleOrigin)) return false;
  if (!statusFilter) return true;
  if (statusFilter === 'READY') return item.netPrice !== null && !item.warningCode && !item.infoCode && !item.overridesGroup;
  if (statusFilter === 'MISSING_PRICE') return item.netPrice === null || item.warningCode === 'MISSING_COST';
  if (statusFilter === 'WARNING') return Boolean(item.warningCode);
  if (statusFilter === 'ALERT') return item.infoCode === 'ABNORMAL_PROFIT';
  if (statusFilter === 'NO_GROUP') return !item.priceGroupId;
  if (statusFilter === 'OVERRIDES_GROUP') return item.overridesGroup;
  if (statusFilter === 'BELOW_COST') return item.warningCode === 'BELOW_COST';
  return true;
}

async function filteredProductIdsForPricing(tenantId: string, filters: PricingProductsQuery) {
  if (!filters.shopId) throw new Error('Filtry cennika wymagają sklepu');
  const search = normalizeSearch(filters.search);
  const categoryIds = normalizeCategoryIdSet(filters);

  const [shop, state] = await Promise.all([
    prisma.shop.findFirst({
      where: { tenantId, status: 'ACTIVE', id: filters.shopId },
      select: {
        id: true,
        tenantId: true,
        name: true,
        platform: true,
        baseUrl: true,
        apiKey: true,
        configJson: true,
      },
    }),
    loadPricingState(tenantId),
  ]);
  if (!shop) throw new Error('Sklep nie istnieje albo nie jest aktywny');

  const categoryProductIds = categoryIds.size > 0
    ? await resolveCategoryWarehouseProductIds(tenantId, shop, filters, categoryIds)
    : null;
  const productWhere: Prisma.WarehouseProductWhereInput = {
    tenantId,
    isActive: true,
    ...(categoryProductIds ? { id: { in: Array.from(categoryProductIds) } } : {}),
    ...(search ? {
      OR: [
        { sku: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { barcodes: { some: { isActive: true, ean: { contains: search, mode: 'insensitive' } } } },
      ],
    } : {}),
    ...(filters.priceGroupId && filters.priceGroupId !== 'ALL'
      ? filters.priceGroupId === 'NONE'
        ? { priceGroupMembers: { none: { priceGroup: { isActive: true } } } }
        : { priceGroupMembers: { some: { priceGroupId: filters.priceGroupId } } }
      : {}),
  };

  const products = await prisma.warehouseProduct.findMany({
    where: productWhere,
    ...(categoryProductIds ? {} : { take: MAX_PRICING_LIST_PRODUCTS }),
    include: productPricingInclude,
    orderBy: { name: 'asc' },
  });
  const items = products.map((product) => calculatePrice(product, shop, state));
  return Array.from(new Set(
    items
      .filter((item) => itemMatchesPricingFilters(item, filters.source, filters.status, filters.ruleOrigin))
      .map((item) => item.warehouseProductId),
  ));
}

async function resolveScopedPricingInput(tenantId: string, input: PricingProductsInput = {}) {
  const scope = input.scope;
  if (!scope || scope === 'SELECTED') return input;
  if (scope === 'SHOP') {
    return {
      ...input,
      productIds: undefined,
      catalogId: undefined,
      priceGroupId: undefined,
    };
  }
  if (scope === 'GROUP') {
    if (!input.priceGroupId) throw new Error('Zakres grupy wymaga priceGroupId');
    return {
      ...input,
      productIds: undefined,
      catalogId: undefined,
    };
  }
  if (scope === 'CATEGORY' || scope === 'FILTERED') {
    const filters = input.filters ?? (input.shopIds?.[0]
      ? { shopId: input.shopIds[0], priceGroupId: input.priceGroupId, categoryId: input.catalogId } as PricingProductsQuery
      : null);
    if (!filters) throw new Error('Zakres filtrowany wymaga filtrów cennika');
    const productIds = await filteredProductIdsForPricing(tenantId, filters);
    return {
      ...input,
      productIds,
      shopIds: input.shopIds?.length ? input.shopIds : [filters.shopId],
      catalogId: undefined,
      priceGroupId: undefined,
    };
  }
  return input;
}

export async function getPricingProducts(query: PricingProductsQuery) {
  const tenantId = requireTenantId();
  if (!query.shopId) throw new Error('Wybierz sklep dla widoku cennika');
  const page = normalizePage(query.page, 1);
  const limit = normalizePage(query.limit, 50, 200);
  const search = normalizeSearch(query.search);
  const categoryIds = normalizeCategoryIdSet(query);
  const groupVariants = normalizeBoolean(query.groupVariants, false);

  const [shop, state] = await Promise.all([
    prisma.shop.findFirst({
      where: { tenantId, status: 'ACTIVE', id: query.shopId },
      select: {
        id: true,
        tenantId: true,
        name: true,
        platform: true,
        baseUrl: true,
        apiKey: true,
        configJson: true,
      },
    }),
    loadPricingState(tenantId),
  ]);
  if (!shop) throw new Error('Sklep nie istnieje albo nie jest aktywny');

  const categoryProductIds = categoryIds.size > 0
    ? await resolveCategoryWarehouseProductIds(tenantId, shop, query, categoryIds)
    : null;
  const productWhere: Prisma.WarehouseProductWhereInput = {
    tenantId,
    isActive: true,
    ...(categoryProductIds ? { id: { in: Array.from(categoryProductIds) } } : {}),
    ...(search ? {
      OR: [
        { sku: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { barcodes: { some: { isActive: true, ean: { contains: search, mode: 'insensitive' } } } },
      ],
    } : {}),
    ...(query.priceGroupId && query.priceGroupId !== 'ALL'
      ? query.priceGroupId === 'NONE'
        ? { priceGroupMembers: { none: { priceGroup: { isActive: true } } } }
        : { priceGroupMembers: { some: { priceGroupId: query.priceGroupId } } }
      : {}),
  };

  const products = await prisma.warehouseProduct.findMany({
    where: productWhere,
    ...(categoryProductIds ? {} : { take: MAX_PRICING_LIST_PRODUCTS }),
    include: {
      ...productPricingInclude,
      productChannelSnapshots: {
        where: { shopId: query.shopId },
        select: { shopId: true, payloadJson: true },
      },
    },
    orderBy: { name: 'asc' },
  });

  const baseItems = products.map((product) => calculatePrice(product, shop, state));
  const filtered = baseItems.filter((item) => itemMatchesPricingFilters(item, query.source, query.status, query.ruleOrigin));
  const presentationItems = groupVariants ? groupVariantPricingItems(filtered) : decorateFlatVariantPricingItems(filtered);
  const total = presentationItems.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const offset = (Math.min(page, totalPages) - 1) * limit;
  return {
    summary: buildPricingSummary(baseItems),
    variantSummary: {
      products: filtered.length,
      families: presentationItems.filter((item) => item.isVariantFamily || (item.variantCount ?? 1) > 1).length,
      collapsedProducts: presentationItems.reduce((sum, item) => sum + Math.max(0, (item.variantCount ?? 1) - 1), 0),
      grouped: groupVariants,
    },
    data: presentationItems.slice(offset, offset + limit),
    page: Math.min(page, totalPages),
    limit,
    total,
    totalPages,
  };
}

export async function listPriceGroups() {
  const tenantId = requireTenantId();
  return prisma.warehousePriceGroup.findMany({
    where: { tenantId },
    orderBy: [{ isActive: 'desc' }, { priority: 'desc' }, { name: 'asc' }],
    include: {
      _count: { select: { members: true } },
      rules: {
        where: { isActive: true, level: 'GROUP' },
        select: {
          id: true,
          shopId: true,
          marginPercent: true,
          minProfit: true,
          fixedNetPrice: true,
          priceMode: true,
          costCeilingEnabled: true,
          vatRate: true,
          roundingMode: true,
          syncMode: true,
        },
      },
    },
  });
}

export async function listPriceGroupMembers(id: string, query: PriceGroupMembersQuery = {}) {
  const tenantId = requireTenantId();
  const page = normalizePage(query.page, 1);
  const limit = normalizePage(query.limit, 25, 100);
  const search = normalizeSearch(query.search);
  const group = await prisma.warehousePriceGroup.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!group) throw new Error('Grupa cenowa nie znaleziona');

  const where: Prisma.WarehousePriceGroupMemberWhereInput = {
    tenantId,
    priceGroupId: id,
    ...(search ? {
      warehouseProduct: {
        OR: [
          { sku: { contains: search, mode: 'insensitive' } },
          { name: { contains: search, mode: 'insensitive' } },
          { barcodes: { some: { isActive: true, ean: { contains: search, mode: 'insensitive' } } } },
        ],
      },
    } : {}),
  };

  const [total, members, state, shop] = await Promise.all([
    prisma.warehousePriceGroupMember.count({ where }),
    prisma.warehousePriceGroupMember.findMany({
      where,
      include: {
        warehouseProduct: {
          include: productPricingInclude,
        },
      },
      orderBy: { warehouseProduct: { name: 'asc' } },
      skip: (page - 1) * limit,
      take: limit,
    }),
    query.shopId ? loadPricingState(tenantId) : Promise.resolve(null),
    query.shopId
      ? prisma.shop.findFirst({ where: { id: query.shopId, tenantId, status: 'ACTIVE' }, select: { id: true, name: true } })
      : Promise.resolve(null),
  ]);

  return {
    data: members.map((member) => ({
      id: member.id,
      priceGroupId: member.priceGroupId,
      warehouseProductId: member.warehouseProductId,
      createdAt: member.createdAt,
      product: {
        id: member.warehouseProduct.id,
        sku: member.warehouseProduct.sku,
        name: member.warehouseProduct.name,
        primaryEan: member.warehouseProduct.barcodes.find((barcode) => barcode.isPrimary)?.ean ?? member.warehouseProduct.barcodes[0]?.ean ?? null,
        catalogName: member.warehouseProduct.catalog?.name ?? null,
      },
      price: state && shop ? calculatePrice(member.warehouseProduct, shop, state) : null,
    })),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function createPriceGroup(input: PriceGroupInput) {
  const tenantId = requireTenantId();
  const name = input.name?.trim();
  if (!name) throw new Error('Nazwa grupy jest wymagana');
  return prisma.warehousePriceGroup.create({
    data: {
      tenantId,
      name,
      description: input.description?.trim() || null,
      priority: input.priority ?? 100,
      isActive: input.isActive ?? true,
    },
  });
}

export async function updatePriceGroup(id: string, input: Partial<PriceGroupInput>) {
  const tenantId = requireTenantId();
  const group = await prisma.warehousePriceGroup.findFirst({ where: { id, tenantId } });
  if (!group) throw new Error('Grupa cenowa nie znaleziona');
  return prisma.warehousePriceGroup.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
}

export async function addPriceGroupMembers(id: string, input: PriceGroupMembersInput) {
  const tenantId = requireTenantId();
  const group = await prisma.warehousePriceGroup.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!group) throw new Error('Grupa cenowa nie znaleziona');
  const productIds = Array.from(new Set((input.productIds ?? []).map((productId) => productId.trim()).filter(Boolean))).slice(0, MAX_PRICING_PRODUCTS);
  if (productIds.length === 0) throw new Error('Wybierz produkty do dodania do grupy');
  const products = await prisma.warehouseProduct.findMany({ where: { tenantId, id: { in: productIds } }, select: { id: true } });
  const validIds = new Set(products.map((product) => product.id));
  let added = 0;
  for (const productId of productIds.filter((productId) => validIds.has(productId))) {
    await prisma.warehousePriceGroupMember.upsert({
      where: { priceGroupId_warehouseProductId: { priceGroupId: id, warehouseProductId: productId } },
      create: { tenantId, priceGroupId: id, warehouseProductId: productId },
      update: {},
    });
    added += 1;
  }
  return { added, requested: productIds.length };
}

export async function removePriceGroupMember(id: string, productId: string) {
  const tenantId = requireTenantId();
  await prisma.warehousePriceGroupMember.deleteMany({
    where: { tenantId, priceGroupId: id, warehouseProductId: productId },
  });
  return { deleted: true };
}

function normalizeClearanceInput(input: ClearanceInput) {
  if (!['PRODUCT', 'GROUP'].includes(input.scope)) throw new Error('Nieprawidłowy zakres wyprzedaży');
  assertNonNegative(input.clearanceNetPrice, 'Cena wyprzedażowa');
  if (!input.clearanceNetPrice || input.clearanceNetPrice <= 0) throw new Error('Cena wyprzedażowa musi być większa od zera');
  if (input.scope === 'PRODUCT' && !input.warehouseProductId) throw new Error('Wyprzedaż produktu wymaga produktu');
  if (input.scope === 'GROUP' && !input.priceGroupId) throw new Error('Wyprzedaż grupy wymaga grupy cenowej');
  const validFrom = normalizeOptionalDate(input.validFrom, 'Data początku');
  const validTo = normalizeOptionalDate(input.validTo, 'Data końca');
  if (validFrom && validTo && validFrom > validTo) throw new Error('Data początku nie może być późniejsza niż data końca');

  return {
    scope: input.scope,
    warehouseProductId: input.scope === 'PRODUCT' ? input.warehouseProductId ?? null : null,
    priceGroupId: input.scope === 'GROUP' ? input.priceGroupId ?? null : null,
    shopId: input.shopId ?? null,
    clearanceNetPrice: input.clearanceNetPrice,
    reason: input.reason?.trim() || null,
    validFrom,
    validTo,
    isActive: input.isActive ?? true,
  };
}

async function assertClearanceTargets(tenantId: string, input: ReturnType<typeof normalizeClearanceInput>) {
  const checks = [];
  if (input.shopId) checks.push(prisma.shop.findFirst({ where: { id: input.shopId, tenantId }, select: { id: true } }));
  if (input.warehouseProductId) checks.push(prisma.warehouseProduct.findFirst({ where: { id: input.warehouseProductId, tenantId }, select: { id: true } }));
  if (input.priceGroupId) checks.push(prisma.warehousePriceGroup.findFirst({ where: { id: input.priceGroupId, tenantId }, select: { id: true } }));
  const result = await Promise.all(checks);
  if (result.some((item) => !item)) throw new Error('Cel wyprzedaży nie istnieje');
}

export async function listClearances(query: ClearanceQuery = {}) {
  const tenantId = requireTenantId();
  const page = normalizePage(query.page, 1);
  const limit = normalizePage(query.limit, 50, 100);
  const where: Prisma.WarehouseClearanceWhereInput = {
    tenantId,
    ...(query.scope ? { scope: query.scope } : {}),
    ...(query.warehouseProductId ? { warehouseProductId: query.warehouseProductId } : {}),
    ...(query.priceGroupId ? { priceGroupId: query.priceGroupId } : {}),
    ...(query.shopId ? { shopId: query.shopId } : {}),
    ...(query.isActive === undefined ? {} : { isActive: normalizeBoolean(query.isActive, true) }),
  };
  const [total, data] = await Promise.all([
    prisma.warehouseClearance.count({ where }),
    prisma.warehouseClearance.findMany({
      where,
      include: {
        shop: { select: { id: true, name: true } },
        priceGroup: { select: { id: true, name: true, priority: true } },
        warehouseProduct: { select: { id: true, sku: true, name: true } },
      },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return { data, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}

export async function createClearance(input: ClearanceInput) {
  const tenantId = requireTenantId();
  const data = normalizeClearanceInput(input);
  await assertClearanceTargets(tenantId, data);
  return prisma.warehouseClearance.create({
    data: { tenantId, ...data },
    include: {
      shop: { select: { id: true, name: true } },
      priceGroup: { select: { id: true, name: true, priority: true } },
      warehouseProduct: { select: { id: true, sku: true, name: true } },
    },
  });
}

export async function updateClearance(id: string, input: Partial<ClearanceInput>) {
  const tenantId = requireTenantId();
  const existing = await prisma.warehouseClearance.findFirst({ where: { id, tenantId } });
  if (!existing) throw new Error('Wyprzedaż nie znaleziona');
  const data = normalizeClearanceInput({
    scope: (input.scope ?? existing.scope) as ClearanceScope,
    warehouseProductId: input.warehouseProductId === undefined ? existing.warehouseProductId : input.warehouseProductId,
    priceGroupId: input.priceGroupId === undefined ? existing.priceGroupId : input.priceGroupId,
    shopId: input.shopId === undefined ? existing.shopId : input.shopId,
    clearanceNetPrice: input.clearanceNetPrice === undefined ? Number(existing.clearanceNetPrice) : input.clearanceNetPrice,
    reason: input.reason === undefined ? existing.reason : input.reason,
    validFrom: input.validFrom === undefined ? existing.validFrom : input.validFrom,
    validTo: input.validTo === undefined ? existing.validTo : input.validTo,
    isActive: input.isActive ?? existing.isActive,
  });
  await assertClearanceTargets(tenantId, data);
  return prisma.warehouseClearance.update({
    where: { id },
    data,
    include: {
      shop: { select: { id: true, name: true } },
      priceGroup: { select: { id: true, name: true, priority: true } },
      warehouseProduct: { select: { id: true, sku: true, name: true } },
    },
  });
}

export async function deactivateClearance(id: string) {
  const tenantId = requireTenantId();
  const existing = await prisma.warehouseClearance.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!existing) throw new Error('Wyprzedaż nie znaleziona');
  return prisma.warehouseClearance.update({ where: { id }, data: { isActive: false } });
}

export async function setPriceGroupPrice(id: string, input: PriceGroupPriceInput) {
  const tenantId = requireTenantId();
  const group = await prisma.warehousePriceGroup.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!group) throw new Error('Grupa cenowa nie znaleziona');
  const data = normalizeRuleInput({
    level: 'GROUP',
    priceGroupId: id,
    shopId: input.shopId ?? null,
    marginPercent: input.marginPercent,
    minProfit: input.minProfit,
    fixedNetPrice: input.fixedNetPrice,
    priceMode: input.priceMode,
    costCeilingEnabled: input.costCeilingEnabled,
    vatRate: input.vatRate,
    roundingMode: input.roundingMode,
    syncMode: input.syncMode,
    isActive: true,
  });
  await assertRuleTargets(tenantId, data);

  const existingRules = await prisma.warehousePricingRule.findMany({
    where: { tenantId, level: 'GROUP', priceGroupId: id, shopId: data.shopId, isActive: true },
    orderBy: { updatedAt: 'desc' },
  });
  const primary = existingRules[0];
  if (primary) {
    if (existingRules.length > 1) {
      await prisma.warehousePricingRule.updateMany({
        where: { tenantId, id: { in: existingRules.slice(1).map((rule) => rule.id) } },
        data: { isActive: false },
      });
    }
    return prisma.warehousePricingRule.update({ where: { id: primary.id }, data });
  }
  return prisma.warehousePricingRule.create({ data: { tenantId, ...data } });
}

export async function revertProductToGroup(productId: string, input: RevertProductToGroupInput) {
  const tenantId = requireTenantId();
  if (!input.shopId) throw new Error('Wybierz sklep dla cofnięcia nadpisania produktu');
  const product = await prisma.warehouseProduct.findFirst({ where: { id: productId, tenantId }, select: { id: true } });
  if (!product) throw new Error('Produkt nie znaleziony');
  await prisma.warehousePricingRule.updateMany({
    where: {
      tenantId,
      level: 'PRODUCT',
      warehouseProductId: productId,
      isActive: true,
      OR: [{ shopId: input.shopId }, { shopId: null }],
    },
    data: { isActive: false },
  });
  return recalculatePricing({ productIds: [productId], shopIds: [input.shopId] });
}

function buildPricingSummary(items: PricingItem[]) {
  return {
    total: items.length,
    ready: items.filter((item) => item.netPrice !== null).length,
    warnings: items.filter((item) => item.warningCode).length,
    missingCost: items.filter((item) => item.warningCode === 'MISSING_COST').length,
    belowCost: items.filter((item) => item.warningCode === 'BELOW_COST').length,
    belowMinProfit: items.filter((item) => item.warningCode === 'BELOW_MIN_PROFIT').length,
    abnormalProfit: items.filter((item) => item.infoCode === 'ABNORMAL_PROFIT').length,
    documentCost: items.filter((item) => item.costSource === 'DOCUMENT').length,
    wholesaleCost: items.filter((item) => item.costSource === 'WHOLESALE').length,
    inGroups: items.filter((item) => item.priceGroupId).length,
    withoutGroup: items.filter((item) => !item.priceGroupId).length,
    overridesGroup: items.filter((item) => item.overridesGroup).length,
    clearances: items.filter((item) => item.priceSource === 'CLEARANCE').length,
    missingPrice: items.filter((item) => item.netPrice === null).length,
  };
}

function buildPricingResponse(items: PricingItem[]) {
  return { summary: buildPricingSummary(items), items };
}

export const __pricingTest = {
  calculatePrice: (product: unknown, shop: unknown, state: unknown) =>
    calculatePrice(product as ProductForPricing, shop as ShopForPricing, state as PricingState),
};
