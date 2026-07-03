import { ObjectId, type Db } from 'mongodb';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { analyticsMongoConfigured, getAnalyticsMongoDb } from '../../lib/analytics-mongo';
import { getTenantContext, getTenantId } from '../../lib/tenant-context';
import { NotFoundError, ValidationError } from '../../lib/errors';
import * as productCardService from './product-card.service';
import * as pricingService from './warehouse-pricing.service';
import * as aiContentProposalService from './ai-content-proposals.service';

export type CompetitorIssue =
  | 'NO_MATCH'
  | 'MISSING_CATEGORY'
  | 'BAD_CATEGORY'
  | 'PRICE_OUTLIER'
  | 'MISSING_DESCRIPTION';

export type CategoryApplyMode = 'ADD' | 'REPLACE';

export interface ProductListQuery {
  shopId?: string;
  q?: string;
  issue?: CompetitorIssue | 'ALL';
  source?: string;
  categoryId?: string;
  shopPresence?: 'IN_SHOP' | 'MISSING_IN_SHOP' | 'ALL_WAREHOUSE';
  wholesaleAvailable?: boolean | string;
  page?: number | string;
  limit?: number | string;
}

export interface WholesaleMissingSystemQuery {
  shopId?: string;
  source?: string;
  categoryId?: string;
  availableOnly?: boolean | string;
  page?: number | string;
  limit?: number | string;
}

export interface MatchDiagnosticsQuery {
  shopId?: string;
  q?: string;
  source?: string;
  categoryId?: string;
  shopPresence?: 'IN_SHOP' | 'MISSING_IN_SHOP' | 'ALL_WAREHOUSE';
  limit?: number | string;
}

export interface CategoryMappingsQuery {
  shopId: string;
  source?: string;
}

export interface CategoryMappingInput {
  shopId: string;
  mappings: Array<{
    source: string;
    sourceCategoryId: string;
    sourceCategoryName?: string | null;
    sourceCategoryPath?: string | string[] | null;
    targetCategoryId: string;
    targetCategoryName?: string | null;
  }>;
}

export interface CategoryPreviewInput {
  shopId: string;
  productIds: string[];
  mode?: CategoryApplyMode;
  source?: string;
  sourceCategoryId?: string;
  targetCategoryId?: string;
  targetCategoryName?: string | null;
}

export interface PricePreviewInput {
  shopId: string;
  productIds: string[];
  items?: Array<{ warehouseProductId: string; grossPrice?: number | null }>;
}

export interface PriceApplyInput extends PricePreviewInput {
  sync?: boolean;
}

export interface PriceAuditQuery {
  shopId: string;
  source?: string;
  minMarkupPercent?: number | string;
  belowMarketTolerancePercent?: number | string;
  aboveMarketTolerancePercent?: number | string;
  itemLimit?: number | string;
}

export interface PriceAuditApplyInput extends PriceAuditQuery {
  sync?: boolean;
  recalculate?: boolean;
  maxApply?: number | string;
  origin?: pricingService.PricingRuleOrigin;
  skipManualFixedPrices?: boolean;
  triggeredBy?: import('../queue/price-sync.queue').PriceSyncTriggeredBy;
}

export interface DescriptionAiInput {
  shopId: string;
  productIds: string[];
  action?: aiContentProposalService.AiContentProposalInput['action'];
  templateId?: string | null;
  includeImages?: boolean;
}

const SOURCES = ['congee', 'kucmar', 'partybox'] as const;
const MAX_LIST_LIMIT = 200;
const MAX_BULK_PRODUCTS = 200;
const ISSUE_SCAN_CHUNK_SIZE = 50;
const ISSUE_SCAN_MIN_LIMIT = 500;
const ISSUE_SCAN_MAX_LIMIT = 1000;
const PRICE_OUTLIER_PERCENT = 10;
const PRICE_REVIEW_DIFF_PERCENT = 40;
const MIN_PRICE_SAMPLE_OFFERS = 3;
const MATCH_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_MATCH_CACHE_ENTRIES = 30;
const PARTYBOX_WARNING =
  'Partybox jest niekompletny: ceny i opisy sa dostepne, ale kategorie Partybox nie powinny byc traktowane jako pelne drzewo.';

type PricePreviewStatus = 'READY' | 'BELOW_COST' | 'NO_COMPETITOR_PRICE' | 'LOW_SAMPLE' | 'LARGE_CHANGE';

const PRICE_AUDIT_DEFAULT_ITEM_LIMIT = 1000;
const PRICE_AUDIT_MAX_ITEM_LIMIT = 10000;
const activeCompetitorPriceAutomationRuns = new Set<string>();

const matchedSourceProductCache = new Map<string, {
  expiresAt: number;
  value: Map<string, Set<string>>;
}>();

const productInclude = {
  barcodes: { where: { isActive: true }, orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] },
  shopProductMappings: { where: { isActive: true }, include: { shop: true } },
  shopPrices: true,
  productChannelSnapshots: true,
  wholesaleMappings: {
    where: { isActive: true, provider: { isActive: true } },
    include: { provider: { select: { id: true, name: true, configJson: true } } },
    orderBy: [{ lastSyncAt: 'desc' as const }, { updatedAt: 'desc' as const }],
    take: 10,
  },
} satisfies Prisma.WarehouseProductInclude;

type ProductForAnalytics = Prisma.WarehouseProductGetPayload<{ include: typeof productInclude }>;

type MatchConfidence = 'EAN' | 'SKU' | 'NAME' | 'NONE';

interface CompetitorCategory {
  id: string;
  path: string[];
  url: string | null;
  price: number | null;
  currency: string | null;
  availability: string | null;
  pageUrl: string | null;
  categoryUrl: string | null;
  updatedAt: string | null;
  lastSeenAt: string | null;
}

interface CompetitorPriceHistoryItem {
  oldPrice: number | null;
  newPrice: number | null;
  currency: string;
  changedAt: string | null;
  sourceCategoryId: string | null;
  categoryUrl: string | null;
  pageUrl: string | null;
}

interface CategoryTreeRow {
  source_category_id?: unknown;
  parent_source_category_id?: unknown;
  name?: unknown;
  path?: unknown;
  depth?: unknown;
  product_list_url?: unknown;
  navigation_url?: unknown;
  canonical_url?: unknown;
}

interface CategoryTreeNode {
  id: string;
  parentId: string | null;
  name: string;
  path: string[];
  depth: number;
  productCount: number;
  matchedProductCount: number;
  url: string | null;
}

interface CompetitorBundleItem {
  id: string;
  sku: string | null;
  ean: string | null;
  title: string | null;
  quantity: number | null;
  price: number | null;
  url: string | null;
  raw: Record<string, unknown>;
}

interface CompetitorOffer {
  id: string;
  source: string;
  sourceProductId: string;
  sku: string | null;
  ean: string | null;
  title: string | null;
  price: number | null;
  currency: string;
  priceHistory: CompetitorPriceHistoryItem[];
  lastPriceChangedAt: string | null;
  lastSeenAt: string | null;
  updatedAt: string | null;
  availability: string | null;
  url: string | null;
  description: string | null;
  shortDescription: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  brand: string | null;
  imageUrls: string[];
  parameters: Record<string, unknown> | null;
  categories: CompetitorCategory[];
  bundleItems: CompetitorBundleItem[];
}

interface ProductIdentifierInput {
  id?: string;
  sku: string | null;
  barcodes: Array<{ ean: string | null }>;
  shopProductMappings: Array<{ externalEan: string | null; externalSku: string | null }>;
}

interface EnrichedProduct {
  warehouseProductId: string;
  sku: string;
  name: string;
  imageUrl: string | null;
  currentGrossPrice: number | null;
  costNet: number | null;
  currentCategories: Array<{ id: string; name: string; isDefault?: boolean }>;
  hasDescription: boolean;
  match: {
    confidence: MatchConfidence;
    matchedBy: string | null;
    productId: string | null;
  };
  priceStats: {
    minGross: number | null;
    medianGross: number | null;
    maxGross: number | null;
    sourceCount: number;
    offerCount: number;
    diffPercentVsCurrent: number | null;
    suggestedGross: number | null;
    suggestedNet: number | null;
    blockedBelowCost: boolean;
  };
  issues: CompetitorIssue[];
  offers: CompetitorOffer[];
  categorySuggestions: Array<{
    source: string;
    sourceCategoryId: string;
    sourceCategoryPath: string[];
    targetCategoryId: string;
    targetCategoryName: string | null;
  }>;
  inShop: boolean;
  wholesaleOffer: {
    mappingId: string;
    providerId: string;
    providerName: string;
    externalSku: string;
    externalEan: string | null;
    externalName: string | null;
    lastKnownPrice: number | null;
    lastKnownStock: number | null;
    imageUrl: string | null;
    available: boolean;
  } | null;
}

interface CompetitorMatchResult {
  confidence: MatchConfidence;
  matchedBy: string | null;
  productId: string | null;
  offers: CompetitorOffer[];
}

function requireTenantId() {
  const tenantId = getTenantId() || getTenantContext()?.tenantId;
  if (!tenantId) throw new ValidationError('Brak kontekstu tenanta');
  return tenantId;
}

function normalizeText(value: unknown) {
  return String(value ?? '').trim();
}

function normalizedIdentifier(value: unknown) {
  const text = normalizeText(value);
  return text ? text : null;
}

function unique(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => normalizeText(value)).filter(Boolean)));
}

function pageValue(value: number | string | undefined, fallback: number, max = Number.POSITIVE_INFINITY) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function booleanQuery(value: boolean | string | undefined) {
  return value === true || value === 'true' || value === '1';
}

function shopPresenceValue(value: ProductListQuery['shopPresence'] | MatchDiagnosticsQuery['shopPresence']) {
  return value === 'MISSING_IN_SHOP' || value === 'ALL_WAREHOUSE' ? value : 'IN_SHOP';
}

function decimalToNumber(value: Prisma.Decimal | number | string | null | undefined | unknown) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDateString(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = normalizeText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function round2(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function grossToNetCeil(gross: number | null | undefined, vatRate: number) {
  if (gross === null || gross === undefined || !Number.isFinite(gross)) return null;
  const multiplier = 1 + vatRate / 100;
  return Math.ceil((gross / multiplier) * 100 - 1e-9) / 100;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function exactRegex(value: string) {
  return new RegExp(`^${escapeRegex(value)}$`, 'i');
}

function containsRegex(value: string) {
  return new RegExp(escapeRegex(value), 'i');
}

function selectedSources(source?: string) {
  if (!source || source === 'ALL') return [...SOURCES];
  return SOURCES.includes(source as any) ? [source] : [];
}

function warningsForSources(sources: string[], context?: 'categories' | 'prices') {
  const warnings = [];
  if (sources.includes('partybox')) {
    warnings.push(PARTYBOX_WARNING);
    if (context === 'categories') warnings.push('Mapowania kategorii Partybox wymagaja recznego potwierdzenia.');
  }
  return warnings;
}

function categoryPath(row: CategoryTreeRow) {
  const path = Array.isArray(row.path)
    ? row.path.map((part) => normalizeText(part)).filter(Boolean)
    : [];
  if (path.length > 0) return path;
  const name = normalizeText(row.name);
  return name ? [name] : [];
}

function categoryPathKey(path: string[]) {
  return path.map((part) => part.trim().toLocaleLowerCase('pl')).join(' > ');
}

function categoryName(row: CategoryTreeRow, path: string[]) {
  return normalizeText(row.name) || path[path.length - 1] || String(row.source_category_id);
}

function categoryUrl(row: CategoryTreeRow) {
  return normalizedIdentifier(row.product_list_url)
    ?? normalizedIdentifier(row.navigation_url)
    ?? normalizedIdentifier(row.canonical_url);
}

function sortCategoryNodes(a: CategoryTreeNode, b: CategoryTreeNode) {
  const pathCompare = categoryPathKey(a.path).localeCompare(categoryPathKey(b.path), 'pl');
  if (pathCompare !== 0) return pathCompare;
  return a.id.localeCompare(b.id, 'pl');
}

function normalizeCategoryTree(
  rows: CategoryTreeRow[],
  countMap: Map<string, number>,
  matchedCountMap = new Map<string, number>(),
) {
  const byId = new Map<string, { row: CategoryTreeRow; path: string[] }>();
  const byPath = new Map<string, { id: string; row: CategoryTreeRow; path: string[] }>();
  const diagnostics = {
    normalizedDepth: 0,
    inferredParent: 0,
    ignoredInvalidParent: 0,
  };

  for (const row of rows) {
    const id = normalizedIdentifier(row.source_category_id);
    if (!id) continue;
    const path = categoryPath(row);
    byId.set(id, { row, path });
    if (path.length > 0) byPath.set(categoryPathKey(path), { id, row, path });
  }

  const nodes: CategoryTreeNode[] = [];
  for (const [id, entry] of byId.entries()) {
    const { row, path } = entry;
    const rawParentId = normalizedIdentifier(row.parent_source_category_id);
    const pathParent = path.length > 1 ? byPath.get(categoryPathKey(path.slice(0, -1))) : undefined;
    const rawParentExists = rawParentId ? byId.has(rawParentId) : false;
    let parentId: string | null = null;

    if (pathParent && pathParent.id !== id) {
      parentId = pathParent.id;
      if (rawParentId !== parentId) diagnostics.inferredParent += 1;
    } else if (rawParentId && rawParentExists && rawParentId !== id) {
      parentId = rawParentId;
    } else if (rawParentId && !rawParentExists) {
      diagnostics.ignoredInvalidParent += 1;
    }

    const depth = Math.max(0, path.length - 1);
    if (Number(row.depth ?? depth) !== depth) diagnostics.normalizedDepth += 1;

    nodes.push({
      id,
      parentId,
      name: categoryName(row, path),
      path,
      depth,
      productCount: countMap.get(id) ?? 0,
      matchedProductCount: matchedCountMap.get(id) ?? 0,
      url: categoryUrl(row),
    });
  }

  const sorted = sortCategoryTreeDepthFirst(nodes);
  return { nodes: sorted, diagnostics };
}

function sortCategoryTreeDepthFirst(nodes: CategoryTreeNode[]) {
  const byParent = new Map<string, CategoryTreeNode[]>();
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    const parentId = node.parentId && byId.has(node.parentId) ? node.parentId : 'ROOT';
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(node);
    byParent.set(parentId, siblings);
  }

  for (const siblings of byParent.values()) siblings.sort(sortCategoryNodes);

  const result: CategoryTreeNode[] = [];
  const visited = new Set<string>();
  const visit = (node: CategoryTreeNode) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    result.push(node);
    for (const child of byParent.get(node.id) ?? []) visit(child);
  };

  for (const root of byParent.get('ROOT') ?? []) visit(root);
  for (const node of nodes.sort(sortCategoryNodes)) visit(node);
  return result;
}

async function ensureMongo() {
  if (!analyticsMongoConfigured()) {
    throw new ValidationError('Brak konfiguracji ANALYTICS_MONGO_URI dla analityki konkurencji');
  }
  return getAnalyticsMongoDb();
}

async function requireShop(tenantId: string, shopId: string) {
  const shop = await prisma.shop.findFirst({ where: { id: shopId, tenantId } });
  if (!shop) throw new NotFoundError('Sklep nie istnieje w tym tenancie');
  return shop;
}

function productIdentifiers(product: ProductIdentifierInput) {
  const eans = unique([
    ...product.barcodes.map((barcode) => barcode.ean),
    ...product.shopProductMappings.map((mapping) => mapping.externalEan),
  ]);
  const skus = unique([
    product.sku,
    ...product.shopProductMappings.map((mapping) => mapping.externalSku),
  ]);

  return { eans, skus };
}

function identifierKey(value: unknown) {
  return normalizedIdentifier(value)?.toLocaleLowerCase('pl') ?? null;
}

function addIdentifierTarget(map: Map<string, Set<string>>, identifier: unknown, productId: string) {
  const key = identifierKey(identifier);
  if (!key) return;
  const ids = map.get(key) ?? new Set<string>();
  ids.add(productId);
  map.set(key, ids);
}

function valueVariants(value: string) {
  const variants: unknown[] = [value];
  const numeric = Number(value);
  if (Number.isFinite(numeric)) variants.push(numeric);
  return variants;
}

function getMatchedSourceProductCache(key: string) {
  const cached = matchedSourceProductCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    matchedSourceProductCache.delete(key);
    return null;
  }
  return cached.value;
}

