import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import { resolveProductsWhere, type ProductsWhereQuery } from './warehouse-products.service';
import { buildPrestaShopClient } from './shop-product-publication.service';
import { addWarehouseCleanupJob } from '../queue/warehouse-cleanup.queue';

/**
 * Porzadki w katalogu: jedna operacja zamiast dwoch osobnych masowek.
 *
 * Dotad "Usun produkty" ruszalo tylko baze panelu, a "Usun ze sklepu" tylko
 * PrestaShop - trzeba bylo pamietac o obu i o kolejnosci, po 500 pozycji, bez
 * podgladu skutkow. Tutaj selekcja idzie po filtrach listy (nie po liscie id,
 * bo 1842 produktow sie w niej nie miesci), skutki da sie policzyc przed
 * zmiana, a samo wykonanie leci paczkami w tle i zostawia raport.
 */

export type CleanupMode =
  /** PrestaShop: active = 0. Panel: produkt do archiwum. Domyslny i odwracalny. */
  | 'DEACTIVATE_ARCHIVE'
  /** DELETE w PrestaShop, produkt zostaje lokalnie na potrzeby dokumentow. */
  | 'SHOP_DELETE'
  /** DELETE w PrestaShop + usuniecie lokalne. Tylko pozycje bez historii. */
  | 'PURGE'
  /** Rozlaczenie produktu ze sklepem, bez ruszania PrestaShop. */
  | 'UNLINK';

export const CLEANUP_MODES: CleanupMode[] = ['DEACTIVATE_ARCHIVE', 'SHOP_DELETE', 'PURGE', 'UNLINK'];

/** Zamowienia, ktore jeszcze nie wyjechaly - takiego produktu nie ruszamy. */
const OPEN_ORDER_STATUSES = ['NEW', 'PAID', 'PROCESSING', 'PACKED'];

export const CLEANUP_BATCH_SIZE = 100;

export interface CleanupSelection {
  /** Wybor recznie zaznaczonych pozycji. */
  productIds?: string[];
  /** Wybor "wszystko, co pasuje do filtra" - bez limitu 500. */
  filters?: ProductsWhereQuery;
}

export interface CleanupInput {
  selection: CleanupSelection;
  mode: CleanupMode;
  shopId?: string;
  /** Trafia do archived_reason, zeby po miesiacu bylo wiadomo, co to bylo. */
  reason?: string;
}

export interface CleanupBlockers {
  openOrders: number;
  reservations: number;
  personalization: number;
}

export interface CleanupPreviewSampleItem {
  productId: string;
  sku: string;
  name: string;
  externalProductId: string | null;
  outcome: CleanupOutcome;
}

export type CleanupOutcome =
  | 'SHOP_DEACTIVATE_AND_ARCHIVE'
  | 'SHOP_DELETE'
  | 'PURGE'
  | 'ARCHIVE_INSTEAD_OF_PURGE'
  | 'UNLINK'
  | 'BLOCKED_OPEN_ORDER'
  | 'BLOCKED_RESERVATION'
  | 'BLOCKED_PERSONALIZATION';

export interface CleanupPreview {
  mode: CleanupMode;
  total: number;
  ready: number;
  /** Pozycje z historia: dostana archiwizacje zamiast twardego usuniecia. */
  willArchiveInstead: number;
  blocked: number;
  blockers: CleanupBlockers;
  effects: {
    shopDeactivate: number;
    shopDelete: number;
    archive: number;
    purge: number;
    unlinkMappings: number;
  };
  documentItems: number;
  sample: CleanupPreviewSampleItem[];
}

function requireTenantId() {
  const tenantId = getTenantId();
  if (!tenantId) throw new Error('Brak kontekstu tenanta');
  return tenantId;
}

function normalizeSelection(selection: CleanupSelection | undefined): CleanupSelection {
  const productIds = Array.from(new Set((selection?.productIds ?? []).map((id) => id.trim()).filter(Boolean)));
  const filters = selection?.filters;
  if (productIds.length === 0 && !filters) {
    throw new Error('Wybierz produkty albo filtry, na których ma działać czyszczenie');
  }
  return { productIds: productIds.length ? productIds : undefined, filters };
}

