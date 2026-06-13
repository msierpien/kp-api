import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { syncProductPrice } from '../price/price-sync.service';
import type { PriceSyncTriggeredBy } from '../queue/price-sync.queue';

export type PricingRuleLevel = 'GLOBAL' | 'SHOP' | 'CATALOG' | 'PRODUCT';
export type PricingRoundingMode = 'END_99' | 'TENTH' | 'CENT';
export type PricingSyncMode = 'AUTO' | 'CONFIRM' | 'MANUAL';
export type PricingWarningCode = 'MISSING_COST' | 'BELOW_COST' | 'BELOW_MIN_PROFIT' | null;

export interface PricingRuleInput {
  level: PricingRuleLevel;
  shopId?: string | null;
  catalogId?: string | null;
  warehouseProductId?: string | null;
  marginPercent?: number | null;
  minProfit?: number | null;
  fixedNetPrice?: number | null;
  vatRate?: number | null;
  roundingMode?: PricingRoundingMode;
  syncMode?: PricingSyncMode;
  isActive?: boolean;
}

export interface PricingRulesQuery {
  level?: PricingRuleLevel;
  shopId?: string;
  catalogId?: string;
  warehouseProductId?: string;
  isActive?: boolean;
}

export interface PricingProductsInput {
  productIds?: string[];
  shopIds?: string[];
  catalogId?: string;
  triggeredBy?: PriceSyncTriggeredBy;
}

export interface BulkUpdatePricesInput extends PricingProductsInput {
  marginPercent?: number | null;
  minProfit?: number | null;
  fixedNetPrice?: number | null;
  vatRate?: number | null;
  roundingMode?: PricingRoundingMode;
  syncMode?: PricingSyncMode;
}

const DEFAULT_PRICING = {
  marginPercent: 30,
  minProfit: 1,
  vatRate: 23,
  roundingMode: 'END_99' as PricingRoundingMode,
  syncMode: 'CONFIRM' as PricingSyncMode,
};

const MAX_PRICING_PRODUCTS = 500;

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

function normalizeRuleInput(input: PricingRuleInput) {
  assertNonNegative(input.marginPercent, 'Marża');
  assertNonNegative(input.minProfit, 'Minimalny zysk');
  assertNonNegative(input.fixedNetPrice, 'Cena indywidualna');
  assertNonNegative(input.vatRate, 'VAT');

  if (!['GLOBAL', 'SHOP', 'CATALOG', 'PRODUCT'].includes(input.level)) {
    throw new Error('Nieprawidłowy poziom reguły cennika');
  }
  if (input.roundingMode && !['END_99', 'TENTH', 'CENT'].includes(input.roundingMode)) {
    throw new Error('Nieprawidłowy tryb zaokrąglania');
  }
  if (input.syncMode && !['AUTO', 'CONFIRM', 'MANUAL'].includes(input.syncMode)) {
    throw new Error('Nieprawidłowy tryb synchronizacji');
  }
  if (input.level === 'SHOP' && !input.shopId) throw new Error('Reguła sklepu wymaga sklepu');
  if (input.level === 'CATALOG' && !input.catalogId) throw new Error('Reguła katalogu wymaga katalogu');
  if (input.level === 'PRODUCT' && !input.warehouseProductId) throw new Error('Reguła produktu wymaga produktu');

  return {
    level: input.level,
    shopId: input.shopId ?? null,
    catalogId: input.catalogId ?? null,
    warehouseProductId: input.warehouseProductId ?? null,
    marginPercent: input.marginPercent ?? null,
    minProfit: input.minProfit ?? null,
    fixedNetPrice: input.fixedNetPrice ?? null,
    vatRate: input.vatRate ?? DEFAULT_PRICING.vatRate,
    roundingMode: input.roundingMode ?? DEFAULT_PRICING.roundingMode,
    syncMode: input.syncMode ?? DEFAULT_PRICING.syncMode,
    isActive: input.isActive ?? true,
  };
}