function setMatchedSourceProductCache(key: string, value: Map<string, Set<string>>) {
  if (matchedSourceProductCache.size >= MAX_MATCH_CACHE_ENTRIES) {
    const oldest = matchedSourceProductCache.keys().next().value;
    if (oldest) matchedSourceProductCache.delete(oldest);
  }
  matchedSourceProductCache.set(key, { expiresAt: Date.now() + MATCH_CACHE_TTL_MS, value });
}

async function matchedWarehouseProductIdsBySourceProduct(
  db: Db,
  tenantId: string,
  shopId: string,
  source: string,
  sourceProductIds?: string[],
  restrictToShop = true,
) {
  const cacheKey = sourceProductIds?.length ? null : `${tenantId}:${shopId}:${source}:${restrictToShop ? 'shop' : 'warehouse'}`;
  if (cacheKey) {
    const cached = getMatchedSourceProductCache(cacheKey);
    if (cached) return cached;
  }

  const warehouseProducts = await prisma.warehouseProduct.findMany({
    where: productWhere(tenantId, { shopId: restrictToShop ? shopId : undefined }),
    select: {
      id: true,
      sku: true,
      barcodes: {
        where: { isActive: true },
        select: { ean: true },
      },
      shopProductMappings: {
        where: { ...(restrictToShop ? { shopId } : {}), isActive: true },
        select: { externalEan: true, externalSku: true },
      },
    },
  });

  const productIdsByEan = new Map<string, Set<string>>();
  const productIdsBySku = new Map<string, Set<string>>();
  for (const product of warehouseProducts) {
    const identifiers = productIdentifiers(product);
    for (const ean of identifiers.eans) addIdentifierTarget(productIdsByEan, ean, product.id);
    for (const sku of identifiers.skus) addIdentifierTarget(productIdsBySku, sku, product.id);
  }

  if (productIdsByEan.size === 0 && productIdsBySku.size === 0) return new Map<string, Set<string>>();

  const sourceProductFilter = sourceProductIds?.length
    ? { source_product_id: { $in: sourceProductIds.flatMap(valueVariants) } }
    : {};
  const storeProducts = await db.collection('store_products')
    .find({ source, ...sourceProductFilter })
    .project({ source_product_id: 1, store_ean: 1, store_sku: 1, product_id: 1 })
    .toArray();
  const baseProductIds = Array.from(new Set(
    storeProducts
      .map((row) => row.product_id)
      .filter((value): value is ObjectId => value instanceof ObjectId)
      .map((value) => String(value))
  )).map((value) => new ObjectId(value));
  const baseProducts = baseProductIds.length
    ? await db.collection('products')
      .find({ _id: { $in: baseProductIds } })
      .project({ ean: 1, sku: 1, product_number: 1 })
      .toArray()
    : [];
  const baseProductById = new Map(baseProducts.map((row) => [String(row._id), row]));
  const matchedProductIdsBySourceProduct = new Map<string, Set<string>>();

  for (const row of storeProducts) {
    const sourceProductId = normalizedIdentifier(row.source_product_id);
    if (!sourceProductId) continue;
    const baseProduct = row.product_id instanceof ObjectId ? baseProductById.get(String(row.product_id)) : null;
    const matchedProductIds = new Set<string>();

    for (const value of [row.store_ean, baseProduct?.ean]) {
      const key = identifierKey(value);
      if (!key) continue;
      for (const productId of productIdsByEan.get(key) ?? []) matchedProductIds.add(productId);
    }
    for (const value of [row.store_sku, baseProduct?.sku, baseProduct?.product_number]) {
      const key = identifierKey(value);
      if (!key) continue;
      for (const productId of productIdsBySku.get(key) ?? []) matchedProductIds.add(productId);
    }
    if (matchedProductIds.size === 0) continue;

    const existing = matchedProductIdsBySourceProduct.get(sourceProductId) ?? new Set<string>();
    for (const productId of matchedProductIds) existing.add(productId);
    matchedProductIdsBySourceProduct.set(sourceProductId, existing);
  }

  if (cacheKey) setMatchedSourceProductCache(cacheKey, matchedProductIdsBySourceProduct);
  return matchedProductIdsBySourceProduct;
}

async function categoryMatchedProductCounts(db: Db, tenantId: string, shopId: string, source: string) {
  const matchedProductIdsBySourceProduct = await matchedWarehouseProductIdsBySourceProduct(db, tenantId, shopId, source);
  if (matchedProductIdsBySourceProduct.size === 0) return new Map<string, number>();

  const categoryRows = await db.collection('regular_product_categories')
    .find({ source })
    .project({ category_id: 1, source_product_id: 1 })
    .toArray();

  const productIdsByCategory = new Map<string, Set<string>>();
  for (const row of categoryRows) {
    const categoryId = normalizedIdentifier(row.category_id);
    if (!categoryId) continue;
    const sourceProductId = normalizedIdentifier(row.source_product_id);
    const matchedProductIds = sourceProductId ? matchedProductIdsBySourceProduct.get(sourceProductId) : null;
    if (!matchedProductIds?.size) continue;

    const categoryProductIds = productIdsByCategory.get(categoryId) ?? new Set<string>();
    for (const productId of matchedProductIds) categoryProductIds.add(productId);
    productIdsByCategory.set(categoryId, categoryProductIds);
  }

  return new Map(Array.from(productIdsByCategory.entries()).map(([categoryId, productIds]) => [categoryId, productIds.size]));
}

async function categoryMatchedWarehouseProductIds(
  db: Db,
  tenantId: string,
  shopId: string,
  source: string,
  categoryId: string,
  restrictToShop = true,
) {
  const numericCategoryId = Number(categoryId);
  const categoryIdFilter = Number.isFinite(numericCategoryId)
    ? { $in: [categoryId, numericCategoryId] }
    : categoryId;

  const categoryRows = await db.collection('regular_product_categories')
    .find({ source, category_id: categoryIdFilter })
    .project({ source_product_id: 1 })
    .toArray();
  const sourceProductIds = unique(categoryRows.map((row) => normalizedIdentifier(row.source_product_id)));
  if (sourceProductIds.length === 0) return [];
  const matchedProductIdsBySourceProduct = await matchedWarehouseProductIdsBySourceProduct(
    db,
    tenantId,
    shopId,
    source,
    sourceProductIds,
    restrictToShop,
  );
  if (matchedProductIdsBySourceProduct.size === 0) return [];

  const productIds = new Set<string>();
  for (const sourceProductId of sourceProductIds) {
    const matchedProductIds = matchedProductIdsBySourceProduct.get(sourceProductId);
    if (!matchedProductIds?.size) continue;
    for (const productId of matchedProductIds) productIds.add(productId);
  }

  return Array.from(productIds);
}

function currentSnapshot(product: ProductForAnalytics, shopId?: string) {
  if (shopId) {
    return product.productChannelSnapshots.find((snapshot) => snapshot.shopId === shopId) ?? null;
  }
  return product.productChannelSnapshots[0] ?? null;
}

function isProductMappedToShop(product: ProductForAnalytics, shopId?: string) {
  return Boolean(shopId && product.shopProductMappings.some((mapping) => mapping.shopId === shopId && mapping.isActive));
}

function currentCategories(product: ProductForAnalytics, shopId?: string) {
  const payload = currentSnapshot(product, shopId)?.payloadJson as any;
  const categories = Array.isArray(payload?.categories) ? payload.categories : [];
  return categories
    .map((category: any) => ({
      id: String(category.id ?? ''),
      name: String(category.name ?? category.id ?? ''),
      isDefault: Boolean(category.isDefault),
    }))
    .filter((category: { id: string }) => category.id);
}

function currentImageUrl(product: ProductForAnalytics, shopId?: string) {
  const payload = currentSnapshot(product, shopId)?.payloadJson as any;
  const images = Array.isArray(payload?.media?.images) ? payload.media.images : [];
  const cover = images.find((image: any) => image?.cover && normalizedIdentifier(image.url));
  const first = cover ?? images.find((image: any) => normalizedIdentifier(image?.url));
  return normalizedIdentifier(first?.url);
}