/**
 * Selekcja po filtrach zwraca same id, zeby dalsze kroki liczyly sie na
 * stabilnym zbiorze - lista w bazie moze sie zmienic w trakcie przebiegu.
 */
export async function resolveSelectionProductIds(
  selection: CleanupSelection,
  tenantId: string,
): Promise<string[]> {
  if (selection.productIds?.length) {
    const found = await prisma.warehouseProduct.findMany({
      where: { tenantId, id: { in: selection.productIds }, archivedAt: null },
      select: { id: true },
    });
    return found.map((product) => product.id);
  }

  // Ta sama sciezka, co lista - razem z prefiltrem surowego SQL. Inaczej zbior
  // do wyczyszczenia bylby szerszy niz to, co uzytkownik widzial na ekranie.
  const where = await resolveProductsWhere(selection.filters ?? {}, tenantId);
  const found = await prisma.warehouseProduct.findMany({
    where,
    select: { id: true },
    orderBy: { sku: 'asc' },
  });
  return found.map((product) => product.id);
}

export interface ProductFacts {
  openOrderIds: Set<string>;
  /** Rezerwacje ACTIVE - blokada, produktu nie ruszamy. */
  reservationIds: Set<string>;
  /**
   * Rezerwacje w dowolnym stanie. Relacja ma onDelete: Restrict, wiec nawet
   * zwolniona rezerwacja nie pozwoli skasowac produktu - taka pozycja moze
   * dostac najwyzej archiwizacje.
   */
  anyReservationIds: Set<string>;
  personalizationIds: Set<string>;
  documentItemIds: Set<string>;
  soldIds: Set<string>;
}

async function collectProductFacts(productIds: string[]): Promise<ProductFacts> {
  if (productIds.length === 0) {
    return {
      openOrderIds: new Set(),
      reservationIds: new Set(),
      anyReservationIds: new Set(),
      personalizationIds: new Set(),
      documentItemIds: new Set(),
      soldIds: new Set(),
    };
  }

  const [openOrders, reservations, anyReservations, personalization, documentItems, sold] = await Promise.all([
    prisma.orderItem.findMany({
      where: {
        warehouseProductId: { in: productIds },
        order: { operationalStatus: { in: OPEN_ORDER_STATUSES } },
      },
      distinct: ['warehouseProductId'],
      select: { warehouseProductId: true },
    }),
    prisma.warehouseReservation.findMany({
      where: { warehouseProductId: { in: productIds }, status: 'ACTIVE' },
      distinct: ['warehouseProductId'],
      select: { warehouseProductId: true },
    }),
    prisma.warehouseReservation.findMany({
      where: { warehouseProductId: { in: productIds } },
      distinct: ['warehouseProductId'],
      select: { warehouseProductId: true },
    }),
    prisma.shopProductMapping.findMany({
      where: {
        warehouseProductId: { in: productIds },
        isActive: true,
        personalizationTemplateId: { not: null },
      },
      distinct: ['warehouseProductId'],
      select: { warehouseProductId: true },
    }),
    prisma.warehouseDocumentItem.findMany({
      where: { productId: { in: productIds } },
      distinct: ['productId'],
      select: { productId: true },
    }),
    prisma.orderItem.findMany({
      where: { warehouseProductId: { in: productIds } },
      distinct: ['warehouseProductId'],
      select: { warehouseProductId: true },
    }),
  ]);

  const ids = (rows: Array<{ warehouseProductId: string | null }>) =>
    new Set(rows.map((row) => row.warehouseProductId).filter((id): id is string => Boolean(id)));

  return {
    openOrderIds: ids(openOrders),
    reservationIds: ids(reservations),
    anyReservationIds: ids(anyReservations),
    personalizationIds: ids(personalization),
    documentItemIds: new Set(documentItems.map((item) => item.productId)),
    soldIds: ids(sold),
  };
}