export async function getPricingRules(query: PricingRulesQuery = {}) {
  const tenantId = requireTenantId();
  const where: Prisma.WarehousePricingRuleWhereInput = { tenantId };
  if (query.level) where.level = query.level;
  if (query.shopId) where.shopId = query.shopId;
  if (query.catalogId) where.catalogId = query.catalogId;
  if (query.warehouseProductId) where.warehouseProductId = query.warehouseProductId;
  if (query.isActive !== undefined) where.isActive = query.isActive;

  return prisma.warehousePricingRule.findMany({
    where,
    orderBy: [{ level: 'asc' }, { updatedAt: 'desc' }],
    include: {
      shop: { select: { id: true, name: true } },
      catalog: { select: { id: true, name: true } },
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
    warehouseProductId: input.warehouseProductId === undefined ? existing.warehouseProductId : input.warehouseProductId,
    marginPercent: input.marginPercent === undefined ? numberOrNull(existing.marginPercent) : input.marginPercent,
    minProfit: input.minProfit === undefined ? numberOrNull(existing.minProfit) : input.minProfit,
    fixedNetPrice: input.fixedNetPrice === undefined ? numberOrNull(existing.fixedNetPrice) : input.fixedNetPrice,
    vatRate: input.vatRate === undefined ? Number(existing.vatRate) : input.vatRate,
    roundingMode: (input.roundingMode ?? existing.roundingMode) as PricingRoundingMode,
    syncMode: (input.syncMode ?? existing.syncMode) as PricingSyncMode,
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
  if (input.warehouseProductId) checks.push(prisma.warehouseProduct.findFirst({ where: { id: input.warehouseProductId, tenantId }, select: { id: true } }));
  const result = await Promise.all(checks);
  if (result.some((item) => !item)) throw new Error('Cel reguły cennika nie istnieje');
}

async function resolveProductsAndShops(tenantId: string, input: PricingProductsInput) {
  const productWhere: Prisma.WarehouseProductWhereInput = {
    tenantId,
    isActive: true,
    ...(input.productIds?.length ? { id: { in: input.productIds.slice(0, MAX_PRICING_PRODUCTS) } } : {}),
    ...(input.catalogId ? { catalogId: input.catalogId } : {}),
  };

  const shopWhere: Prisma.ShopWhereInput = {
    tenantId,
    status: 'ACTIVE',
    ...(input.shopIds?.length ? { id: { in: input.shopIds } } : {}),
  };

  const [products, shops] = await Promise.all([
    prisma.warehouseProduct.findMany({
      where: productWhere,
      take: MAX_PRICING_PRODUCTS,
      include: { shopProductMappings: { where: { isActive: true }, select: { shopId: true } } },
      orderBy: { name: 'asc' },
    }),
    prisma.shop.findMany({ where: shopWhere, select: { id: true, name: true } }),
  ]);

  return { products, shops };
}

type ProductForPricing = Awaited<ReturnType<typeof resolveProductsAndShops>>['products'][number];
type ShopForPricing = Awaited<ReturnType<typeof resolveProductsAndShops>>['shops'][number];
type RuleForPricing = Awaited<ReturnType<typeof loadPricingRules>>[number];

async function loadPricingRules(tenantId: string) {
  return prisma.warehousePricingRule.findMany({
    where: { tenantId, isActive: true },
    orderBy: { updatedAt: 'desc' },
  });
}

function rulePriority(rule: RuleForPricing, product: ProductForPricing, shopId: string) {
  if (rule.level === 'PRODUCT' && rule.warehouseProductId === product.id && rule.shopId === shopId) return 70;
  if (rule.level === 'PRODUCT' && rule.warehouseProductId === product.id && !rule.shopId) return 60;
  if (rule.level === 'CATALOG' && rule.catalogId === product.catalogId && rule.shopId === shopId) return 50;
  if (rule.level === 'CATALOG' && rule.catalogId === product.catalogId && !rule.shopId) return 40;
  if (rule.level === 'SHOP' && rule.shopId === shopId) return 30;
  if (rule.level === 'GLOBAL') return 10;
  return 0;
}

function resolveRule(product: ProductForPricing, shopId: string, rules: RuleForPricing[]) {
  return rules
    .map((rule) => ({ rule, priority: rulePriority(rule, product, shopId) }))
    .filter((item) => item.priority > 0)
    .sort((a, b) => b.priority - a.priority)[0]?.rule ?? null;
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

function calculatePrice(product: ProductForPricing, shop: ShopForPricing, rules: RuleForPricing[]) {
  const rule = resolveRule(product, shop.id, rules);
  const costBasis = decimal(product.averagePurchaseCost) ?? decimal(product.purchasePrice);
  const marginPercent = decimal(rule?.marginPercent) ?? new Prisma.Decimal(DEFAULT_PRICING.marginPercent);
  const minProfit = decimal(rule?.minProfit) ?? new Prisma.Decimal(DEFAULT_PRICING.minProfit);
  const vatRate = decimal(rule?.vatRate) ?? new Prisma.Decimal(DEFAULT_PRICING.vatRate);
  const roundingMode = (rule?.roundingMode ?? DEFAULT_PRICING.roundingMode) as PricingRoundingMode;
  const fixedNetPrice = decimal(rule?.fixedNetPrice);

  if (!costBasis && !fixedNetPrice) {
    return {
      shopId: shop.id,
      shopName: shop.name,
      warehouseProductId: product.id,
      sku: product.sku,
      name: product.name,
      pricingRuleId: rule?.id ?? null,
      pricingRuleLevel: rule?.level ?? null,
      costBasis: null,
      netPrice: null,
      grossPrice: null,
      marginPercent: Number(marginPercent),
      configuredMarginPercent: Number(marginPercent),
      realizedMarginPercent: null,
      profitAmount: null,
      warningCode: 'MISSING_COST' as PricingWarningCode,
      warningMessage: 'Brak kosztu bazowego produktu',
      syncMode: (rule?.syncMode ?? DEFAULT_PRICING.syncMode) as PricingSyncMode,
    };
  }

  const rawNetPrice = fixedNetPrice ?? costBasis!.plus(Prisma.Decimal.max(costBasis!.mul(marginPercent).div(100), minProfit));
  const netPrice = toMoney(roundPrice(rawNetPrice, roundingMode));
  const grossPrice = toMoney(netPrice.mul(new Prisma.Decimal(1).plus(vatRate.div(100))));
  const profitAmount = costBasis ? toMoney(netPrice.minus(costBasis)) : null;

  let warningCode: PricingWarningCode = null;
  let warningMessage: string | null = null;
  if (costBasis && netPrice.lessThan(costBasis)) {
    warningCode = 'BELOW_COST';
    warningMessage = 'Cena sprzedaży jest niższa od kosztu bazowego';
  } else if (profitAmount && profitAmount.lessThan(minProfit)) {
    warningCode = 'BELOW_MIN_PROFIT';
    warningMessage = 'Cena sprzedaży jest poniżej minimalnego zysku';
  }

  return {
    shopId: shop.id,
    shopName: shop.name,
    warehouseProductId: product.id,
    sku: product.sku,
    name: product.name,
    pricingRuleId: rule?.id ?? null,
    pricingRuleLevel: rule?.level ?? null,
    costBasis: numberOrNull(costBasis),
    netPrice: Number(netPrice),
    grossPrice: Number(grossPrice),
    marginPercent: costBasis && profitAmount ? Number(profitAmount.div(costBasis).mul(100).toFixed(3)) : Number(marginPercent),
    configuredMarginPercent: Number(marginPercent),
    realizedMarginPercent: costBasis && profitAmount ? Number(profitAmount.div(costBasis).mul(100).toFixed(3)) : null,
    profitAmount: numberOrNull(profitAmount),
    warningCode,
    warningMessage,
    syncMode: (rule?.syncMode ?? DEFAULT_PRICING.syncMode) as PricingSyncMode,
  };
}

export async function previewPricing(input: PricingProductsInput = {}) {
  const tenantId = requireTenantId();
  const [{ products, shops }, rules] = await Promise.all([
    resolveProductsAndShops(tenantId, input),
    loadPricingRules(tenantId),
  ]);
  const shopById = new Map(shops.map((shop) => [shop.id, shop]));
  const items = [];

  for (const product of products) {
    const mappedShopIds = new Set(product.shopProductMappings.map((mapping) => mapping.shopId));
    const targetShops = input.shopIds?.length
      ? input.shopIds.map((shopId) => shopById.get(shopId)).filter(Boolean) as ShopForPricing[]
      : shops.filter((shop) => mappedShopIds.has(shop.id));
    for (const shop of targetShops) items.push(calculatePrice(product, shop, rules));
  }

  return buildPricingResponse(items);
}

export async function recalculatePricing(input: PricingProductsInput = {}) {
  const tenantId = requireTenantId();
  const result = await previewPricing(input);

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
        costBasis: item.costBasis,
        netPrice: item.netPrice,
        grossPrice: item.grossPrice,
        marginPercent: item.marginPercent,
        profitAmount: item.profitAmount,
        warningCode: item.warningCode,
        warningMessage: item.warningMessage,
      },
      update: {
        pricingRuleId: item.pricingRuleId,
        costBasis: item.costBasis,
        netPrice: item.netPrice,
        grossPrice: item.grossPrice,
        marginPercent: item.marginPercent,
        profitAmount: item.profitAmount,
        warningCode: item.warningCode,
        warningMessage: item.warningMessage,
        calculatedAt: new Date(),
      },
    });
  }

  return result;
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
  const autoSyncItems = preview.items.filter((item) => item.syncMode === 'AUTO' && item.netPrice !== null);
  if (autoSyncItems.length > 0) await syncPricing({ productIds: input.productIds, shopIds: input.shopIds });

  return { createdRules: rules.length, ...preview };
}