function payloadString(payload: unknown, keys: Array<string | undefined>) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  for (const key of keys.filter(Boolean)) {
    const value = record[key as string];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function wholesaleImageUrl(mapping: { provider: { configJson: Prisma.JsonValue | null }; payloadJson: Prisma.JsonValue | null }) {
  const config = (mapping.provider.configJson || {}) as { fieldMapping?: { image?: string } };
  const value = payloadString(mapping.payloadJson, [
    config.fieldMapping?.image,
    'photos',
    'photo',
    'image',
    'images',
    'Zdjęcie',
    'Zdjecie',
  ]);
  if (!value) return null;
  return value
    .split(/[,\n;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((url) => (url.startsWith('//') ? `https:${url}` : url))
    .find((url) => /^https?:\/\//i.test(url)) ?? null;
}

function bestWholesaleOffer(product: ProductForAnalytics): EnrichedProduct['wholesaleOffer'] {
  const mappings = [...product.wholesaleMappings].sort((a, b) => {
    const stockA = decimalToNumber(a.lastKnownStock) ?? 0;
    const stockB = decimalToNumber(b.lastKnownStock) ?? 0;
    if ((stockB > 0) !== (stockA > 0)) return stockB > 0 ? 1 : -1;
    const priceA = decimalToNumber(a.lastKnownPrice) ?? Number.POSITIVE_INFINITY;
    const priceB = decimalToNumber(b.lastKnownPrice) ?? Number.POSITIVE_INFINITY;
    if (priceA !== priceB) return priceA - priceB;
    return (b.lastSyncAt?.getTime() ?? 0) - (a.lastSyncAt?.getTime() ?? 0);
  });
  const mapping = mappings.find((item) => decimalToNumber(item.lastKnownStock) !== null || wholesaleImageUrl(item)) ?? mappings[0] ?? null;
  if (!mapping) return null;
  const lastKnownStock = decimalToNumber(mapping.lastKnownStock);

  return {
    mappingId: mapping.id,
    providerId: mapping.providerId,
    providerName: mapping.provider.name,
    externalSku: mapping.externalSku,
    externalEan: mapping.externalEan,
    externalName: mapping.externalName,
    lastKnownPrice: decimalToNumber(mapping.lastKnownPrice),
    lastKnownStock,
    imageUrl: wholesaleImageUrl(mapping),
    available: Boolean(lastKnownStock !== null && lastKnownStock > 0),
  };
}

function hasCurrentDescription(product: ProductForAnalytics, shopId?: string) {
  const payload = currentSnapshot(product, shopId)?.payloadJson as any;
  const content = payload?.content ?? {};
  return Boolean(normalizeText(content.longDescriptionHtml) || normalizeText(content.shortDescriptionHtml) || normalizeText(product.description));
}

function currentGrossPrice(product: ProductForAnalytics, shopId?: string) {
  const shopPrice = shopId ? product.shopPrices.find((price) => price.shopId === shopId) : product.shopPrices[0];
  return decimalToNumber(shopPrice?.grossPrice) ?? decimalToNumber(product.retailPrice);
}

function costNet(product: ProductForAnalytics) {
  return decimalToNumber(product.averagePurchaseCost)
    ?? decimalToNumber(product.purchasePrice)
    ?? decimalToNumber(product.wholesaleMappings[0]?.lastKnownPrice);
}

function priceDiffPercent(currentGross: number | null, suggestedGross: number | null) {
  return currentGross && suggestedGross
    ? round2(((currentGross - suggestedGross) / suggestedGross) * 100)
    : null;
}

function differsByAtLeastOneCent(left: number | null, right: number | null) {
  if (left === null || right === null) return true;
  return Math.round(Math.abs(left - right) * 100) >= 1;
}

function priceStats(offers: CompetitorOffer[], currentGross: number | null, cost: number | null, vatRate = 23) {
  const prices = offers
    .map((offer) => offer.price)
    .filter((price): price is number => typeof price === 'number' && Number.isFinite(price) && price > 0)
    .sort((a, b) => a - b);

  const minGross = prices.length ? prices[0] : null;
  const maxGross = prices.length ? prices[prices.length - 1] : null;
  const medianGross = prices.length
    ? prices.length % 2
      ? prices[Math.floor(prices.length / 2)]
      : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
    : null;
  const suggestedGross = round2(medianGross);
  const suggestedNet = grossToNetCeil(suggestedGross, vatRate);
  const diffPercentVsCurrent = priceDiffPercent(currentGross, suggestedGross);

  return {
    minGross: round2(minGross),
    medianGross: round2(medianGross),
    maxGross: round2(maxGross),
    sourceCount: new Set(offers.map((offer) => offer.source)).size,
    offerCount: offers.length,
    diffPercentVsCurrent,
    suggestedGross,
    suggestedNet,
    blockedBelowCost: Boolean(cost !== null && suggestedNet !== null && suggestedNet < cost),
  };
}

function numberOrNull(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstIdentifier(row: any, fields: string[]) {
  for (const field of fields) {
    const value = normalizedIdentifier(row[field]);
    if (value) return value;
  }
  return null;
}

function normalizeBundleItem(row: any): CompetitorBundleItem {
  const raw = { ...row };
  delete raw._id;

  return {
    id: String(row._id),
    sku: firstIdentifier(row, ['item_sku', 'sku', 'store_sku', 'product_sku']),
    ean: firstIdentifier(row, ['item_ean', 'ean', 'store_ean', 'product_ean']),
    title: firstIdentifier(row, ['item_title', 'title', 'name', 'product_name', 'item_name']),
    quantity: numberOrNull(row.quantity ?? row.qty ?? row.count),
    price: decimalToNumber(row.price ?? row.unit_price ?? row.item_price),
    url: firstIdentifier(row, ['product_url', 'url', 'item_url']),
    raw,
  };
}

function normalizePriceHistory(value: unknown): CompetitorPriceHistoryItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 3).map((item) => ({
    oldPrice: decimalToNumber(item?.old_price),
    newPrice: decimalToNumber(item?.new_price),
    currency: normalizeText(item?.currency) || 'PLN',
    changedAt: normalizeDateString(item?.changed_at),
    sourceCategoryId: normalizedIdentifier(item?.source_category_id),
    categoryUrl: normalizedIdentifier(item?.category_url),
    pageUrl: normalizedIdentifier(item?.page_url),
  }));
}

function normalizeOfferPrice(row: any) {
  return decimalToNumber(row.price ?? row.current_price ?? row.gross_price ?? row.listing_price);
}

function storeProductImageUrl(row: any) {
  const imageUrls: unknown[] = Array.isArray(row.image_urls) ? row.image_urls : [];
  const fromList = imageUrls
    .map((value) => normalizedIdentifier(value))
    .find((value): value is string => Boolean(value));
  return fromList
    ?? normalizedIdentifier(row.image_url)
    ?? normalizedIdentifier(row.image)
    ?? null;
}

function storeProductIdentifiers(row: any, baseProduct?: any) {
  return {
    eans: unique([
      row?.store_ean,
      row?.ean,
      baseProduct?.ean,
    ]),
    skus: unique([
      row?.store_sku,
      row?.sku,
      baseProduct?.sku,
      baseProduct?.product_number,
    ]),
  };
}

function storeProductTitle(row: any, baseProduct?: any) {
  return normalizedIdentifier(row?.title)
    ?? normalizedIdentifier(row?.name)
    ?? normalizedIdentifier(baseProduct?.title)
    ?? normalizedIdentifier(baseProduct?.name)
    ?? null;
}

function storeProductUrl(row: any) {
  return normalizedIdentifier(row?.product_url)
    ?? normalizedIdentifier(row?.url)
    ?? normalizedIdentifier(row?.page_url)
    ?? null;
}

function storeProductScore(row: any, baseProduct?: any) {
  const identifiers = storeProductIdentifiers(row, baseProduct);
  return identifiers.eans.length * 3
    + identifiers.skus.length * 2
    + (storeProductTitle(row, baseProduct) ? 1 : 0)
    + (storeProductImageUrl(row) ? 1 : 0);
}

function normalizeOffer(
  row: any,
  categories: CompetitorCategory[] = [],
  bundleItems: CompetitorBundleItem[] = [],
): CompetitorOffer {
  const categoryPrice = categories.find((category) => category.price !== null)?.price ?? null;
  const categoryCurrency = categories.find((category) => category.currency)?.currency ?? null;
  const categoryAvailability = categories.find((category) => category.availability)?.availability ?? null;
  const categoryPageUrl = categories.find((category) => category.pageUrl)?.pageUrl ?? null;
  const rowPrice = normalizeOfferPrice(row);

  return {
    id: String(row._id),
    source: String(row.source ?? ''),
    sourceProductId: String(row.source_product_id ?? ''),
    sku: normalizedIdentifier(row.store_sku),
    ean: normalizedIdentifier(row.store_ean),
    title: normalizedIdentifier(row.title),
    price: rowPrice && rowPrice > 0 ? rowPrice : categoryPrice ?? rowPrice,
    currency: normalizeText(row.currency) || categoryCurrency || 'PLN',
    priceHistory: normalizePriceHistory(row.price_history),
    lastPriceChangedAt: normalizeDateString(row.last_price_changed_at),
    lastSeenAt: normalizeDateString(row.last_seen_at),
    updatedAt: normalizeDateString(row.updated_at),
    availability: normalizedIdentifier(row.availability) ?? categoryAvailability,
    url: normalizedIdentifier(row.product_url) ?? categoryPageUrl,
    description: normalizedIdentifier(row.description),
    shortDescription: normalizedIdentifier(row.short_description),
    seoTitle: normalizedIdentifier(row.seo_title),
    seoDescription: normalizedIdentifier(row.seo_description),
    brand: normalizedIdentifier(row.brand),
    imageUrls: Array.isArray(row.image_urls) ? row.image_urls.map(String).filter(Boolean) : [],
    parameters: row.parameters && typeof row.parameters === 'object' && !Array.isArray(row.parameters) ? row.parameters : null,
    categories,
    bundleItems,
  };
}

function offerKey(row: any) {
  return `${row.source}:${row.source_product_id}`;
}

async function decorateOffers(db: Db, rows: any[]) {
  const keys = rows
    .map((row) => ({ source: row.source, source_product_id: row.source_product_id }))
    .filter((row) => row.source && row.source_product_id);

  if (keys.length === 0) return rows.map((row) => normalizeOffer(row));

  const categoryRows: any[] = [];
  const bundleRows: any[] = [];
  for (const keyChunk of chunked(keys, 200)) {
    const [categoryChunk, bundleChunk] = await Promise.all([
      db.collection('regular_product_categories')
        .find({ $or: keyChunk })
        .project({
          source: 1,
          source_product_id: 1,
          category_id: 1,
          category_path: 1,
          category_url: 1,
          page_url: 1,
          price: 1,
          currency: 1,
          availability: 1,
          last_seen_at: 1,
          updated_at: 1,
        })
        .toArray(),
      db.collection('store_product_bundle_items')
        .find({ $or: keyChunk })
        .limit(1000)
        .toArray(),
    ]);
    categoryRows.push(...categoryChunk);
    bundleRows.push(...bundleChunk);
  }
  const byOffer = new Map<string, CompetitorCategory[]>();
  const bundlesByOffer = new Map<string, CompetitorBundleItem[]>();

  for (const row of categoryRows) {
    const key = `${row.source}:${row.source_product_id}`;
    const list = byOffer.get(key) ?? [];
    list.push({
      id: String(row.category_id),
      path: Array.isArray(row.category_path) ? row.category_path.map(String) : [],
      url: normalizedIdentifier(row.category_url),
      price: decimalToNumber(row.price),
      currency: normalizedIdentifier(row.currency),
      availability: normalizedIdentifier(row.availability),
      pageUrl: normalizedIdentifier(row.page_url),
      categoryUrl: normalizedIdentifier(row.category_url),
      updatedAt: normalizeDateString(row.updated_at),
      lastSeenAt: normalizeDateString(row.last_seen_at),
    });
    byOffer.set(key, list);
  }

  for (const row of bundleRows) {
    const key = `${row.source}:${row.source_product_id}`;
    const list = bundlesByOffer.get(key) ?? [];
    list.push(normalizeBundleItem(row));
    bundlesByOffer.set(key, list);
  }

  return rows.map((row) => normalizeOffer(
    row,
    byOffer.get(offerKey(row)) ?? [],
    bundlesByOffer.get(offerKey(row)) ?? [],
  ));
}

async function expandRowsByProductId(db: Db, rows: any[], sources: string[]) {
  const productIds = rows
    .map((row) => row.product_id)
    .filter((value) => value instanceof ObjectId);

  if (productIds.length === 0) return rows;

  const expanded = await db.collection('store_products')
    .find({ source: { $in: sources }, product_id: { $in: productIds } })
    .limit(80)
    .toArray();

  return expanded.length ? expanded : rows;
}

async function rowsByBaseProducts(db: Db, productIds: ObjectId[], sources: string[]) {
  if (productIds.length === 0) return [];
  return db.collection('store_products')
    .find({ source: { $in: sources }, product_id: { $in: productIds } })
    .limit(80)
    .toArray();
}

function rowId(row: any) {
  return String(row._id);
}

function setBatchMatchMeta(
  meta: Map<string, { confidence: MatchConfidence; matchedBy: string | null; productId: string | null }>,
  warehouseProductId: string,
  next: { confidence: MatchConfidence; matchedBy: string | null; productId: string | null },
) {
  const current = meta.get(warehouseProductId);
  if (!current || (current.confidence !== 'EAN' && next.confidence === 'EAN')) meta.set(warehouseProductId, next);
}

async function findCompetitorOffersBatch(
  db: Db,
  products: ProductForAnalytics[],
  source?: string,
  categoryId?: string,
): Promise<Map<string, CompetitorMatchResult>> {
  const sources = selectedSources(source);
  if (products.length === 0 || sources.length === 0) return new Map();

  const productIdsByEan = new Map<string, Set<string>>();
  const productIdsBySku = new Map<string, Set<string>>();
  const matchedByEan = new Map<string, string>();
  const matchedBySku = new Map<string, string>();
  const allEans = new Set<string>();
  const allSkus = new Set<string>();

  for (const product of products) {
    const identifiers = productIdentifiers(product);
    for (const ean of identifiers.eans) {
      allEans.add(ean);
      addIdentifierTarget(productIdsByEan, ean, product.id);
      matchedByEan.set(product.id, matchedByEan.get(product.id) ?? ean);
    }
    for (const sku of identifiers.skus) {
      allSkus.add(sku);
      addIdentifierTarget(productIdsBySku, sku, product.id);
      matchedBySku.set(product.id, matchedBySku.get(product.id) ?? sku);
    }
  }

  if (allEans.size === 0 && allSkus.size === 0) return new Map();

  const sourceFilter = { source: { $in: sources } };
  const storeRowsById = new Map<string, any>();
  const baseProductsById = new Map<string, any>();
  const eanValues = Array.from(allEans);
  const skuValues = Array.from(allSkus);

  for (const values of chunked(eanValues, 500)) {
    const rows = await db.collection('store_products')
      .find({ ...sourceFilter, store_ean: { $in: identifierVariantsForMongo(values) } })
      .toArray();
    for (const row of rows) storeRowsById.set(rowId(row), row);
  }
  for (const values of chunked(skuValues, 500)) {
    const rows = await db.collection('store_products')
      .find({ ...sourceFilter, store_sku: { $in: identifierVariantsForMongo(values) } })
      .toArray();
    for (const row of rows) storeRowsById.set(rowId(row), row);
  }
  for (const values of chunked(eanValues, 500)) {
    const rows = await db.collection('products')
      .find({ ean: { $in: identifierVariantsForMongo(values) } })
      .project({ _id: 1, ean: 1, sku: 1, product_number: 1 })
      .toArray();
    for (const row of rows) baseProductsById.set(rowId(row), row);
  }
  for (const values of chunked(skuValues, 500)) {
    const variants = identifierVariantsForMongo(values);
    const rows = await db.collection('products')
      .find({ $or: [{ sku: { $in: variants } }, { product_number: { $in: variants } }] })
      .project({ _id: 1, ean: 1, sku: 1, product_number: 1 })
      .toArray();
    for (const row of rows) baseProductsById.set(rowId(row), row);
  }

  const baseProductIds = Array.from(baseProductsById.keys()).map((id) => new ObjectId(id));
  for (const ids of chunked(baseProductIds, 500)) {
    const rows = await db.collection('store_products')
      .find({ ...sourceFilter, product_id: { $in: ids } })
      .toArray();
    for (const row of rows) storeRowsById.set(rowId(row), row);
  }

  const rowBaseIds = Array.from(new Set(
    Array.from(storeRowsById.values())
      .map((row) => row.product_id)
      .filter((value): value is ObjectId => value instanceof ObjectId)
      .map((id) => String(id))
  ));
  const missingBaseProductIds = rowBaseIds
    .filter((id) => !baseProductsById.has(id))
    .map((id) => new ObjectId(id));
  for (const ids of chunked(missingBaseProductIds, 500)) {
    const rows = await db.collection('products')
      .find({ _id: { $in: ids } })
      .project({ _id: 1, ean: 1, sku: 1, product_number: 1 })
      .toArray();
    for (const row of rows) baseProductsById.set(rowId(row), row);
  }

  const expandedProductIds = Array.from(new Set(
    Array.from(storeRowsById.values())
      .map((row) => row.product_id)
      .filter((value): value is ObjectId => value instanceof ObjectId)
      .map((id) => String(id))
  )).map((id) => new ObjectId(id));
  for (const ids of chunked(expandedProductIds, 500)) {
    const rows = await db.collection('store_products')
      .find({ ...sourceFilter, product_id: { $in: ids } })
      .toArray();
    for (const row of rows) storeRowsById.set(rowId(row), row);
  }

  const rawRows = Array.from(storeRowsById.values());
  const rowWarehouseProductIds = new Map<string, Set<string>>();
  const meta = new Map<string, { confidence: MatchConfidence; matchedBy: string | null; productId: string | null }>();

  for (const row of rawRows) {
    const baseProduct = row.product_id instanceof ObjectId ? baseProductsById.get(String(row.product_id)) : null;
    const eanProductIds = new Set<string>();
    const skuProductIds = new Set<string>();

    for (const value of [row.store_ean, row.ean, baseProduct?.ean]) {
      const key = identifierKey(value);
      if (!key) continue;
      for (const productId of productIdsByEan.get(key) ?? []) eanProductIds.add(productId);
    }
    for (const value of [row.store_sku, row.sku, baseProduct?.sku, baseProduct?.product_number]) {
      const key = identifierKey(value);
      if (!key) continue;
      for (const productId of productIdsBySku.get(key) ?? []) skuProductIds.add(productId);
    }

    const warehouseProductIds = new Set([...eanProductIds, ...skuProductIds]);
    if (warehouseProductIds.size === 0) continue;
    rowWarehouseProductIds.set(rowId(row), warehouseProductIds);

    for (const warehouseProductId of warehouseProductIds) {
      const confidence: MatchConfidence = eanProductIds.has(warehouseProductId) ? 'EAN' : 'SKU';
      setBatchMatchMeta(meta, warehouseProductId, {
        confidence,
        matchedBy: confidence === 'EAN' ? matchedByEan.get(warehouseProductId) ?? null : matchedBySku.get(warehouseProductId) ?? null,
        productId: row.product_id instanceof ObjectId ? String(row.product_id) : null,
      });
    }
  }

  if (rowWarehouseProductIds.size === 0) return new Map();

  const decoratedOffers = await decorateOffers(db, rawRows);
  const offersByProductId = new Map<string, CompetitorOffer[]>();
  for (let index = 0; index < decoratedOffers.length; index += 1) {
    const row = rawRows[index];
    const warehouseProductIds = rowWarehouseProductIds.get(rowId(row));
    if (!warehouseProductIds?.size) continue;
    const offer = decoratedOffers[index];
    if (categoryId && !offer.categories.some((category) => category.id === categoryId)) continue;
    for (const warehouseProductId of warehouseProductIds) {
      const offers = offersByProductId.get(warehouseProductId) ?? [];
      offers.push(offer);
      offersByProductId.set(warehouseProductId, offers);
    }
  }

  const result = new Map<string, CompetitorMatchResult>();
  for (const product of products) {
    const offers = offersByProductId.get(product.id) ?? [];
    if (offers.length === 0) continue;
    const matchMeta = meta.get(product.id);
    result.set(product.id, {
      confidence: matchMeta?.confidence ?? 'NONE',
      matchedBy: matchMeta?.matchedBy ?? null,
      productId: matchMeta?.productId ?? null,
      offers: offers.sort((a, b) => {
        if (a.price === null && b.price === null) return a.source.localeCompare(b.source);
        if (a.price === null) return 1;
        if (b.price === null) return -1;
        return a.price - b.price;
      }),
    });
  }

  return result;
}

function exactOr(field: string, values: string[]) {
  return values.slice(0, 20).map((value) => ({ [field]: exactRegex(value) }));
}

async function findCompetitorOffers(db: Db, product: ProductForAnalytics, source?: string, categoryId?: string) {
  const sources = selectedSources(source);
  const sourceFilter = { source: { $in: sources } };
  const { eans, skus } = productIdentifiers(product);
  let confidence: MatchConfidence = 'NONE';
  let matchedBy: string | null = null;
  let rows: any[] = [];

  if (eans.length) {
    rows = await db.collection('store_products')
      .find({ ...sourceFilter, $or: exactOr('store_ean', eans) })
      .limit(80)
      .toArray();
    if (rows.length) {
      confidence = 'EAN';
      matchedBy = eans[0];
    } else {
      const baseProducts = await db.collection('products')
        .find({ $or: exactOr('ean', eans) })
        .project({ _id: 1 })
        .limit(20)
        .toArray();
      rows = await rowsByBaseProducts(db, baseProducts.map((row) => row._id), sources);
      if (rows.length) {
        confidence = 'EAN';
        matchedBy = eans[0];
      }
    }
  }

  if (!rows.length && skus.length) {
    rows = await db.collection('store_products')
      .find({ ...sourceFilter, $or: exactOr('store_sku', skus) })
      .limit(80)
      .toArray();
    if (rows.length) {
      confidence = 'SKU';
      matchedBy = skus[0];
    } else {
      const baseProducts = await db.collection('products')
        .find({ $or: [...exactOr('sku', skus), ...exactOr('product_number', skus)] })
        .project({ _id: 1 })
        .limit(20)
        .toArray();
      rows = await rowsByBaseProducts(db, baseProducts.map((row) => row._id), sources);
      if (rows.length) {
        confidence = 'SKU';
        matchedBy = skus[0];
      }
    }
  }

  if (!rows.length && product.name.length >= 4) {
    rows = await db.collection('store_products')
      .find({ ...sourceFilter, title: containsRegex(product.name) })
      .limit(20)
      .toArray();
    if (rows.length) {
      confidence = 'NAME';
      matchedBy = product.name;
    }
  }

  rows = await expandRowsByProductId(db, rows, sources);
  const deduped = Array.from(new Map(rows.map((row) => [String(row._id), row])).values());
  const offers = await decorateOffers(db, deduped);
  const filteredOffers = categoryId
    ? offers.filter((offer) => offer.categories.some((category) => category.id === categoryId))
    : offers;

  const productId = deduped.find((row) => row.product_id instanceof ObjectId)?.product_id;
  return {
    confidence: filteredOffers.length ? confidence : 'NONE',
    matchedBy: filteredOffers.length ? matchedBy : null,
    productId: productId ? String(productId) : null,
    offers: filteredOffers.sort((a, b) => {
      if (a.price === null && b.price === null) return a.source.localeCompare(b.source);
      if (a.price === null) return 1;
      if (b.price === null) return -1;
      return a.price - b.price;
    }),
  };
}

async function mappingMap(tenantId: string, shopId?: string) {
  if (!shopId) return new Map<string, any>();
  const rows = await prisma.competitorCategoryMapping.findMany({ where: { tenantId, shopId } });
  return new Map(rows.map((row) => [`${row.source}:${row.sourceCategoryId}`, row]));
}

function categorySuggestions(offers: CompetitorOffer[], mappings: Map<string, any>) {
  const suggestions = new Map<string, EnrichedProduct['categorySuggestions'][number]>();

  for (const offer of offers) {
    for (const category of offer.categories) {
      const mapping = mappings.get(`${offer.source}:${category.id}`);
      if (!mapping) continue;
      const key = `${mapping.targetCategoryId}:${offer.source}:${category.id}`;
      suggestions.set(key, {
        source: offer.source,
        sourceCategoryId: category.id,
        sourceCategoryPath: category.path,
        targetCategoryId: mapping.targetCategoryId,
        targetCategoryName: mapping.targetCategoryName,
      });
    }
  }

  return Array.from(suggestions.values());
}

function productIssues(enriched: Omit<EnrichedProduct, 'issues'>) {
  const issues: CompetitorIssue[] = [];
  if (enriched.match.confidence === 'NONE') issues.push('NO_MATCH');
  if (enriched.currentCategories.length === 0) issues.push('MISSING_CATEGORY');
  if (!enriched.hasDescription) issues.push('MISSING_DESCRIPTION');
  if (
    enriched.currentGrossPrice !== null &&
    enriched.priceStats.suggestedGross !== null &&
    enriched.priceStats.diffPercentVsCurrent !== null &&
    Math.abs(enriched.priceStats.diffPercentVsCurrent) >= PRICE_OUTLIER_PERCENT
  ) {
    issues.push('PRICE_OUTLIER');
  }
  if (
    enriched.currentCategories.length > 0 &&
    enriched.categorySuggestions.length > 0 &&
    !enriched.categorySuggestions.some((suggestion) =>
      enriched.currentCategories.some((category) => category.id === suggestion.targetCategoryId)
    )
  ) {
    issues.push('BAD_CATEGORY');
  }
  return issues;
}

async function enrichProduct(
  db: Db,
  tenantId: string,
  product: ProductForAnalytics,
  options: {
    shopId?: string;
    source?: string;
    categoryId?: string;
    vatRate?: number;
    mappings?: Map<string, any>;
    match?: CompetitorMatchResult;
  } = {},
): Promise<EnrichedProduct> {
  const match = options.match ?? await findCompetitorOffers(db, product, options.source, options.categoryId);
  const currentPrice = currentGrossPrice(product, options.shopId);
  const productCost = costNet(product);
  const stats = priceStats(match.offers, currentPrice, productCost, options.vatRate);
  const mappings = options.mappings ?? await mappingMap(tenantId, options.shopId);
  const withoutIssues = {
    warehouseProductId: product.id,
    sku: product.sku,
    name: product.name,
    imageUrl: currentImageUrl(product, options.shopId),
    currentGrossPrice: currentPrice,
    costNet: productCost,
    currentCategories: currentCategories(product, options.shopId),
    hasDescription: hasCurrentDescription(product, options.shopId),
    match: {
      confidence: match.confidence,
      matchedBy: match.matchedBy,
      productId: match.productId,
    },
    priceStats: stats,
    offers: match.offers,
    categorySuggestions: categorySuggestions(match.offers, mappings),
    inShop: isProductMappedToShop(product, options.shopId),
    wholesaleOffer: bestWholesaleOffer(product),
  };

  return { ...withoutIssues, issues: productIssues(withoutIssues) };
}

function serializeEnriched(product: EnrichedProduct, includeOffers = false) {
  return {
    warehouseProductId: product.warehouseProductId,
    sku: product.sku,
    name: product.name,
    imageUrl: product.imageUrl,
    currentGrossPrice: product.currentGrossPrice,
    costNet: product.costNet,
    currentCategories: product.currentCategories,
    hasDescription: product.hasDescription,
    match: product.match,
    priceStats: product.priceStats,
    issues: product.issues,
    categorySuggestions: product.categorySuggestions,
    inShop: product.inShop,
    offerCount: product.offers.length,
    sources: Array.from(new Set(product.offers.map((offer) => offer.source))),
    offers: includeOffers ? product.offers : undefined,
    wholesaleOffer: product.wholesaleOffer,
  };
}

async function pricingVatRate(tenantId: string) {
  const settings = await prisma.warehousePricingSettings.upsert({
    where: { tenantId },
    update: {},
    create: { tenantId },
  });
  return decimalToNumber(settings?.defaultVatRate) ?? 23;
}

async function productsByIds(tenantId: string, productIds: string[]) {
  const ids = Array.from(new Set(productIds.filter(Boolean))).slice(0, MAX_BULK_PRODUCTS);
  if (ids.length === 0) throw new ValidationError('Wybierz co najmniej jeden produkt');
  const products = await prisma.warehouseProduct.findMany({
    where: { tenantId, id: { in: ids } },
    include: productInclude,
  });
  if (products.length !== ids.length) throw new ValidationError('Czesc produktow nie istnieje w tym tenancie');
  return products;
}

function productWhere(tenantId: string, query: { shopId?: string; q?: string }) {
  const search = normalizeText(query.q);
  const where: Prisma.WarehouseProductWhereInput = { tenantId };
  if (query.shopId) where.shopProductMappings = { some: { shopId: query.shopId, isActive: true } };
  if (search) {
    where.OR = [
      { sku: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { barcodes: { some: { ean: { contains: search, mode: 'insensitive' } } } },
      { shopProductMappings: { some: { externalSku: { contains: search, mode: 'insensitive' } } } },
      { shopProductMappings: { some: { externalEan: { contains: search, mode: 'insensitive' } } } },
    ];
  }
  return where;
}

function numericQuery(value: number | string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function chunked<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function identifierVariantsForMongo(values: string[]) {
  const variants: Array<string | number> = [];
  for (const value of values) {
    variants.push(value);
    const number = Number(value);
    if (Number.isFinite(number)) variants.push(number);
  }
  return Array.from(new Set(variants));
}

function addAuditOffer(target: Map<string, Array<{ source: string; price: number }>>, productId: string, offer: { source: string; price: number }) {
  const offers = target.get(productId) ?? [];
  offers.push(offer);
  target.set(productId, offers);
}

function auditTargetGross(
  medianGross: number | null,
  minMarkupGross: number | null,
  belowMarketTolerancePercent: number,
) {
  if (medianGross === null) return minMarkupGross;
  const lowerBound = medianGross * (1 - belowMarketTolerancePercent / 100);
  return round2(Math.max(lowerBound, minMarkupGross ?? 0));
}

export async function auditPricesForTenant(tenantId: string, query: PriceAuditQuery) {
  const db = await ensureMongo();
  await requireShop(tenantId, query.shopId);
  const sources = selectedSources(query.source);
  if (sources.length === 0) throw new ValidationError('Nieprawidlowe zrodlo konkurencji');

  const minMarkupPercent = numericQuery(query.minMarkupPercent, 40, 0, 500);
  const belowMarketTolerancePercent = numericQuery(query.belowMarketTolerancePercent, 1, 0, 100);
  const aboveMarketTolerancePercent = numericQuery(query.aboveMarketTolerancePercent, 5, 0, 500);
  const itemLimit = pageValue(query.itemLimit, PRICE_AUDIT_DEFAULT_ITEM_LIMIT, PRICE_AUDIT_MAX_ITEM_LIMIT);
  const vatRate = await pricingVatRate(tenantId);

  const products = await prisma.warehouseProduct.findMany({
    where: productWhere(tenantId, { shopId: query.shopId }),
    select: {
      id: true,
      sku: true,
      name: true,
      retailPrice: true,
      purchasePrice: true,
      averagePurchaseCost: true,
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
        select: { lastKnownPrice: true },
      },
      barcodes: { where: { isActive: true }, select: { ean: true } },
      shopProductMappings: {
        where: { shopId: query.shopId, isActive: true },
        select: { externalEan: true, externalSku: true },
      },
      shopPrices: { where: { shopId: query.shopId }, select: { grossPrice: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const productIdsByEan = new Map<string, Set<string>>();
  const productIdsBySku = new Map<string, Set<string>>();
  const allEans = new Set<string>();
  const allSkus = new Set<string>();

  for (const product of products) {
    const identifiers = productIdentifiers(product);
    for (const ean of identifiers.eans) {
      allEans.add(ean);
      addIdentifierTarget(productIdsByEan, ean, product.id);
    }
    for (const sku of identifiers.skus) {
      allSkus.add(sku);
      addIdentifierTarget(productIdsBySku, sku, product.id);
    }
  }

  const sourceFilter = { source: { $in: sources } };
  const storeRowsById = new Map<string, any>();
  const baseProductsById = new Map<string, any>();
  const eanValues = Array.from(allEans);
  const skuValues = Array.from(allSkus);

  for (const values of chunked(eanValues, 500)) {
    const variants = identifierVariantsForMongo(values);
    const rows = await db.collection('store_products')
      .find({ ...sourceFilter, store_ean: { $in: variants } })
      .project({ source: 1, source_product_id: 1, store_ean: 1, store_sku: 1, sku: 1, product_id: 1, price: 1, current_price: 1, gross_price: 1, listing_price: 1 })
      .toArray();
    for (const row of rows) storeRowsById.set(String(row._id), row);
  }

  for (const values of chunked(skuValues, 500)) {
    const variants = identifierVariantsForMongo(values);
    const rows = await db.collection('store_products')
      .find({ ...sourceFilter, store_sku: { $in: variants } })
      .project({ source: 1, source_product_id: 1, store_ean: 1, store_sku: 1, sku: 1, product_id: 1, price: 1, current_price: 1, gross_price: 1, listing_price: 1 })
      .toArray();
    for (const row of rows) storeRowsById.set(String(row._id), row);
  }

  for (const values of chunked(eanValues, 500)) {
    const variants = identifierVariantsForMongo(values);
    const rows = await db.collection('products')
      .find({ ean: { $in: variants } })
      .project({ _id: 1, ean: 1, sku: 1, product_number: 1 })
      .toArray();
    for (const row of rows) baseProductsById.set(String(row._id), row);
  }

  for (const values of chunked(skuValues, 500)) {
    const variants = identifierVariantsForMongo(values);
    const rows = await db.collection('products')
      .find({ $or: [{ sku: { $in: variants } }, { product_number: { $in: variants } }] })
      .project({ _id: 1, ean: 1, sku: 1, product_number: 1 })
      .toArray();
    for (const row of rows) baseProductsById.set(String(row._id), row);
  }

  const baseProductIds = Array.from(baseProductsById.keys()).map((id) => new ObjectId(id));
  for (const ids of chunked(baseProductIds, 500)) {
    const rows = await db.collection('store_products')
      .find({ ...sourceFilter, product_id: { $in: ids } })
      .project({ source: 1, source_product_id: 1, store_ean: 1, store_sku: 1, sku: 1, product_id: 1, price: 1, current_price: 1, gross_price: 1, listing_price: 1 })
      .toArray();
    for (const row of rows) storeRowsById.set(String(row._id), row);
  }

  const missingBaseIds = Array.from(new Set(
    Array.from(storeRowsById.values())
      .map((row) => row.product_id)
      .filter((value): value is ObjectId => value instanceof ObjectId)
      .map((value) => String(value))
      .filter((id) => !baseProductsById.has(id))
  )).map((id) => new ObjectId(id));
  for (const ids of chunked(missingBaseIds, 500)) {
    const rows = await db.collection('products')
      .find({ _id: { $in: ids } })
      .project({ _id: 1, ean: 1, sku: 1, product_number: 1 })
      .toArray();
    for (const row of rows) baseProductsById.set(String(row._id), row);
  }

  const offersByProductId = new Map<string, Array<{ source: string; price: number }>>();
  for (const row of storeRowsById.values()) {
    const price = normalizeOfferPrice(row);
    if (price === null || price <= 0) continue;
    const baseProduct = row.product_id instanceof ObjectId ? baseProductsById.get(String(row.product_id)) : null;
    const productIds = new Set<string>();

    for (const value of [row.store_ean, row.ean, baseProduct?.ean]) {
      const key = identifierKey(value);
      if (!key) continue;
      for (const productId of productIdsByEan.get(key) ?? []) productIds.add(productId);
    }
    for (const value of [row.store_sku, row.sku, baseProduct?.sku, baseProduct?.product_number]) {
      const key = identifierKey(value);
      if (!key) continue;
      for (const productId of productIdsBySku.get(key) ?? []) productIds.add(productId);
    }

    for (const productId of productIds) addAuditOffer(offersByProductId, productId, { source: String(row.source ?? ''), price });
  }

  const items = products.map((product) => {
    const currentGross = decimalToNumber(product.shopPrices[0]?.grossPrice) ?? decimalToNumber(product.retailPrice);
    const productCostNet = decimalToNumber(product.averagePurchaseCost)
      ?? decimalToNumber(product.purchasePrice)
      ?? decimalToNumber(product.wholesaleMappings[0]?.lastKnownPrice);
    const offers = offersByProductId.get(product.id) ?? [];
    const stats = priceStats(offers as CompetitorOffer[], currentGross, productCostNet, vatRate);
    const minMarkupGross = productCostNet === null ? null : round2(productCostNet * (1 + minMarkupPercent / 100) * (1 + vatRate / 100));
    const targetGross = auditTargetGross(stats.medianGross, minMarkupGross, belowMarketTolerancePercent);
    const targetNet = grossToNetCeil(targetGross, vatRate);
    const lowerMarketBound = stats.medianGross === null ? null : round2(stats.medianGross * (1 - belowMarketTolerancePercent / 100));
    const upperMarketBound = stats.medianGross === null ? null : round2(stats.medianGross * (1 + aboveMarketTolerancePercent / 100));
    const minMarginForcesAboveMarket = Boolean(minMarkupGross !== null && upperMarketBound !== null && minMarkupGross > upperMarketBound);
    const reasons: string[] = [];

    if (currentGross === null) reasons.push('MISSING_CURRENT_PRICE');
    if (stats.medianGross === null) reasons.push('NO_COMPETITOR_PRICE');
    if (productCostNet === null) reasons.push('MISSING_COST');
    if (currentGross !== null && minMarkupGross !== null && currentGross < minMarkupGross) reasons.push('BELOW_40_MARKUP');
    if (currentGross !== null && lowerMarketBound !== null && currentGross < lowerMarketBound) reasons.push('BELOW_MARKET');
    if (currentGross !== null && upperMarketBound !== null && currentGross > upperMarketBound && !minMarginForcesAboveMarket) reasons.push('ABOVE_MARKET_GT_5');
    if (minMarginForcesAboveMarket) reasons.push('MIN_MARGIN_ABOVE_MARKET');

    const actionable = targetGross !== null
      && differsByAtLeastOneCent(currentGross, targetGross)
      && reasons.some((reason) => ['MISSING_CURRENT_PRICE', 'BELOW_40_MARKUP', 'BELOW_MARKET', 'ABOVE_MARKET_GT_5'].includes(reason));

    return {
      warehouseProductId: product.id,
      sku: product.sku,
      name: product.name,
      currentGrossPrice: round2(currentGross),
      targetGross,
      targetNet,
      costNet: round2(productCostNet),
      minMarkupGross,
      competitorMinGross: stats.minGross,
      competitorMedianGross: stats.medianGross,
      competitorMaxGross: stats.maxGross,
      offerCount: offers.length,
      sourceCount: new Set(offers.map((offer) => offer.source)).size,
      diffCurrentToMedianPercent: priceDiffPercent(currentGross, stats.medianGross),
      diffTargetToMedianPercent: priceDiffPercent(targetGross, stats.medianGross),
      minMarginForcesAboveMarket,
      reasons,
      actionable,
    };
  });

  const counts = items.reduce((acc, item) => {
    for (const reason of item.reasons) acc[reason] = (acc[reason] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const anomalies = items.filter((item) => item.reasons.length > 0);
  const actionable = items.filter((item) => item.actionable);

  return {
    generatedAt: new Date().toISOString(),
    shopId: query.shopId,
    sources,
    rule: {
      minMarkupPercent,
      belowMarketTolerancePercent,
      aboveMarketTolerancePercent,
      vatRate,
      matchMode: 'EAN_SKU_BATCH',
    },
    totals: {
      products: products.length,
      matchedProducts: items.filter((item) => item.offerCount > 0).length,
      anomalies: anomalies.length,
      actionable: actionable.length,
    },
    counts,
    warnings: warningsForSources(sources, 'prices'),
    items: anomalies.slice(0, itemLimit),
  };
}

export async function auditPrices(query: PriceAuditQuery) {
  return auditPricesForTenant(requireTenantId(), query);
}

export async function applyPriceAuditForTenant(tenantId: string, input: PriceAuditApplyInput) {
  const maxApply = pageValue(input.maxApply, PRICE_AUDIT_MAX_ITEM_LIMIT, PRICE_AUDIT_MAX_ITEM_LIMIT);
  const audit = await auditPricesForTenant(tenantId, { ...input, itemLimit: PRICE_AUDIT_MAX_ITEM_LIMIT });
  const candidates = audit.items
    .filter((item: any) => item.actionable && item.targetNet !== null && item.targetNet !== undefined)
    .slice(0, maxApply);
  const result = {
    requested: candidates.length,
    applied: 0,
    skippedManualOverrides: 0,
    recalculatedBatches: 0,
    syncedBatches: 0,
    enqueued: 0,
    synced: 0,
    appliedIds: [] as string[],
    audit: {
      generatedAt: audit.generatedAt,
      totals: audit.totals,
      counts: audit.counts,
      rule: audit.rule,
      warnings: audit.warnings,
    },
    errors: [] as Array<{ warehouseProductId: string; sku?: string | null; message: string }>,
  };

  for (const items of chunked(candidates, 100)) {
    const productIds = items.map((item: any) => item.warehouseProductId);
    const existingRules = await prisma.warehousePricingRule.findMany({
      where: {
        tenantId,
        level: 'PRODUCT',
        warehouseProductId: { in: productIds },
        shopId: input.shopId,
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    const primaryRuleByProductId = new Map<string, typeof existingRules[number]>();
    const duplicateRuleIds: string[] = [];
    for (const rule of existingRules) {
      if (rule.warehouseProductId && !primaryRuleByProductId.has(rule.warehouseProductId)) {
        primaryRuleByProductId.set(rule.warehouseProductId, rule);
      } else {
        duplicateRuleIds.push(rule.id);
      }
    }

    await prisma.$transaction(async (tx) => {
      for (const item of items as any[]) {
        const data = {
          level: 'PRODUCT' as const,
          shopId: input.shopId,
          catalogId: null,
          priceGroupId: null,
          warehouseProductId: item.warehouseProductId,
          marginPercent: null,
          minProfit: null,
          fixedNetPrice: new Prisma.Decimal(item.targetNet),
          priceMode: 'FIXED' as const,
          costCeilingEnabled: false,
          vatRate: new Prisma.Decimal(audit.rule.vatRate),
          roundingMode: 'CENT' as const,
          syncMode: 'CONFIRM' as const,
          origin: input.origin ?? 'COMPETITOR_MANUAL',
          isActive: true,
        };
        const existing = primaryRuleByProductId.get(item.warehouseProductId);
        if (existing) {
          const isManualFixed = existing.origin === 'MANUAL' && existing.priceMode === 'FIXED';
          if (input.skipManualFixedPrices === true && isManualFixed) {
            result.skippedManualOverrides += 1;
            continue;
          }
          await tx.warehousePricingRule.update({ where: { id: existing.id }, data });
        } else {
          await tx.warehousePricingRule.create({ data: { tenantId, ...data } });
        }
        result.applied += 1;
        result.appliedIds.push(item.warehouseProductId);
      }
      if (duplicateRuleIds.length > 0) {
        await tx.warehousePricingRule.updateMany({
          where: { tenantId, id: { in: duplicateRuleIds } },
          data: { isActive: false },
        });
      }
    });
  }

  for (const productIds of chunked(result.appliedIds, 500)) {
    if (input.sync) {
      const synced = await pricingService.syncPricingForTenant(tenantId, { productIds, shopIds: [input.shopId], triggeredBy: input.triggeredBy ?? 'MANUAL' });
      result.syncedBatches += 1;
      result.enqueued += synced.enqueued;
      result.synced += synced.synced ?? 0;
      result.errors.push(...synced.errors.map((error) => ({
        warehouseProductId: error.warehouseProductId,
        message: error.message,
      })));
    } else if (input.recalculate !== false) {
      await pricingService.recalculatePricingForTenant(tenantId, { productIds, shopIds: [input.shopId] });
      result.recalculatedBatches += 1;
    }
  }

  return result;
}

export async function applyPriceAudit(input: PriceAuditApplyInput) {
  return applyPriceAuditForTenant(requireTenantId(), input);
}

export async function listCompetitorPriceAutomationRuns(query: { shopId?: string; limit?: number | string } = {}) {
  const tenantId = requireTenantId();
  const limit = pageValue(query.limit, 20, 100);
  return prisma.competitorPriceAutomationRun.findMany({
    where: {
      tenantId,
      ...(query.shopId ? { shopId: query.shopId } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

export async function runCompetitorPriceAutomationForTenant(
  tenantId: string,
  input: { trigger?: 'MANUAL' | 'SCHEDULED'; shopId?: string } = {},
) {
  const settings = await prisma.warehousePricingSettings.findUnique({ where: { tenantId } });
  const shopId = input.shopId ?? settings?.competitorAutoPricingShopId;
  if (!shopId) throw new ValidationError('Wybierz sklep dla automatycznych cen konkurencji');

  const shop = await prisma.shop.findFirst({ where: { id: shopId, tenantId, status: 'ACTIVE' }, select: { id: true } });
  if (!shop) throw new ValidationError('Sklep automatycznych cen konkurencji nie istnieje albo jest nieaktywny');

  const runKey = `${tenantId}:${shopId}`;
  if (activeCompetitorPriceAutomationRuns.has(runKey)) {
    throw new ValidationError('Automatyczna reguła cen konkurencji jest już uruchomiona dla tego sklepu');
  }

  const minMarkupPercent = decimalToNumber(settings?.competitorAutoPricingMinMarkupPercent) ?? 40;
  const belowMarketTolerancePercent = decimalToNumber(settings?.competitorAutoPricingBelowMarketTolerancePercent) ?? 1;
  const aboveMarketTolerancePercent = decimalToNumber(settings?.competitorAutoPricingAboveMarketTolerancePercent) ?? 5;
  const startedAt = new Date();
  const run = await prisma.competitorPriceAutomationRun.create({
    data: {
      tenantId,
      shopId,
      trigger: input.trigger ?? 'MANUAL',
      status: 'PROCESSING',
      minMarkupPercent,
      belowMarketTolerancePercent,
      aboveMarketTolerancePercent,
      startedAt,
    },
  });

  activeCompetitorPriceAutomationRuns.add(runKey);
  try {
    const result = await applyPriceAuditForTenant(tenantId, {
      shopId,
      minMarkupPercent,
      belowMarketTolerancePercent,
      aboveMarketTolerancePercent,
      sync: true,
      recalculate: false,
      origin: 'COMPETITOR_AUTO',
      skipManualFixedPrices: true,
      triggeredBy: 'COMPETITOR_AUTO',
    });
    const failed = result.errors.length;
    const status = failed > 0 ? (result.applied > 0 ? 'PARTIAL' : 'FAILED') : 'SUCCESS';
    const finishedAt = new Date();
    const updated = await prisma.competitorPriceAutomationRun.update({
      where: { id: run.id },
      data: {
        status,
        requested: result.requested,
        applied: result.applied,
        skippedManualOverrides: result.skippedManualOverrides,
        synced: result.synced,
        enqueued: result.enqueued,
        failed,
        actionableBefore: result.audit.totals.actionable,
        errorMessage: failed > 0 ? result.errors.map((error) => `${error.warehouseProductId}: ${error.message}`).join('\n').slice(0, 5000) : null,
        finishedAt,
      },
    });
    await prisma.warehousePricingSettings.update({
      where: { tenantId },
      data: {
        competitorAutoPricingLastRunAt: finishedAt,
        ...(failed > 0
          ? {
              competitorAutoPricingLastErrorAt: finishedAt,
              competitorAutoPricingLastErrorMessage: updated.errorMessage,
            }
          : {
              competitorAutoPricingLastErrorAt: null,
              competitorAutoPricingLastErrorMessage: null,
            }),
      },
    });
    return { run: updated, result };
  } catch (error) {
    const finishedAt = new Date();
    const message = error instanceof Error ? error.message : 'Błąd automatycznej reguły cen konkurencji';
    const updated = await prisma.competitorPriceAutomationRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        failed: 1,
        errorMessage: message,
        finishedAt,
      },
    });
    await prisma.warehousePricingSettings.update({
      where: { tenantId },
      data: {
        competitorAutoPricingLastRunAt: finishedAt,
        competitorAutoPricingLastErrorAt: finishedAt,
        competitorAutoPricingLastErrorMessage: message,
      },
    });
    return { run: updated, result: null };
  } finally {
    activeCompetitorPriceAutomationRuns.delete(runKey);
  }
}

export async function runCompetitorPriceAutomation(input: { shopId?: string } = {}) {
  return runCompetitorPriceAutomationForTenant(requireTenantId(), { ...input, trigger: 'MANUAL' });
}

function emptyIssueCounts() {
  return {
    NO_MATCH: 0,
    MISSING_CATEGORY: 0,
    BAD_CATEGORY: 0,
    PRICE_OUTLIER: 0,
    MISSING_DESCRIPTION: 0,
  } satisfies Record<CompetitorIssue, number>;
}

function diagnosticProduct(product: EnrichedProduct) {
  return {
    warehouseProductId: product.warehouseProductId,
    sku: product.sku,
    name: product.name,
    match: product.match,
    offerCount: product.offers.length,
    issues: product.issues,
    currentGrossPrice: product.currentGrossPrice,
    medianGross: product.priceStats.medianGross,
    suggestedGross: product.priceStats.suggestedGross,
    sources: Array.from(new Set(product.offers.map((offer) => offer.source))),
  };
}

export async function getOverview(query: { shopId?: string } = {}) {
  const tenantId = requireTenantId();
  const db = await ensureMongo();
  if (query.shopId) await requireShop(tenantId, query.shopId);

  const sourceStats = await db.collection('store_products').aggregate([
    { $match: { source: { $in: SOURCES as unknown as string[] } } },
    {
      $group: {
        _id: '$source',
        products: { $sum: 1 },
        withPrice: { $sum: { $cond: [{ $ne: ['$price', null] }, 1, 0] } },
        withEan: { $sum: { $cond: [{ $and: [{ $ne: ['$store_ean', null] }, { $ne: ['$store_ean', ''] }] }, 1, 0] } },
        withSku: { $sum: { $cond: [{ $and: [{ $ne: ['$store_sku', null] }, { $ne: ['$store_sku', ''] }] }, 1, 0] } },
        withDescription: { $sum: { $cond: [{ $or: [{ $ne: ['$description', null] }, { $ne: ['$short_description', null] }] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();

  const categoryCoverage = await db.collection('store_products').aggregate([
    { $match: { source: { $in: SOURCES as unknown as string[] } } },
    {
      $lookup: {
        from: 'regular_product_categories',
        let: { source: '$source', source_product_id: '$source_product_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$source', '$$source'] },
                  { $eq: ['$source_product_id', '$$source_product_id'] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: 'category',
      },
    },
    { $group: { _id: { source: '$source', hasCategory: { $gt: [{ $size: '$category' }, 0] } }, products: { $sum: 1 } } },
    { $sort: { '_id.source': 1 } },
  ]).toArray();
  const latestScanRuns = await db.collection('scan_runs').aggregate([
    { $match: { source: { $in: SOURCES as unknown as string[] } } },
    {
      $addFields: {
        sortDate: { $ifNull: ['$finished_at', { $ifNull: ['$updated_at', '$started_at'] }] },
      },
    },
    { $sort: { source: 1, sortDate: -1, _id: -1 } },
    {
      $group: {
        _id: '$source',
        status: { $first: '$status' },
        startedAt: { $first: '$started_at' },
        finishedAt: { $first: '$finished_at' },
        priceUpdates: { $first: { $ifNull: ['$price_updates', 0] } },
        priceUnchanged: { $first: { $ifNull: ['$price_unchanged', 0] } },
      },
    },
    { $sort: { _id: 1 } },
  ]).toArray();

  const warehouseWhere: Prisma.WarehouseProductWhereInput = { tenantId };
  if (query.shopId) warehouseWhere.shopProductMappings = { some: { shopId: query.shopId, isActive: true } };
  const [warehouseProducts, mappedProducts, mappings] = await Promise.all([
    prisma.warehouseProduct.count({ where: warehouseWhere }),
    prisma.warehouseProduct.count({ where: { ...warehouseWhere, shopProductMappings: { some: { ...(query.shopId ? { shopId: query.shopId } : {}), isActive: true } } } }),
    query.shopId ? prisma.competitorCategoryMapping.count({ where: { tenantId, shopId: query.shopId } }) : Promise.resolve(0),
  ]);

  return {
    configured: true,
    sources: SOURCES,
    warnings: warningsForSources([...SOURCES], 'categories'),
    sourceStats,
    categoryCoverage,
    latestScanRuns: latestScanRuns.map((row) => ({
      source: row._id,
      status: row.status ?? null,
      startedAt: normalizeDateString(row.startedAt),
      finishedAt: normalizeDateString(row.finishedAt),
      priceUpdates: Number(row.priceUpdates ?? 0),
      priceUnchanged: Number(row.priceUnchanged ?? 0),
    })),
    warehouse: {
      products: warehouseProducts,
      mappedProducts,
      categoryMappings: mappings,
    },
  };
}

export async function listProducts(query: ProductListQuery = {}) {
  const tenantId = requireTenantId();
  const db = await ensureMongo();
  const page = pageValue(query.page, 1);
  const limit = pageValue(query.limit, 50, MAX_LIST_LIMIT);
  const source = query.source && query.source !== 'ALL' ? query.source : undefined;
  const vatRate = await pricingVatRate(tenantId);
  const issueFilter = query.issue && query.issue !== 'ALL' ? query.issue as CompetitorIssue : null;
  const shopPresence = shopPresenceValue(query.shopPresence);

  if (query.shopId) await requireShop(tenantId, query.shopId);
  const where = productWhere(tenantId, {
    ...query,
    shopId: shopPresence === 'IN_SHOP' ? query.shopId : undefined,
  });
  if (query.shopId && shopPresence === 'MISSING_IN_SHOP') {
    where.shopProductMappings = { none: { shopId: query.shopId, isActive: true } };
  }
  if (booleanQuery(query.wholesaleAvailable)) {
    where.wholesaleMappings = {
      some: {
        isActive: true,
        lastKnownStock: { gt: 0 },
        provider: { isActive: true },
      },
    };
  }
  if (query.categoryId) {
    if (!query.shopId) throw new ValidationError('Filtr kategorii konkurencji wymaga sklepu');
    if (!source) throw new ValidationError('Filtr kategorii konkurencji wymaga konkretnego zrodla');
    const categoryProductIds = await categoryMatchedWarehouseProductIds(
      db,
      tenantId,
      query.shopId,
      source,
      query.categoryId,
      shopPresence === 'IN_SHOP',
    );
    where.id = { in: categoryProductIds };
  }
  const mappings = await mappingMap(tenantId, query.shopId);

  if (!issueFilter) {
    const [products, total] = await Promise.all([
      prisma.warehouseProduct.findMany({
        where,
        include: productInclude,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.warehouseProduct.count({ where }),
    ]);

    const matches = await findCompetitorOffersBatch(db, products, source, query.categoryId);
    const enriched = await Promise.all(products.map((product) =>
      enrichProduct(db, tenantId, product, {
        shopId: query.shopId,
        source,
        categoryId: query.categoryId,
        vatRate,
        mappings,
        match: matches.get(product.id),
      })
    ));

    return {
      data: enriched.map((product) => serializeEnriched(product)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      analysis: {
        issueFilter: 'ALL',
        totalCandidates: total,
        analyzed: products.length,
        matchingIssue: null,
        complete: true,
      },
      warnings: warningsForSources(selectedSources(source), query.categoryId ? 'categories' : 'prices'),
    };
  }

  const totalCandidates = await prisma.warehouseProduct.count({ where });
  const requestedEnd = page * limit;
  const maxScan = Math.min(
    totalCandidates,
    Math.max(ISSUE_SCAN_MIN_LIMIT, requestedEnd * 4),
    ISSUE_SCAN_MAX_LIMIT,
  );
  const filtered: EnrichedProduct[] = [];
  let scanned = 0;

  while (scanned < maxScan && filtered.length < requestedEnd) {
    const products = await prisma.warehouseProduct.findMany({
      where,
      include: productInclude,
      orderBy: { updatedAt: 'desc' },
      skip: scanned,
      take: Math.min(ISSUE_SCAN_CHUNK_SIZE, maxScan - scanned),
    });
    if (products.length === 0) break;
    scanned += products.length;

    const matches = await findCompetitorOffersBatch(db, products, source, query.categoryId);
    const enriched = await Promise.all(products.map((product) =>
      enrichProduct(db, tenantId, product, {
        shopId: query.shopId,
        source,
        categoryId: query.categoryId,
        vatRate,
        mappings,
        match: matches.get(product.id),
      })
    ));
    filtered.push(...enriched.filter((product) => product.issues.includes(issueFilter)));
  }

  const pageItems = filtered.slice((page - 1) * limit, requestedEnd);
  const warnings = warningsForSources(selectedSources(source), query.categoryId ? 'categories' : 'prices');
  if (scanned < totalCandidates) {
    warnings.push(
      `Filtr problemu przeanalizowal pierwsze ${scanned} z ${totalCandidates} produktow. ` +
      'Zawez wyszukiwanie, jesli chcesz dokladniejszy audyt.'
    );
  }

  return {
    data: pageItems.map((product) => serializeEnriched(product)),
    total: filtered.length,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(filtered.length / limit)),
    analysis: {
      issueFilter,
      totalCandidates,
      analyzed: scanned,
      matchingIssue: filtered.length,
      complete: scanned >= totalCandidates,
    },
    warnings,
  };
}

export async function listWholesaleMissingSystemProducts(query: WholesaleMissingSystemQuery = {}) {
  const tenantId = requireTenantId();
  const db = await ensureMongo();
  const page = pageValue(query.page, 1);
  const limit = pageValue(query.limit, 50, MAX_LIST_LIMIT);
  const source = query.source && query.source !== 'ALL' ? query.source : undefined;
  const categoryId = normalizedIdentifier(query.categoryId);
  const availableOnly = booleanQuery(query.availableOnly);

  if (!query.shopId) throw new ValidationError('Widok brakow w systemie wymaga sklepu');
  await requireShop(tenantId, query.shopId);
  if (!source || !SOURCES.includes(source as any)) throw new ValidationError('Widok brakow w systemie wymaga konkretnego zrodla konkurencji');
  if (!categoryId) throw new ValidationError('Widok brakow w systemie wymaga kategorii konkurencji');

  const numericCategoryId = Number(categoryId);
  const categoryIdFilter = Number.isFinite(numericCategoryId)
    ? { $in: [categoryId, numericCategoryId] }
    : categoryId;
  const categoryRows = await db.collection('regular_product_categories')
    .find({ source, category_id: categoryIdFilter })
    .project({ source_product_id: 1 })
    .toArray();
  const sourceProductIds = unique(categoryRows.map((row) => normalizedIdentifier(row.source_product_id)));

  const empty = (summary: Record<string, number>) => ({
    data: [],
    total: 0,
    page,
    limit,
    totalPages: 1,
    summary: {
      sourceProducts: sourceProductIds.length,
      alreadyInSystem: 0,
      missingInSystem: 0,
      withStoreProductData: 0,
      matchedWholesaleMappings: 0,
      ...summary,
    },
    warnings: warningsForSources([source], 'categories'),
  });

  if (sourceProductIds.length === 0) return empty({});

  const matchedProductIdsBySourceProduct = await matchedWarehouseProductIdsBySourceProduct(
    db,
    tenantId,
    query.shopId,
    source,
    sourceProductIds,
    false,
  );
  const alreadyInSystemIds = sourceProductIds.filter((sourceProductId) =>
    (matchedProductIdsBySourceProduct.get(sourceProductId)?.size ?? 0) > 0
  );
  const missingSourceProductIds = sourceProductIds.filter((sourceProductId) =>
    (matchedProductIdsBySourceProduct.get(sourceProductId)?.size ?? 0) === 0
  );

  if (missingSourceProductIds.length === 0) {
    return empty({
      alreadyInSystem: alreadyInSystemIds.length,
      missingInSystem: 0,
    });
  }

  const missingSourceProductIdSet = new Set(missingSourceProductIds);
  const storeProductRows = await db.collection('store_products')
    .find({ source, source_product_id: { $in: missingSourceProductIds.flatMap(valueVariants) } })
    .project({
      source_product_id: 1,
      store_ean: 1,
      store_sku: 1,
      ean: 1,
      sku: 1,
      product_id: 1,
      title: 1,
      name: 1,
      price: 1,
      current_price: 1,
      gross_price: 1,
      listing_price: 1,
      currency: 1,
      availability: 1,
      product_url: 1,
      page_url: 1,
      url: 1,
      image_urls: 1,
      image_url: 1,
      image: 1,
      updated_at: 1,
      last_seen_at: 1,
    })
    .toArray();
  const baseProductIds = Array.from(new Set(
    storeProductRows
      .map((row) => row.product_id)
      .filter((value): value is ObjectId => value instanceof ObjectId)
      .map((value) => String(value))
  )).map((value) => new ObjectId(value));
  const baseProducts = baseProductIds.length
    ? await db.collection('products')
      .find({ _id: { $in: baseProductIds } })
      .project({ ean: 1, sku: 1, product_number: 1, title: 1, name: 1 })
      .toArray()
    : [];
  const baseProductById = new Map(baseProducts.map((row) => [String(row._id), row]));
  const storeProductBySourceProductId = new Map<string, any>();

  for (const row of storeProductRows) {
    const sourceProductId = normalizedIdentifier(row.source_product_id);
    if (!sourceProductId || !missingSourceProductIdSet.has(sourceProductId)) continue;
    const baseProduct = row.product_id instanceof ObjectId ? baseProductById.get(String(row.product_id)) : null;
    const existing = storeProductBySourceProductId.get(sourceProductId);
    const existingBaseProduct = existing?.product_id instanceof ObjectId ? baseProductById.get(String(existing.product_id)) : null;
    if (!existing || storeProductScore(row, baseProduct) > storeProductScore(existing, existingBaseProduct)) {
      storeProductBySourceProductId.set(sourceProductId, row);
    }
  }

  const sourceDetailsById = new Map<string, {
    sourceProductId: string;
    sku: string | null;
    ean: string | null;
    title: string | null;
    price: number | null;
    currency: string | null;
    availability: string | null;
    url: string | null;
    imageUrl: string | null;
    skus: string[];
    eans: string[];
  }>();
  const sourceIdsBySku = new Map<string, Set<string>>();
  const sourceIdsByEan = new Map<string, Set<string>>();
  const allSkus = new Set<string>();
  const allEans = new Set<string>();

  for (const sourceProductId of missingSourceProductIds) {
    const row = storeProductBySourceProductId.get(sourceProductId);
    if (!row) continue;
    const baseProduct = row.product_id instanceof ObjectId ? baseProductById.get(String(row.product_id)) : null;
    const identifiers = storeProductIdentifiers(row, baseProduct);
    for (const sku of identifiers.skus) {
      allSkus.add(sku);
      addIdentifierTarget(sourceIdsBySku, sku, sourceProductId);
    }
    for (const ean of identifiers.eans) {
      allEans.add(ean);
      addIdentifierTarget(sourceIdsByEan, ean, sourceProductId);
    }
    sourceDetailsById.set(sourceProductId, {
      sourceProductId,
      sku: identifiers.skus[0] ?? null,
      ean: identifiers.eans[0] ?? null,
      title: storeProductTitle(row, baseProduct),
      price: normalizeOfferPrice(row),
      currency: normalizedIdentifier(row.currency),
      availability: normalizedIdentifier(row.availability),
      url: storeProductUrl(row),
      imageUrl: storeProductImageUrl(row),
      skus: identifiers.skus,
      eans: identifiers.eans,
    });
  }

  if (allSkus.size === 0 && allEans.size === 0) {
    return empty({
      alreadyInSystem: alreadyInSystemIds.length,
      missingInSystem: missingSourceProductIds.length,
      withStoreProductData: sourceDetailsById.size,
    });
  }

  const mappingOr: Prisma.WholesaleProductMappingWhereInput[] = [];
  if (allSkus.size > 0) mappingOr.push({ externalSku: { in: Array.from(allSkus) } });
  if (allEans.size > 0) mappingOr.push({ externalEan: { in: Array.from(allEans) } });

  const mappings = await prisma.wholesaleProductMapping.findMany({
    where: {
      tenantId,
      warehouseProductId: null,
      isActive: true,
      provider: { isActive: true },
      ...(availableOnly ? { lastKnownStock: { gt: 0 } } : {}),
      OR: mappingOr,
    },
    include: { provider: { select: { id: true, name: true, configJson: true } } },
    orderBy: [
      { lastKnownStock: 'desc' },
      { lastKnownPrice: 'asc' },
      { externalName: 'asc' },
      { externalSku: 'asc' },
    ],
  });

  const rows = [];
  const seen = new Set<string>();
  for (const mapping of mappings) {
    const matchedSourceIds = new Set<string>();
    const skuKey = identifierKey(mapping.externalSku);
    const eanKey = identifierKey(mapping.externalEan);
    for (const sourceProductId of skuKey ? sourceIdsBySku.get(skuKey) ?? [] : []) matchedSourceIds.add(sourceProductId);
    for (const sourceProductId of eanKey ? sourceIdsByEan.get(eanKey) ?? [] : []) matchedSourceIds.add(sourceProductId);

    for (const sourceProductId of matchedSourceIds) {
      const sourceDetails = sourceDetailsById.get(sourceProductId);
      if (!sourceDetails) continue;
      const rowKey = `${sourceProductId}:${mapping.id}`;
      if (seen.has(rowKey)) continue;
      seen.add(rowKey);

      const matchBy = [];
      if (skuKey && sourceDetails.skus.some((sku) => identifierKey(sku) === skuKey)) matchBy.push('SKU');
      if (eanKey && sourceDetails.eans.some((ean) => identifierKey(ean) === eanKey)) matchBy.push('EAN');
      const lastKnownStock = decimalToNumber(mapping.lastKnownStock);

      rows.push({
        source,
        sourceProductId,
        sourceSku: sourceDetails.sku,
        sourceEan: sourceDetails.ean,
        sourceTitle: sourceDetails.title,
        sourcePrice: sourceDetails.price,
        sourceCurrency: sourceDetails.currency ?? 'PLN',
        sourceAvailability: sourceDetails.availability,
        sourceUrl: sourceDetails.url,
        sourceImageUrl: sourceDetails.imageUrl,
        mappingId: mapping.id,
        providerId: mapping.providerId,
        providerName: mapping.provider.name,
        externalSku: mapping.externalSku,
        externalEan: mapping.externalEan,
        externalName: mapping.externalName,
        externalCategory: mapping.externalCategory,
        lastKnownStock,
        lastKnownPrice: decimalToNumber(mapping.lastKnownPrice),
        imageUrl: wholesaleImageUrl(mapping),
        available: Boolean(lastKnownStock !== null && lastKnownStock > 0),
        matchBy,
        lastSyncAt: normalizeDateString(mapping.lastSyncAt),
      });
    }
  }

  rows.sort((a, b) => {
    if (b.available !== a.available) return b.available ? 1 : -1;
    const providerCompare = a.providerName.localeCompare(b.providerName, 'pl');
    if (providerCompare !== 0) return providerCompare;
    return (a.externalName ?? a.externalSku).localeCompare(b.externalName ?? b.externalSku, 'pl');
  });

  const total = rows.length;
  const offset = (page - 1) * limit;
  return {
    data: rows.slice(offset, offset + limit),
    total,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    summary: {
      sourceProducts: sourceProductIds.length,
      alreadyInSystem: alreadyInSystemIds.length,
      missingInSystem: missingSourceProductIds.length,
      withStoreProductData: sourceDetailsById.size,
      matchedWholesaleMappings: total,
    },
    warnings: warningsForSources([source], 'categories'),
  };
}

export async function getMatchDiagnostics(query: MatchDiagnosticsQuery = {}) {
  const tenantId = requireTenantId();
  const db = await ensureMongo();
  const limit = pageValue(query.limit, 100, MAX_LIST_LIMIT);
  const source = query.source && query.source !== 'ALL' ? query.source : undefined;
  const vatRate = await pricingVatRate(tenantId);
  const shopPresence = shopPresenceValue(query.shopPresence);

  if (query.shopId) await requireShop(tenantId, query.shopId);
  const where = productWhere(tenantId, {
    ...query,
    shopId: shopPresence === 'IN_SHOP' ? query.shopId : undefined,
  });
  if (query.shopId && shopPresence === 'MISSING_IN_SHOP') {
    where.shopProductMappings = { none: { shopId: query.shopId, isActive: true } };
  }
  if (query.categoryId) {
    if (!query.shopId) throw new ValidationError('Filtr kategorii konkurencji wymaga sklepu');
    if (!source) throw new ValidationError('Filtr kategorii konkurencji wymaga konkretnego zrodla');
    const categoryProductIds = await categoryMatchedWarehouseProductIds(
      db,
      tenantId,
      query.shopId,
      source,
      query.categoryId,
      shopPresence === 'IN_SHOP',
    );
    where.id = { in: categoryProductIds };
  }
  const [products, totalCandidates] = await Promise.all([
    prisma.warehouseProduct.findMany({
      where,
      include: productInclude,
      orderBy: { updatedAt: 'desc' },
      take: limit,
    }),
    prisma.warehouseProduct.count({ where }),
  ]);

  const mappings = await mappingMap(tenantId, query.shopId);
  const enriched = await Promise.all(products.map((product) =>
    enrichProduct(db, tenantId, product, {
      shopId: query.shopId,
      source,
      categoryId: query.categoryId,
      vatRate,
      mappings,
    })
  ));

  const byConfidence: Record<MatchConfidence, number> = { EAN: 0, SKU: 0, NAME: 0, NONE: 0 };
  const issues = emptyIssueCounts();
  const sourceCounts = new Map<string, number>();
  let totalOffers = 0;
  let withOffers = 0;
  let withCompetitorPrice = 0;
  let withCategorySuggestion = 0;
  let withCurrentCategory = 0;
  let withDescription = 0;
  let blockedBelowCost = 0;

  for (const product of enriched) {
    byConfidence[product.match.confidence] += 1;
    totalOffers += product.offers.length;
    if (product.offers.length > 0) withOffers += 1;
    if (product.priceStats.medianGross !== null) withCompetitorPrice += 1;
    if (product.categorySuggestions.length > 0) withCategorySuggestion += 1;
    if (product.currentCategories.length > 0) withCurrentCategory += 1;
    if (product.hasDescription) withDescription += 1;
    if (product.priceStats.blockedBelowCost) blockedBelowCost += 1;
    for (const issue of product.issues) issues[issue] += 1;
    for (const offer of product.offers) sourceCounts.set(offer.source, (sourceCounts.get(offer.source) ?? 0) + 1);
  }

  const analyzed = enriched.length;
  const matched = analyzed - byConfidence.NONE;
  const matchRatePercent = analyzed ? round2((matched / analyzed) * 100) : 0;

  return {
    totalCandidates,
    analyzed,
    limit,
    source: source ?? 'ALL',
    search: normalizeText(query.q) || null,
    match: {
      byConfidence,
      matched,
      unmatched: byConfidence.NONE,
      matchRatePercent,
    },
    offers: {
      withOffers,
      withCompetitorPrice,
      totalOffers,
      averageOffers: analyzed ? round2(totalOffers / analyzed) : 0,
      bySource: Array.from(sourceCounts.entries())
        .map(([sourceName, count]) => ({ source: sourceName, count }))
        .sort((a, b) => a.source.localeCompare(b.source)),
    },
    coverage: {
      withCurrentCategory,
      withCategorySuggestion,
      withDescription,
      blockedBelowCost,
    },
    issues,
    samples: {
      noMatch: enriched.filter((product) => product.match.confidence === 'NONE').slice(0, 8).map(diagnosticProduct),
      nameMatch: enriched.filter((product) => product.match.confidence === 'NAME').slice(0, 8).map(diagnosticProduct),
      withoutCompetitorPrice: enriched.filter((product) => product.priceStats.medianGross === null).slice(0, 8).map(diagnosticProduct),
    },
    warnings: [
      ...warningsForSources(selectedSources(source), 'prices'),
      ...(totalCandidates > analyzed ? [`Audyt pokazuje pierwsze ${analyzed} z ${totalCandidates} produktow pasujacych do filtrow.`] : []),
    ],
  };
}

export async function getProductDetail(warehouseProductId: string, query: { shopId?: string; source?: string } = {}) {
  const tenantId = requireTenantId();
  const db = await ensureMongo();
  if (query.shopId) await requireShop(tenantId, query.shopId);
  const product = await prisma.warehouseProduct.findFirst({
    where: { id: warehouseProductId, tenantId },
    include: productInclude,
  });
  if (!product) throw new NotFoundError('Produkt nie istnieje');
  const enriched = await enrichProduct(db, tenantId, product, {
    shopId: query.shopId,
    source: query.source && query.source !== 'ALL' ? query.source : undefined,
    vatRate: await pricingVatRate(tenantId),
  });
  return { ...serializeEnriched(enriched, true), warnings: warningsForSources(selectedSources(query.source), 'categories') };
}

export async function getCategoryTree(query: { source?: string; includeCounts?: boolean | string; shopId?: string } = {}) {
  const db = await ensureMongo();
  const source = query.source && query.source !== 'ALL' ? query.source : 'congee';
  if (!SOURCES.includes(source as any)) throw new ValidationError('Nieznane zrodlo konkurencji');
  const tenantId = query.shopId ? requireTenantId() : null;
  if (tenantId && query.shopId) await requireShop(tenantId, query.shopId);

  const categories = await db.collection('store_categories')
    .find({ source })
    .project({
      source_category_id: 1,
      parent_source_category_id: 1,
      name: 1,
      path: 1,
      depth: 1,
      product_list_url: 1,
      navigation_url: 1,
      canonical_url: 1,
    })
    .toArray();
  const counts = query.includeCounts === true || query.includeCounts === 'true'
    ? await db.collection('regular_product_categories').aggregate([
      { $match: { source } },
      { $group: { _id: '$category_id', products: { $addToSet: '$source_product_id' } } },
      { $project: { count: { $size: '$products' } } },
    ]).toArray()
    : [];
  const countMap = new Map(counts.map((row) => [String(row._id), Number(row.count ?? 0)]));
  const matchedCountMap = tenantId && query.shopId
    ? await categoryMatchedProductCounts(db, tenantId, query.shopId, source)
    : new Map<string, number>();
  const normalized = normalizeCategoryTree(categories, countMap, matchedCountMap);
  const dataWarnings = [];
  if (normalized.diagnostics.normalizedDepth > 0 || normalized.diagnostics.inferredParent > 0) {
    dataWarnings.push(
      `Drzewo kategorii ${source} zostalo skorygowane z path: ` +
      `${normalized.diagnostics.normalizedDepth} poziomow i ` +
      `${normalized.diagnostics.inferredParent} rodzicow.`
    );
  }
  if (normalized.diagnostics.ignoredInvalidParent > 0) {
    dataWarnings.push(`Pominieto ${normalized.diagnostics.ignoredInvalidParent} nieistniejacych rodzicow kategorii ${source}.`);
  }

  return {
    source,
    warnings: [...warningsForSources([source], 'categories'), ...dataWarnings],
    categories: normalized.nodes,
  };
}

export async function getCategoryMappings(query: CategoryMappingsQuery) {
  const tenantId = requireTenantId();
  await requireShop(tenantId, query.shopId);
  const rows = await prisma.competitorCategoryMapping.findMany({
    where: {
      tenantId,
      shopId: query.shopId,
      ...(query.source && query.source !== 'ALL' ? { source: query.source } : {}),
    },
    orderBy: [{ source: 'asc' }, { sourceCategoryPath: 'asc' }],
  });
  return rows.map((row) => ({
    id: row.id,
    shopId: row.shopId,
    source: row.source,
    sourceCategoryId: row.sourceCategoryId,
    sourceCategoryName: row.sourceCategoryName,
    sourceCategoryPath: row.sourceCategoryPath,
    targetCategoryId: row.targetCategoryId,
    targetCategoryName: row.targetCategoryName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function saveCategoryMappings(input: CategoryMappingInput) {
  const tenantId = requireTenantId();
  await requireShop(tenantId, input.shopId);
  if (!Array.isArray(input.mappings) || input.mappings.length === 0) {
    throw new ValidationError('Dodaj co najmniej jedno mapowanie kategorii');
  }

  const saved = [];
  for (const mapping of input.mappings.slice(0, MAX_BULK_PRODUCTS)) {
    if (!mapping.source || !mapping.sourceCategoryId || !mapping.targetCategoryId) {
      throw new ValidationError('Mapowanie wymaga zrodla, kategorii konkurencji i kategorii docelowej');
    }
    const sourceCategoryPath = Array.isArray(mapping.sourceCategoryPath)
      ? mapping.sourceCategoryPath.join(' > ')
      : mapping.sourceCategoryPath ?? null;
    saved.push(await prisma.competitorCategoryMapping.upsert({
      where: {
        tenantId_shopId_source_sourceCategoryId: {
          tenantId,
          shopId: input.shopId,
          source: mapping.source,
          sourceCategoryId: mapping.sourceCategoryId,
        },
      },
      create: {
        tenantId,
        shopId: input.shopId,
        source: mapping.source,
        sourceCategoryId: mapping.sourceCategoryId,
        sourceCategoryName: mapping.sourceCategoryName ?? null,
        sourceCategoryPath,
        targetCategoryId: mapping.targetCategoryId,
        targetCategoryName: mapping.targetCategoryName ?? null,
      },
      update: {
        sourceCategoryName: mapping.sourceCategoryName ?? null,
        sourceCategoryPath,
        targetCategoryId: mapping.targetCategoryId,
        targetCategoryName: mapping.targetCategoryName ?? null,
      },
    }));
  }

  return { saved: saved.length, mappings: saved };
}

export async function previewCategories(input: CategoryPreviewInput) {
  const tenantId = requireTenantId();
  const db = await ensureMongo();
  await requireShop(tenantId, input.shopId);
  if (input.source || input.sourceCategoryId) {
    if (!input.source || !input.sourceCategoryId) {
      throw new ValidationError('Walidacja zakresu wymaga zrodla i kategorii konkurencji');
    }
    if (!SOURCES.includes(input.source as any)) {
      throw new ValidationError('Nieznane zrodlo konkurencji');
    }
    const allowedProductIds = new Set(await categoryMatchedWarehouseProductIds(
      db,
      tenantId,
      input.shopId,
      input.source,
      input.sourceCategoryId,
      true,
    ));
    const outsideScope = input.productIds.filter((productId) => !allowedProductIds.has(productId));
    if (outsideScope.length > 0) {
      throw new ValidationError(
        `Zatrzymano zapis: ${outsideScope.length} produktow nie nalezy do wybranej kategorii konkurencji ${input.source} #${input.sourceCategoryId}.`
      );
    }
  }
  const products = await productsByIds(tenantId, input.productIds);
  const vatRate = await pricingVatRate(tenantId);

  const items = [];
  for (const product of products) {
    const enriched = await enrichProduct(db, tenantId, product, { shopId: input.shopId, vatRate });
    const suggestedIds = input.targetCategoryId
      ? [{ targetCategoryId: input.targetCategoryId, targetCategoryName: input.targetCategoryName ?? null }]
      : enriched.categorySuggestions;
    const targetCategoryIds = unique(suggestedIds.map((suggestion) => suggestion.targetCategoryId));
    const currentIds = enriched.currentCategories.map((category) => category.id);
    const nextCategoryIds = input.mode === 'REPLACE'
      ? targetCategoryIds
      : unique([...currentIds, ...targetCategoryIds]);

    items.push({
      warehouseProductId: product.id,
      sku: product.sku,
      name: product.name,
      status: targetCategoryIds.length ? 'READY' : enriched.match.confidence === 'NONE' ? 'NO_MATCH' : 'NO_MAPPING',
      mode: input.mode ?? 'ADD',
      currentCategories: enriched.currentCategories,
      targetCategoryIds,
      targetCategories: suggestedIds.map((suggestion) => ({
        id: suggestion.targetCategoryId,
        name: suggestion.targetCategoryName ?? null,
      })),
      nextCategoryIds,
      suggestions: enriched.categorySuggestions,
    });
  }

  return {
    requested: products.length,
    ready: items.filter((item) => item.status === 'READY').length,
    blocked: items.filter((item) => item.status !== 'READY').length,
    warnings: warningsForSources([...SOURCES], 'categories'),
    items,
  };
}

export async function applyCategories(input: CategoryPreviewInput) {
  const preview = await previewCategories(input);
  const result = {
    requested: preview.requested,
    updated: 0,
    failed: 0,
    preview,
    errors: [] as Array<{ warehouseProductId: string; message: string }>,
  };

  for (const item of preview.items.filter((entry) => entry.status === 'READY')) {
    try {
      const card = await productCardService.getProductCard(item.warehouseProductId, {
        shopId: input.shopId,
        sections: 'parameters',
      });
      const remote = card.remote as any;
      if (!remote?.hash) throw new Error('Brak snapshotu PrestaShop dla produktu');
      const currentIds = Array.isArray(remote.categories) ? remote.categories.map((category: any) => String(category.id)) : [];
      const nextCategoryIds = input.mode === 'REPLACE'
        ? item.targetCategoryIds
        : unique([...currentIds, ...item.targetCategoryIds]);
      if (nextCategoryIds.length === 0) throw new Error('Brak kategorii docelowej');
      const currentDefault = remote.identity?.idCategoryDefault ? String(remote.identity.idCategoryDefault) : '';
      const defaultCategoryId = nextCategoryIds.includes(currentDefault) ? currentDefault : nextCategoryIds[0];

      await productCardService.patchProductCardParameters(item.warehouseProductId, {
        shopId: input.shopId,
        expectedHash: remote.hash,
        identity: { idCategoryDefault: Number(defaultCategoryId) },
        categories: nextCategoryIds.map((categoryId) => Number(categoryId)),
      });
      result.updated += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push({
        warehouseProductId: item.warehouseProductId,
        message: error instanceof Error ? error.message : 'Nie udalo sie zapisac kategorii',
      });
    }
  }

  result.failed += preview.items.filter((entry) => entry.status !== 'READY').length;
  return result;
}

export async function previewPrices(input: PricePreviewInput) {
  const tenantId = requireTenantId();
  const db = await ensureMongo();
  await requireShop(tenantId, input.shopId);
  const productIds = input.items?.map((item) => item.warehouseProductId) ?? input.productIds;
  const products = await productsByIds(tenantId, productIds);
  const vatRate = await pricingVatRate(tenantId);
  const overrides = new Map((input.items ?? []).map((item) => [item.warehouseProductId, item.grossPrice]));

  const items = [];
  for (const product of products) {
    const enriched = await enrichProduct(db, tenantId, product, { shopId: input.shopId, vatRate });
    const overrideGross = overrides.get(product.id);
    const suggestedGross = typeof overrideGross === 'number' && Number.isFinite(overrideGross)
      ? overrideGross
      : enriched.priceStats.suggestedGross;
    const suggestedNet = grossToNetCeil(suggestedGross, vatRate);
    const blockedBelowCost = Boolean(enriched.costNet !== null && suggestedNet !== null && suggestedNet < enriched.costNet);
    const marketOfferCount = enriched.offers.filter((offer) => (
      typeof offer.price === 'number' && Number.isFinite(offer.price) && offer.price > 0
    )).length;
    const diffPercentVsCurrent = priceDiffPercent(enriched.currentGrossPrice, suggestedGross);
    const guardReasons: string[] = [];

    if (suggestedGross === null) {
      guardReasons.push('Brak ceny konkurencji do wyliczenia sugestii.');
    }
    if (blockedBelowCost) {
      guardReasons.push('Sugestia netto jest ponizej kosztu zakupu.');
    }
    if (suggestedGross !== null && marketOfferCount > 0 && marketOfferCount < MIN_PRICE_SAMPLE_OFFERS) {
      guardReasons.push(`Mala proba rynku: ${marketOfferCount} ofert cenowych, minimum ${MIN_PRICE_SAMPLE_OFFERS}.`);
    }
    if (diffPercentVsCurrent !== null && Math.abs(diffPercentVsCurrent) > PRICE_REVIEW_DIFF_PERCENT) {
      guardReasons.push(`Zmiana wzgledem obecnej ceny przekracza ${PRICE_REVIEW_DIFF_PERCENT}%.`);
    }

    const status: PricePreviewStatus = suggestedGross === null
      ? 'NO_COMPETITOR_PRICE'
      : blockedBelowCost
        ? 'BELOW_COST'
        : diffPercentVsCurrent !== null && Math.abs(diffPercentVsCurrent) > PRICE_REVIEW_DIFF_PERCENT
          ? 'LARGE_CHANGE'
          : marketOfferCount > 0 && marketOfferCount < MIN_PRICE_SAMPLE_OFFERS
            ? 'LOW_SAMPLE'
            : 'READY';

    items.push({
      warehouseProductId: product.id,
      sku: product.sku,
      name: product.name,
      currentGrossPrice: enriched.currentGrossPrice,
      minGross: enriched.priceStats.minGross,
      medianGross: enriched.priceStats.medianGross,
      maxGross: enriched.priceStats.maxGross,
      suggestedGross: round2(suggestedGross),
      suggestedNet,
      costNet: enriched.costNet,
      diffPercentVsCurrent,
      marketOfferCount,
      guardReasons,
      status,
      offers: enriched.offers.slice(0, 6),
    });
  }

  return {
    requested: products.length,
    ready: items.filter((item) => item.status === 'READY').length,
    blocked: items.filter((item) => item.status !== 'READY').length,
    vatRate,
    guardThresholds: {
      maxDiffPercent: PRICE_REVIEW_DIFF_PERCENT,
      minOfferCount: MIN_PRICE_SAMPLE_OFFERS,
    },
    warnings: warningsForSources([...SOURCES], 'prices'),
    items,
  };
}

export async function applyPrices(input: PriceApplyInput) {
  const tenantId = requireTenantId();
  const preview = await previewPrices(input);
  const appliedIds: string[] = [];
  const result = {
    requested: preview.requested,
    applied: 0,
    skipped: 0,
    enqueued: 0,
    preview,
    errors: [] as Array<{ warehouseProductId: string; message: string }>,
  };

  for (const item of preview.items) {
    if (item.status !== 'READY' || item.suggestedNet === null) {
      result.skipped += 1;
      result.errors.push({ warehouseProductId: item.warehouseProductId, message: item.status });
      continue;
    }

    const data = {
      level: 'PRODUCT',
      shopId: input.shopId,
      catalogId: null,
      priceGroupId: null,
      warehouseProductId: item.warehouseProductId,
      marginPercent: null,
      minProfit: null,
      fixedNetPrice: new Prisma.Decimal(item.suggestedNet),
      priceMode: 'FIXED',
      costCeilingEnabled: false,
      vatRate: new Prisma.Decimal(preview.vatRate),
      roundingMode: 'CENT',
      syncMode: 'CONFIRM',
      origin: 'COMPETITOR_MANUAL',
      isActive: true,
    };

    const existingRules = await prisma.warehousePricingRule.findMany({
      where: {
        tenantId,
        level: 'PRODUCT',
        warehouseProductId: item.warehouseProductId,
        shopId: input.shopId,
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (existingRules[0]) {
      await prisma.warehousePricingRule.update({ where: { id: existingRules[0].id }, data });
      if (existingRules.length > 1) {
        await prisma.warehousePricingRule.updateMany({
          where: { id: { in: existingRules.slice(1).map((rule) => rule.id) }, tenantId },
          data: { isActive: false },
        });
      }
    } else {
      await prisma.warehousePricingRule.create({ data: { tenantId, ...data } });
    }

    appliedIds.push(item.warehouseProductId);
    result.applied += 1;
  }

  if (appliedIds.length) {
    if (input.sync) {
      const synced = await pricingService.syncPricing({ productIds: appliedIds, shopIds: [input.shopId], triggeredBy: 'MANUAL' });
      result.enqueued = synced.enqueued;
      result.errors.push(...synced.errors.map((error) => ({
        warehouseProductId: error.warehouseProductId,
        message: error.message,
      })));
    } else {
      await pricingService.recalculatePricing({ productIds: appliedIds, shopIds: [input.shopId] });
    }
  }

  return result;
}

function competitorInspiration(offers: CompetitorOffer[]) {
  return offers
    .filter((offer) => offer.description || offer.shortDescription || offer.seoDescription || offer.parameters)
    .slice(0, 3)
    .map((offer) => [
      `Zrodlo: ${offer.source}`,
      `Tytul: ${offer.title ?? 'brak'}`,
      `Opis krotki: ${offer.shortDescription ?? 'brak'}`,
      `Opis dlugi: ${offer.description ?? 'brak'}`,
      `SEO: ${offer.seoTitle ?? ''} ${offer.seoDescription ?? ''}`.trim(),
      offer.parameters ? `Parametry: ${JSON.stringify(offer.parameters).slice(0, 1500)}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n---\n\n')
    .slice(0, 6000);
}

export async function createDescriptionAiProposals(input: DescriptionAiInput) {
  const tenantId = requireTenantId();
  const db = await ensureMongo();
  await requireShop(tenantId, input.shopId);
  const settings = await prisma.aiSettings.findUnique({ where: { tenantId } });
  const maxBatch = Math.min(MAX_BULK_PRODUCTS, settings?.maxBatchSize ?? 20);
  const products = await productsByIds(tenantId, input.productIds.slice(0, maxBatch));
  const proposals = [];

  for (const product of products) {
    const enriched = await enrichProduct(db, tenantId, product, { shopId: input.shopId });
    const snapshot = currentSnapshot(product, input.shopId)?.payloadJson as any;
    const inspiration = competitorInspiration(enriched.offers);
    if (!inspiration) {
      proposals.push({
        warehouseProductId: product.id,
        status: 'NO_INSPIRATION',
        message: 'Brak opisow konkurencji dla produktu',
      });
      continue;
    }

    try {
      const proposal = await aiContentProposalService.generateWarehouseProductContentProposal(product.id, {
        shopId: input.shopId,
        action: input.action ?? 'IMPROVE',
        templateId: input.templateId ?? null,
        imageUrl: input.includeImages === false ? null : enriched.offers.find((offer) => offer.imageUrls[0])?.imageUrls[0] ?? null,
        current: {
          name: snapshot?.identity?.name ?? product.name,
          shortDescriptionHtml: snapshot?.content?.shortDescriptionHtml ?? '',
          longDescriptionHtml: snapshot?.content?.longDescriptionHtml ?? '',
          metaTitle: snapshot?.seo?.metaTitle ?? '',
          metaDescription: snapshot?.seo?.metaDescription ?? '',
          linkRewrite: snapshot?.seo?.linkRewrite ?? '',
        },
        categories: currentCategories(product, input.shopId),
        features: [],
        inspiration,
      });
      proposals.push({
        warehouseProductId: product.id,
        status: 'READY',
        competitorSources: Array.from(new Set(enriched.offers.map((offer) => offer.source))),
        proposal,
      });
    } catch (error) {
      proposals.push({
        warehouseProductId: product.id,
        status: 'FAILED',
        message: error instanceof Error ? error.message : 'Nie udalo sie utworzyc propozycji AI',
      });
    }
  }

  return {
    requested: products.length,
    ready: proposals.filter((proposal) => proposal.status === 'READY').length,
    failed: proposals.filter((proposal) => proposal.status !== 'READY').length,
    maxBatch,
    proposals,
  };
}