/**
 * Co sie stanie z jednym produktem. Blokady maja pierwszenstwo i zawsze koncza
 * sie brakiem zmiany; historia sprzedazy lub dokumentow nie blokuje, tylko
 * zamienia twarde usuniecie na archiwizacje.
 */
export function decideOutcome(productId: string, mode: CleanupMode, facts: ProductFacts): CleanupOutcome {
  if (facts.openOrderIds.has(productId)) return 'BLOCKED_OPEN_ORDER';
  if (facts.reservationIds.has(productId)) return 'BLOCKED_RESERVATION';
  if (facts.personalizationIds.has(productId)) return 'BLOCKED_PERSONALIZATION';

  if (mode === 'UNLINK') return 'UNLINK';
  if (mode === 'DEACTIVATE_ARCHIVE') return 'SHOP_DEACTIVATE_AND_ARCHIVE';
  if (mode === 'SHOP_DELETE') return 'SHOP_DELETE';

  // Historia to nie tylko sprzedaz: pozycja dokumentu i jakakolwiek rezerwacja
  // trzymaja produkt w bazie przez klucz obcy, wiec DELETE by sie wywalil.
  const hasHistory = facts.documentItemIds.has(productId)
    || facts.soldIds.has(productId)
    || facts.anyReservationIds.has(productId);
  return hasHistory ? 'ARCHIVE_INSTEAD_OF_PURGE' : 'PURGE';
}

const BLOCKED_OUTCOMES: CleanupOutcome[] = [
  'BLOCKED_OPEN_ORDER',
  'BLOCKED_RESERVATION',
  'BLOCKED_PERSONALIZATION',
];

export async function previewCleanup(input: CleanupInput): Promise<CleanupPreview> {
  const tenantId = requireTenantId();
  const selection = normalizeSelection(input.selection);
  const productIds = await resolveSelectionProductIds(selection, tenantId);
  const facts = await collectProductFacts(productIds);

  const outcomes = new Map<string, CleanupOutcome>();
  for (const productId of productIds) {
    outcomes.set(productId, decideOutcome(productId, input.mode, facts));
  }

  const countOf = (outcome: CleanupOutcome) =>
    Array.from(outcomes.values()).filter((value) => value === outcome).length;

  const blocked = Array.from(outcomes.values()).filter((value) => BLOCKED_OUTCOMES.includes(value)).length;
  const willArchiveInstead = countOf('ARCHIVE_INSTEAD_OF_PURGE');

  const mappingWhere: Prisma.ShopProductMappingWhereInput = {
    tenantId,
    isActive: true,
    warehouseProductId: { in: productIds.filter((id) => !BLOCKED_OUTCOMES.includes(outcomes.get(id)!)) },
    ...(input.shopId ? { shopId: input.shopId } : {}),
  };
  const mappingCount = productIds.length === 0 ? 0 : await prisma.shopProductMapping.count({ where: mappingWhere });

  const sampleIds = productIds.slice(0, 20);
  const sampleProducts = sampleIds.length === 0 ? [] : await prisma.warehouseProduct.findMany({
    where: { id: { in: sampleIds } },
    select: {
      id: true,
      sku: true,
      name: true,
      shopProductMappings: {
        where: { isActive: true, ...(input.shopId ? { shopId: input.shopId } : {}) },
        select: { externalProductId: true },
        take: 1,
      },
    },
  });

  const shopTouching = input.mode !== 'UNLINK';
  const archiveCount = countOf('SHOP_DEACTIVATE_AND_ARCHIVE') + willArchiveInstead;

  return {
    mode: input.mode,
    total: productIds.length,
    ready: productIds.length - blocked,
    willArchiveInstead,
    blocked,
    blockers: {
      openOrders: countOf('BLOCKED_OPEN_ORDER'),
      reservations: countOf('BLOCKED_RESERVATION'),
      personalization: countOf('BLOCKED_PERSONALIZATION'),
    },
    effects: {
      shopDeactivate: input.mode === 'DEACTIVATE_ARCHIVE' ? countOf('SHOP_DEACTIVATE_AND_ARCHIVE') : 0,
      shopDelete: shopTouching && input.mode !== 'DEACTIVATE_ARCHIVE'
        ? countOf('SHOP_DELETE') + countOf('PURGE') + willArchiveInstead
        : 0,
      archive: archiveCount,
      purge: countOf('PURGE'),
      unlinkMappings: mappingCount,
    },
    documentItems: facts.documentItemIds.size,
    sample: sampleProducts.map((product) => ({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      externalProductId: product.shopProductMappings[0]?.externalProductId ?? null,
      outcome: outcomes.get(product.id) ?? 'BLOCKED_OPEN_ORDER',
    })),
  };
}