export async function syncPricing(input: PricingProductsInput = {}) {
  const preview = await recalculatePricing(input);
  let enqueued = 0;
  const errors: Array<{ warehouseProductId: string; shopId: string; message: string }> = [];

  for (const item of preview.items) {
    if (item.netPrice === null) {
      errors.push({ warehouseProductId: item.warehouseProductId, shopId: item.shopId, message: item.warningMessage ?? 'Brak ceny do synchronizacji' });
      continue;
    }
    try {
      const result = await syncProductPrice(item.warehouseProductId, {
        shopId: item.shopId,
        price: item.netPrice,
        triggeredBy: input.triggeredBy ?? 'MANUAL',
      });
      enqueued += result.enqueued;
    } catch (error) {
      errors.push({
        warehouseProductId: item.warehouseProductId,
        shopId: item.shopId,
        message: error instanceof Error ? error.message : 'Błąd synchronizacji ceny',
      });
    }
  }

  return { ...preview, enqueued, errors };
}

function buildPricingResponse(items: ReturnType<typeof calculatePrice>[]) {
  const summary = {
    total: items.length,
    ready: items.filter((item) => item.netPrice !== null).length,
    warnings: items.filter((item) => item.warningCode).length,
    missingCost: items.filter((item) => item.warningCode === 'MISSING_COST').length,
    belowCost: items.filter((item) => item.warningCode === 'BELOW_COST').length,
    belowMinProfit: items.filter((item) => item.warningCode === 'BELOW_MIN_PROFIT').length,
  };
  return { summary, items };
}
