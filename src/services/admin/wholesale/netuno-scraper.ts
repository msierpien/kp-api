/// <reference lib="dom" />
/**
 * Scraper katalogu hurtowni Netuno (PrestaShop 9).
 *
 * Netuno nie udostepnia feedu, ale kazda karta produktu ma endpoint
 * `?ajax=1&action=refresh`, ktory oddaje komplet danych w ~58 KB zamiast
 * ~370 KB pelnej strony. Zrodlem prawdy jest atrybut `data-product` -
 * strukturalny JSON produktu, a nie tekst strony.
 *
 * Wynik idzie do CSV zgodnego z presetem NETUNO (patrz shared.ts), ktory
 * konsumuje zwykly pipeline CSV_FEED.
 */
import { createLogger } from '../../../lib/logger';

const logger = createLogger('netuno-scraper');

const USER_AGENT = 'Mozilla/5.0 (compatible; KP-WarehouseBot/1.0)';
const DEFAULT_DELAY_MS = 250;
const MAX_CATEGORY_PAGES = 40;
const FETCH_RETRIES = 3;

/**
 * Produkt promocyjny, ktory Netuno doklada do listingu KAZDEJ kategorii.
 * Bez tego filtra kategoria deklarujaca 56 pozycji zwraca 57.
 */
const PROMO_NOISE = /papier-pakowy-brazowy-rola-50g-440x50mb/;

/** Cechy Netuno warte osobnej kolumny. Reszta ladu­je w `features_json`. */
const FEATURE_COLUMNS: Record<string, string> = {
  'Format koperty': 'format',
  Kolor: 'kolor',
  Gramatura: 'gramatura',
  'Kolor producenta': 'kolor_producenta',
  Marka: 'marka',
  'Rodzaj wykończenia': 'wykonczenie',
  'Rodzaj klejenia': 'klejenie',
  'Rodzaj zamknięcia': 'zamkniecie',
};

export interface NetunoPriceTier {
  fromQuantity: number;
  priceNet: number;
}

/** Fragment `data-product` z karty produktu - tylko pola, ktorych realnie uzywamy. */
interface NetunoProductPayload {
  id_product?: string | number;
  id?: string | number;
  reference?: string;
  name?: string;
  description?: string;
  quantity?: number;
  price_tax_exc?: string | number;
  price_amount?: string | number;
  minimal_quantity?: string | number;
  category_name?: string;
  manufacturer_name?: string;
  date_upd?: string;
  features?: Array<{ name?: string; value?: string }>;
  images?: Array<{ bySize?: { large_default?: { url?: string } } }>;
  quantity_discounts?: Array<Record<string, unknown>>;
}

export interface NetunoProduct {
  url: string;
  idProduct: string;
  reference: string | null;
  ean: string | null;
  name: string;
  stock: number | null;
  /** Cena katalogowa netto za jedna jednostke sprzedazy. */
  priceNet: number | null;
  priceGross: number | null;
  tiers: NetunoPriceTier[];
  packSize: number | null;
  minQty: number | null;
  category: string | null;
  brand: string | null;
  description: string;
  images: string[];
  features: Record<string, string>;
  updatedAt: string | null;
}

export interface NetunoScrapeResult {
  products: NetunoProduct[];
  /** Liczba pozycji zadeklarowana przez listing kategorii (do kontroli kompletnosci). */
  declared: number | null;
  visited: number;
  failed: Array<{ url: string; error: string }>;
  /** Ten sam Indeks na dwoch produktach - blad po stronie Netuno, zglaszamy zamiast ukrywac. */
  duplicates: Array<{ reference: string; urls: [string, string] }>;
}