/* ── Wykonanie ─────────────────────────────────────────────────────────── */

export interface StartCleanupInput extends CleanupInput {
  createdById?: string | null;
}

/**
 * Zapisuje przebieg i oddaje go kolejce. Sama operacja nie moze isc w requescie:
 * przy 1800 pozycjach kazda paczka to osobne wolania API sklepu, wiec HTTP
 * skonczyloby sie timeoutem w polowie roboty.
 */
export async function startCleanupRun(input: StartCleanupInput) {
  const tenantId = requireTenantId();
  const selection = normalizeSelection(input.selection);
  if (!CLEANUP_MODES.includes(input.mode)) throw new Error('Nieznany tryb czyszczenia');

  const preview = await previewCleanup({ ...input, selection });
  if (preview.total === 0) throw new Error('Selekcja jest pusta — nie ma czego czyścić');

  const run = await prisma.warehouseCleanupRun.create({
    data: {
      tenantId,
      shopId: input.shopId ?? null,
      mode: input.mode,
      status: 'PENDING',
      selectionJson: selection as unknown as Prisma.InputJsonValue,
      previewJson: preview as unknown as Prisma.InputJsonValue,
      total: preview.total,
      createdById: input.createdById ?? null,
    },
  });

  try {
    await addWarehouseCleanupJob({ runId: run.id, tenantId });
  } catch (error) {
    // Bez kolejki przebieg nigdy nie ruszy, wiec nie zostawiamy go w PENDING
    // udajac, ze cos sie dzieje.
    const message = error instanceof Error ? error.message : 'Nie udało się dodać zadania do kolejki';
    await prisma.warehouseCleanupRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', errorMessage: message, finishedAt: new Date() },
    });
    throw error;
  }

  return { run, preview };
}

interface CleanupProgress {
  processed: number;
  shopDeactivated: number;
  shopDeleted: number;
  archived: number;
  purged: number;
  unlinked: number;
  skipped: number;
  failed: number;
}

const BLOCK_REASONS: Record<string, string> = {
  BLOCKED_OPEN_ORDER: 'Otwarte zamówienie — pozycja została bez zmian',
  BLOCKED_RESERVATION: 'Aktywna rezerwacja stanu — pozycja została bez zmian',
  BLOCKED_PERSONALIZATION: 'Powiązany szablon personalizacji — pozycja została bez zmian',
};

/**
 * Cialo zadania w tle. Idzie paczkami, po kazdej sprawdza stopRequested i
 * dopisuje liczniki, zeby okno kreatora mialo co pokazywac na biezaco.
 */
