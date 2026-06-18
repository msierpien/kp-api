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
  page?: number | string;
  limit?: number | string;
}

export interface MatchDiagnosticsQuery {
  shopId?: string;
  q?: string;
  source?: string;
  categoryId?: string;
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
const PARTYBOX_WARNING =
  'Partybox jest niekompletny: ceny i opisy sa dostepne, ale kategorie Partybox nie powinny byc traktowane jako pelne drzewo.';

const productInclude = {
  barcodes: { where: { isActive: true }, orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }] },
  shopProductMappings: { where: { isActive: true }, include: { shop: true } },
  shopPrices: true,
  productChannelSnapshots: true,
} satisfies Prisma.WarehouseProductInclude;

type ProductForAnalytics = Prisma.WarehouseProductGetPayload<{ include: typeof productInclude }>;

type MatchConfidence = 'EAN' | 'SKU' | 'NAME' | 'NONE';

interface CompetitorCategory {
  id: string;
  path: string[];
  url: string | null;
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

function decimalToNumber(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round2(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
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

async function matchedWarehouseProductIdsBySourceProduct(db: Db, tenantId: string, shopId: string, source: string) {
  const warehouseProducts = await prisma.warehouseProduct.findMany({
    where: productWhere(tenantId, { shopId }),
    select: {
      id: true,
      sku: true,
      barcodes: {
        where: { isActive: true },
        select: { ean: true },
      },
      shopProductMappings: {
        where: { shopId, isActive: true },
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

  const storeProducts = await db.collection('store_products')
    .find({ source })
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

async function categoryMatchedWarehouseProductIds(db: Db, tenantId: string, shopId: string, source: string, categoryId: string) {
  const matchedProductIdsBySourceProduct = await matchedWarehouseProductIdsBySourceProduct(db, tenantId, shopId, source);
  if (matchedProductIdsBySourceProduct.size === 0) return [];
  const numericCategoryId = Number(categoryId);
  const categoryIdFilter = Number.isFinite(numericCategoryId)
    ? { $in: [categoryId, numericCategoryId] }
    : categoryId;

  const categoryRows = await db.collection('regular_product_categories')
    .find({ source, category_id: categoryIdFilter })
    .project({ source_product_id: 1 })
    .toArray();

  const productIds = new Set<string>();
  for (const row of categoryRows) {
    const sourceProductId = normalizedIdentifier(row.source_product_id);
    const matchedProductIds = sourceProductId ? matchedProductIdsBySourceProduct.get(sourceProductId) : null;
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
  return decimalToNumber(product.averagePurchaseCost) ?? decimalToNumber(product.purchasePrice);
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
  const suggestedNet = suggestedGross === null ? null : round2(suggestedGross / (1 + vatRate / 100));
  const diffPercentVsCurrent = currentGross && suggestedGross
    ? round2(((currentGross - suggestedGross) / suggestedGross) * 100)
    : null;

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

function normalizeOffer(
  row: any,
  categories: CompetitorCategory[] = [],
  bundleItems: CompetitorBundleItem[] = [],
): CompetitorOffer {
  return {
    id: String(row._id),
    source: String(row.source ?? ''),
    sourceProductId: String(row.source_product_id ?? ''),
    sku: normalizedIdentifier(row.store_sku),
    ean: normalizedIdentifier(row.store_ean),
    title: normalizedIdentifier(row.title),
    price: decimalToNumber(row.price),
    currency: normalizeText(row.currency) || 'PLN',
    availability: normalizedIdentifier(row.availability),
    url: normalizedIdentifier(row.product_url),
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
    .filter((row) => row.source && row.source_product_id)
    .slice(0, 200);

  if (keys.length === 0) return rows.map((row) => normalizeOffer(row));

  const [categoryRows, bundleRows] = await Promise.all([
    db.collection('regular_product_categories')
      .find({ $or: keys })
      .project({ source: 1, source_product_id: 1, category_id: 1, category_path: 1, category_url: 1 })
      .toArray(),
    db.collection('store_product_bundle_items')
      .find({ $or: keys })
      .limit(1000)
      .toArray(),
  ]);
  const byOffer = new Map<string, CompetitorCategory[]>();
  const bundlesByOffer = new Map<string, CompetitorBundleItem[]>();

  for (const row of categoryRows) {
    const key = `${row.source}:${row.source_product_id}`;
    const list = byOffer.get(key) ?? [];
    list.push({
      id: String(row.category_id),
      path: Array.isArray(row.category_path) ? row.category_path.map(String) : [],
      url: normalizedIdentifier(row.category_url),
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
  } = {},
): Promise<EnrichedProduct> {
  const match = await findCompetitorOffers(db, product, options.source, options.categoryId);
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
    offerCount: product.offers.length,
    sources: Array.from(new Set(product.offers.map((offer) => offer.source))),
    offers: includeOffers ? product.offers : undefined,
  };
}

async function pricingVatRate(tenantId: string) {
  const settings = await prisma.warehousePricingSettings.findUnique({ where: { tenantId } });
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

  if (query.shopId) await requireShop(tenantId, query.shopId);
  const where = productWhere(tenantId, query);
  if (query.categoryId) {
    if (!query.shopId) throw new ValidationError('Filtr kategorii konkurencji wymaga sklepu');
    if (!source) throw new ValidationError('Filtr kategorii konkurencji wymaga konkretnego zrodla');
    const categoryProductIds = await categoryMatchedWarehouseProductIds(db, tenantId, query.shopId, source, query.categoryId);
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

    const enriched = await Promise.all(products.map((product) =>
      enrichProduct(db, tenantId, product, { shopId: query.shopId, source, categoryId: query.categoryId, vatRate, mappings })
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

    const enriched = await Promise.all(products.map((product) =>
      enrichProduct(db, tenantId, product, { shopId: query.shopId, source, categoryId: query.categoryId, vatRate, mappings })
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

export async function getMatchDiagnostics(query: MatchDiagnosticsQuery = {}) {
  const tenantId = requireTenantId();
  const db = await ensureMongo();
  const limit = pageValue(query.limit, 100, MAX_LIST_LIMIT);
  const source = query.source && query.source !== 'ALL' ? query.source : undefined;
  const vatRate = await pricingVatRate(tenantId);

  if (query.shopId) await requireShop(tenantId, query.shopId);
  const where = productWhere(tenantId, query);
  if (query.categoryId) {
    if (!query.shopId) throw new ValidationError('Filtr kategorii konkurencji wymaga sklepu');
    if (!source) throw new ValidationError('Filtr kategorii konkurencji wymaga konkretnego zrodla');
    const categoryProductIds = await categoryMatchedWarehouseProductIds(db, tenantId, query.shopId, source, query.categoryId);
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
    const suggestedNet = suggestedGross === null ? null : round2(suggestedGross / (1 + vatRate / 100));
    const blockedBelowCost = Boolean(enriched.costNet !== null && suggestedNet !== null && suggestedNet < enriched.costNet);
    const status = suggestedGross === null
      ? 'NO_COMPETITOR_PRICE'
      : blockedBelowCost
        ? 'BELOW_COST'
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
      diffPercentVsCurrent: enriched.priceStats.diffPercentVsCurrent,
      status,
      offers: enriched.offers.slice(0, 6),
    });
  }

  return {
    requested: products.length,
    ready: items.filter((item) => item.status === 'READY').length,
    blocked: items.filter((item) => item.status !== 'READY').length,
    vatRate,
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
      costCeilingEnabled: true,
      vatRate: new Prisma.Decimal(preview.vatRate),
      roundingMode: 'CENT',
      syncMode: 'CONFIRM',
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