export interface NetunoScrapeOptions {
  /** Opoznienie miedzy zadaniami w ms. Nizej niz 100 nie schodzimy. */
  delayMs?: number;
  /** Limit produktow - do testow, bez tego bierze cala kategorie. */
  limit?: number;
  onProgress?: (done: number, total: number) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function unescapeHtml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function plain(value: unknown) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Zbiera adresy kart produktow z listingu kategorii (wraz z podkategoriami). */
export async function listCategoryProducts(
  categoryUrl: string,
  delayMs = DEFAULT_DELAY_MS,
): Promise<{ urls: string[]; declared: number | null }> {
  const found = new Set<string>();
  let declared: number | null = null;
  let page = 1;

  while (page <= MAX_CATEGORY_PAGES) {
    const url = `${categoryUrl}?resultsPerPage=100${page > 1 ? `&page=${page}` : ''}`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) throw new Error(`Listing kategorii ${url}: HTTP ${response.status}`);
    const html = await response.text();

    if (declared === null) {
      const match = html.match(/>\s*(\d+)\s+produkt\w*/);
      if (match) declared = Number(match[1]);
    }

    const links = [...html.matchAll(/https:\/\/netuno\.pl\/[^"'\s]+?-(\d+)\.html/g)]
      .map((match) => match[0])
      .filter((link) => !PROMO_NOISE.test(link));

    const before = found.size;
    links.forEach((link) => found.add(link));

    if (links.length === 0) break;
    if (found.size === before && page > 1) break;
    if (declared !== null && found.size >= declared) break;

    page++;
    await sleep(delayMs);
  }

  return { urls: [...found], declared };
}

/**
 * Netuno wyraza prog ilosciowy na dwa sposoby: stala cena albo rabat.
 * Gdy progiem jest rabat, PrestaShop zapisuje `price: -1` jako marker -
 * wzieta doslownie dawalaby ujemna cene zakupu.
 */
function resolveTierPrice(
  discount: Record<string, unknown>,
  basePriceNet: number | null,
): number | null {
  const fixed = Number(discount.price);
  if (fixed > 0) return fixed;
  if (basePriceNet === null) return null;

  const reduction = Number(discount.reduction) || 0;
  if (discount.reduction_type === 'percentage') return basePriceNet * (1 - reduction);
  if (discount.reduction_type === 'amount') return basePriceNet - reduction;
  return null;
}

export function parseNetunoProduct(payload: Record<string, unknown>, url: string): NetunoProduct {
  const detailsHtml = String(payload.product_details ?? '');
  const match = detailsHtml.match(/data-product="([^"]+)"/);
  if (!match) throw new Error('brak atrybutu data-product w odpowiedzi');

  const product = JSON.parse(unescapeHtml(match[1])) as NetunoProductPayload;
  const basePriceNet = Number(product.price_tax_exc) || null;

  // EAN nie wystepuje w data-product - renderuje sie wylacznie w tabeli cech.
  const ean = (plain(detailsHtml).match(/EAN\s+(\d{8,14})/) || [])[1] ?? null;

  const features: Record<string, string> = {};
  for (const feature of product.features ?? []) {
    features[String(feature.name)] = plain(unescapeHtml(String(feature.value)));
  }

  const tiers = ((product.quantity_discounts ?? []) as Array<Record<string, unknown>>)
    .map((discount) => {
      const priceNet = resolveTierPrice(discount, basePriceNet);
      return {
        fromQuantity: Number(discount.from_quantity),
        priceNet: priceNet === null ? null : Number(priceNet.toFixed(4)),
      };
    })
    .filter((tier): tier is NetunoPriceTier =>
      tier.priceNet !== null && tier.priceNet > 0 && Number.isFinite(tier.fromQuantity))
    .sort((a, b) => a.fromQuantity - b.fromQuantity);

  const images = (product.images ?? [])
    .map((image) => image?.bySize?.large_default?.url)
    .filter((imageUrl): imageUrl is string => typeof imageUrl === 'string');

  return {
    url,
    idProduct: String(product.id_product ?? product.id ?? ''),
    reference: product.reference || null,
    ean,
    name: plain(product.name),
    stock: typeof product.quantity === 'number' ? product.quantity : null,
    priceNet: basePriceNet,
    priceGross: Number(product.price_amount) || null,
    tiers,
    packSize: Number(features['Opakowanie zbiorcze']) || null,
    minQty: Number(product.minimal_quantity) || null,
    category: product.category_name || null,
    brand: product.manufacturer_name || null,
    description: plain(product.description),
    images,
    features,
    updatedAt: product.date_upd || null,
  };
}

async function fetchProduct(url: string, delayMs: number): Promise<NetunoProduct> {
  let lastError = 'nieznany błąd';

  for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
    try {
      const response = await fetch(`${url}?ajax=1&action=refresh`, {
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseNetunoProduct((await response.json()) as Record<string, unknown>, url);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < FETCH_RETRIES - 1) await sleep(delayMs * 6 * (attempt + 1));
    }
  }

  throw new Error(lastError);
}

export async function scrapeNetunoCategory(
  categoryUrl: string,
  options: NetunoScrapeOptions = {},
): Promise<NetunoScrapeResult> {
  const delayMs = Math.max(100, options.delayMs ?? DEFAULT_DELAY_MS);
  const { urls, declared } = await listCategoryProducts(categoryUrl, delayMs);
  const targets = options.limit ? urls.slice(0, options.limit) : urls;

  logger.info({ categoryUrl, declared, targets: targets.length }, 'Start scrapowania kategorii Netuno');

  const bySku = new Map<string, NetunoProduct>();
  const failed: NetunoScrapeResult['failed'] = [];
  const duplicates: NetunoScrapeResult['duplicates'] = [];

  for (const [index, url] of targets.entries()) {
    try {
      const product = await fetchProduct(url, delayMs);
      if (!product.reference || product.stock === null) {
        failed.push({ url, error: 'brak indeksu lub stanu' });
      } else {
        const existing = bySku.get(product.reference);
        if (existing) duplicates.push({ reference: product.reference, urls: [existing.url, url] });
        else bySku.set(product.reference, product);
      }
    } catch (error) {
      failed.push({ url, error: error instanceof Error ? error.message : String(error) });
    }

    options.onProgress?.(index + 1, targets.length);
    await sleep(delayMs);
  }

  const products = [...bySku.values()].sort((a, b) =>
    (a.reference ?? '').localeCompare(b.reference ?? ''));

  logger.info(
    { categoryUrl, products: products.length, failed: failed.length, duplicates: duplicates.length },
    'Scrapowanie Netuno zakończone',
  );

  return { products, declared, visited: targets.length, failed, duplicates };
}

function csvEscape(value: unknown, separator: string) {
  const text = value === null || value === undefined ? '' : String(value);
  const needsQuotes = text.includes(separator) || text.includes('"') || text.includes('\n');
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Buduje CSV zgodny z presetem NETUNO (delimiter ';'). */
export function buildNetunoCsv(products: NetunoProduct[], separator = ';') {
  const featureColumns = Object.values(FEATURE_COLUMNS);
  const header = [
    'reference', 'ean', 'name', 'stock', 'price_net', 'price_best_tier', 'tier_from',
    'tiers_json', 'pack_size', 'min_qty', 'category', 'brand', 'description', 'photos',
    ...featureColumns, 'features_json', 'url',
  ];

  const rows = products.map((product) => {
    const bestTier = product.tiers.length ? product.tiers[product.tiers.length - 1] : null;
    const featureValues = Object.keys(FEATURE_COLUMNS).map((label) => product.features[label] ?? '');

    return [
      product.reference,
      product.ean,
      product.name,
      product.stock,
      product.priceNet,
      bestTier?.priceNet ?? '',
      bestTier?.fromQuantity ?? '',
      product.tiers.map((tier) => `${tier.fromQuantity}:${tier.priceNet}`).join(','),
      product.packSize ?? '',
      product.minQty ?? '',
      product.category,
      product.brand,
      product.description,
      product.images.join(','),
      ...featureValues,
      JSON.stringify(product.features),
      product.url,
    ].map((value) => csvEscape(value, separator)).join(separator);
  });

  return [header.join(separator), ...rows].join('\n');
}