export async function processCleanupRun(runId: string, tenantId: string) {
  const run = await prisma.warehouseCleanupRun.findFirst({ where: { id: runId, tenantId } });
  if (!run) throw new Error('Przebieg porządków nie znaleziony');
  if (run.status === 'RUNNING') return run;

  const selection = run.selectionJson as unknown as CleanupSelection;
  const mode = run.mode as CleanupMode;

  await prisma.warehouseCleanupRun.update({
    where: { id: run.id },
    data: { status: 'RUNNING', startedAt: new Date(), errorMessage: null },
  });

  const progress: CleanupProgress = {
    processed: 0,
    shopDeactivated: 0,
    shopDeleted: 0,
    archived: 0,
    purged: 0,
    unlinked: 0,
    skipped: 0,
    failed: 0,
  };

  try {
    const productIds = await resolveSelectionProductIds(selection, tenantId);
    await prisma.warehouseCleanupRun.update({
      where: { id: run.id },
      data: { total: productIds.length },
    });

    for (let offset = 0; offset < productIds.length; offset += CLEANUP_BATCH_SIZE) {
      const current = await prisma.warehouseCleanupRun.findFirst({
        where: { id: run.id, tenantId },
        select: { stopRequested: true },
      });
      if (current?.stopRequested) {
        await finishRun(run.id, 'STOPPED', progress);
        return prisma.warehouseCleanupRun.findFirst({ where: { id: run.id, tenantId } });
      }

      const batch = productIds.slice(offset, offset + CLEANUP_BATCH_SIZE);
      await processBatch(run.id, tenantId, batch, mode, run.shopId, progress);
      await prisma.warehouseCleanupRun.update({
        where: { id: run.id },
        data: { ...progress },
      });
    }

    await finishRun(run.id, 'DONE', progress);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Błąd przebiegu porządków';
    await prisma.warehouseCleanupRun.update({
      where: { id: run.id },
      data: { ...progress, status: 'FAILED', errorMessage: message, finishedAt: new Date() },
    });
    throw error;
  }

  return prisma.warehouseCleanupRun.findFirst({ where: { id: run.id, tenantId } });
}

async function finishRun(runId: string, status: 'DONE' | 'STOPPED', progress: CleanupProgress) {
  await prisma.warehouseCleanupRun.update({
    where: { id: runId },
    data: { ...progress, status, finishedAt: new Date() },
  });
}

async function processBatch(
  runId: string,
  tenantId: string,
  productIds: string[],
  mode: CleanupMode,
  shopId: string | null,
  progress: CleanupProgress,
) {
  const facts = await collectProductFacts(productIds);
  const products = await prisma.warehouseProduct.findMany({
    where: { id: { in: productIds }, tenantId },
    select: {
      id: true,
      sku: true,
      name: true,
      shopProductMappings: {
        where: { isActive: true, ...(shopId ? { shopId } : {}) },
        include: { shop: true },
      },
    },
  });

  for (const product of products) {
    const outcome = decideOutcome(product.id, mode, facts);
    const externalProductId = product.shopProductMappings[0]?.externalProductId ?? null;

    if (BLOCKED_OUTCOMES.includes(outcome)) {
      progress.skipped++;
      progress.processed++;
      await recordItem(runId, tenantId, product, externalProductId, 'SKIPPED', outcome, BLOCK_REASONS[outcome]);
      continue;
    }

    try {
      await applyOutcome(product, outcome, progress);
      progress.processed++;
      await recordItem(runId, tenantId, product, externalProductId, 'DONE', outcome, null);
    } catch (error) {
      progress.failed++;
      progress.processed++;
      const message = error instanceof Error ? error.message : 'Nieznany błąd';
      await recordItem(runId, tenantId, product, externalProductId, 'FAILED', outcome, message);
    }
  }
}

type ProductForCleanup = {
  id: string;
  sku: string;
  name: string;
  shopProductMappings: Array<Prisma.ShopProductMappingGetPayload<{ include: { shop: true } }>>;
};

async function applyOutcome(product: ProductForCleanup, outcome: CleanupOutcome, progress: CleanupProgress) {
  const mappings = product.shopProductMappings;

  if (outcome === 'UNLINK') {
    if (mappings.length) {
      await prisma.shopProductMapping.updateMany({
        where: { id: { in: mappings.map((mapping) => mapping.id) } },
        data: { isActive: false, lastSyncAt: new Date() },
      });
    }
    progress.unlinked += mappings.length;
    return;
  }

  const deactivate = outcome === 'SHOP_DEACTIVATE_AND_ARCHIVE';
  // Warianty dziela id produktu-rodzica w PrestaShop, wiec wolanie API robimy
  // raz na (sklep, id_product), a nie raz na mapowanie.
  const remoteTargets = new Map<string, { shop: ProductForCleanup['shopProductMappings'][number]['shop']; externalProductId: string }>();
  for (const mapping of mappings) {
    remoteTargets.set(`${mapping.shopId}:${mapping.externalProductId}`, {
      shop: mapping.shop,
      externalProductId: mapping.externalProductId,
    });
  }

  for (const target of remoteTargets.values()) {
    const client = buildPrestaShopClient(target.shop);
    if (deactivate) {
      await client.setProductActive(target.externalProductId, false);
      progress.shopDeactivated++;
    } else {
      await client.deleteProduct(target.externalProductId);
      progress.shopDeleted++;
    }
  }

  const mappingIds = mappings.map((mapping) => mapping.id);
  const now = new Date();

  if (deactivate) {
    if (mappingIds.length) {
      await prisma.shopProductMapping.updateMany({
        where: { id: { in: mappingIds } },
        // Mapowanie zostaje zywe: produkt dalej jest w sklepie, tylko zgaszony.
        data: { externalActive: false, externalActiveSyncedAt: now, lastSyncAt: now },
      });
    }
    await archiveProduct(product.id, 'Porządki w katalogu');
    progress.archived++;
    return;
  }

  if (mappingIds.length) {
    await prisma.shopProductMapping.updateMany({
      where: { id: { in: mappingIds } },
      // Produktu nie ma juz w sklepie - mapowanie jest zerwane.
      data: { isActive: false, externalActive: false, externalActiveSyncedAt: now, lastSyncAt: now },
    });
  }

  if (outcome === 'SHOP_DELETE') return;

  if (outcome === 'ARCHIVE_INSTEAD_OF_PURGE') {
    await archiveProduct(product.id, 'Porządki w katalogu — pozycja z historią');
    progress.archived++;
    return;
  }

  await prisma.warehouseProduct.delete({ where: { id: product.id } });
  progress.purged++;
}

async function archiveProduct(productId: string, reason: string) {
  await prisma.warehouseProduct.update({
    where: { id: productId },
    data: { archivedAt: new Date(), archivedReason: reason, isActive: false },
  });
}

async function recordItem(
  runId: string,
  tenantId: string,
  product: { id: string; sku: string; name: string },
  externalProductId: string | null,
  status: 'DONE' | 'SKIPPED' | 'FAILED',
  action: CleanupOutcome,
  message: string | null,
) {
  await prisma.warehouseCleanupRunItem.create({
    data: {
      runId,
      tenantId,
      // Przy PURGE produktu juz nie ma, wiec nie wiazemy go z pozycja logu.
      warehouseProductId: status === 'DONE' && action === 'PURGE' ? null : product.id,
      sku: product.sku,
      name: product.name,
      externalProductId,
      status,
      action,
      message,
    },
  });
}

/* ── Historia porzadkow ────────────────────────────────────────────────── */

export interface CleanupRunsQuery {
  page?: number;
  limit?: number;
  status?: string;
}

export async function listCleanupRuns(query: CleanupRunsQuery = {}) {
  const tenantId = requireTenantId();
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));

  const where: Prisma.WarehouseCleanupRunWhereInput = { tenantId };
  if (query.status) where.status = query.status;

  const [data, total] = await Promise.all([
    prisma.warehouseCleanupRun.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        shop: { select: { id: true, name: true } },
        createdBy: { select: { id: true, email: true, name: true } },
      },
    }),
    prisma.warehouseCleanupRun.count({ where }),
  ]);

  return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
}

export async function getCleanupRun(runId: string) {
  const tenantId = requireTenantId();
  const run = await prisma.warehouseCleanupRun.findFirst({
    where: { id: runId, tenantId },
    include: {
      shop: { select: { id: true, name: true } },
      createdBy: { select: { id: true, email: true, name: true } },
    },
  });
  if (!run) throw new Error('Przebieg porządków nie znaleziony');

  // Do okna kreatora wystarczy garstka bledow - reszta jest w raporcie CSV.
  const failedItems = await prisma.warehouseCleanupRunItem.findMany({
    where: { runId, status: 'FAILED' },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });
  const failedTotal = await prisma.warehouseCleanupRunItem.count({ where: { runId, status: 'FAILED' } });

  return { run, failedItems, failedTotal };
}

export async function stopCleanupRun(runId: string) {
  const tenantId = requireTenantId();
  const run = await prisma.warehouseCleanupRun.findFirst({ where: { id: runId, tenantId } });
  if (!run) throw new Error('Przebieg porządków nie znaleziony');
  if (run.status !== 'RUNNING' && run.status !== 'PENDING') return run;

  return prisma.warehouseCleanupRun.update({
    where: { id: run.id },
    data: { stopRequested: true },
  });
}

/**
 * Ponowienie bierze wylacznie pozycje, ktore poleglly na bledzie - pominiete
 * przez blokade zostaja pominiete, bo blokada sama z siebie nie znika.
 */
export async function retryFailedCleanupItems(runId: string, createdById?: string | null) {
  const tenantId = requireTenantId();
  const run = await prisma.warehouseCleanupRun.findFirst({ where: { id: runId, tenantId } });
  if (!run) throw new Error('Przebieg porządków nie znaleziony');

  const failedItems = await prisma.warehouseCleanupRunItem.findMany({
    where: { runId, status: 'FAILED', warehouseProductId: { not: null } },
    select: { warehouseProductId: true },
  });
  const productIds = Array.from(new Set(
    failedItems.map((item) => item.warehouseProductId).filter((id): id is string => Boolean(id)),
  ));
  if (productIds.length === 0) throw new Error('Brak pozycji do ponowienia');

  return startCleanupRun({
    selection: { productIds },
    mode: run.mode as CleanupMode,
    shopId: run.shopId ?? undefined,
    createdById,
  });
}

const CSV_HEADER = 'sku;nazwa;id_prestashop;status;akcja;komunikat';

function csvCell(value: string | null | undefined) {
  const text = (value ?? '').replace(/"/g, '""');
  return /[;"\n]/.test(text) ? `"${text}"` : text;
}

export async function exportCleanupRunCsv(runId: string) {
  const tenantId = requireTenantId();
  const run = await prisma.warehouseCleanupRun.findFirst({ where: { id: runId, tenantId } });
  if (!run) throw new Error('Przebieg porządków nie znaleziony');

  const items = await prisma.warehouseCleanupRunItem.findMany({
    where: { runId },
    orderBy: { createdAt: 'asc' },
  });

  const rows = items.map((item) => [
    csvCell(item.sku),
    csvCell(item.name),
    csvCell(item.externalProductId),
    csvCell(item.status),
    csvCell(item.action),
    csvCell(item.message),
  ].join(';'));

  return { filename: `porzadki-${run.id}.csv`, csv: [CSV_HEADER, ...rows].join('\n') };
}

/* ── Archiwum ──────────────────────────────────────────────────────────── */

export async function restoreArchivedProducts(productIds: string[]) {
  const tenantId = requireTenantId();
  const ids = Array.from(new Set((productIds ?? []).map((id) => id.trim()).filter(Boolean)));
  if (ids.length === 0) throw new Error('Lista produktów jest wymagana');

  const result = await prisma.warehouseProduct.updateMany({
    where: { tenantId, id: { in: ids }, archivedAt: { not: null } },
    // Produkt wraca na listy i do synchronizacji; w sklepie zostaje wylaczony,
    // dopoki ktos go swiadomie nie wlaczy.
    data: { archivedAt: null, archivedReason: null, isActive: true },
  });

  return { requested: ids.length, restored: result.count };
}
