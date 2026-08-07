import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/encryption';
import { getTenantId } from '../../lib/tenant-context';
import { PrestaShopClient } from '../prestashop/prestashop-client';
import { cancelDocument, createWzForOrder, shouldAutoCreateWzForTenant } from './warehouse-documents.service';
import { reserveOrder } from './warehouse-reservations.service';
import type { SubstituteOrderItemInput } from '../../schemas/admin.schema';

/**
 * Zamiana produktu w pozycji zamówienia.
 *
 * Zamieniamy tylko to, co wydajemy z magazynu: pozycja dalej odpowiada tej samej
 * pozycji zamówienia w sklepie (externalItemId, sku, cena), więc rozliczenie z
 * klientem się nie zmienia. Podmieniamy produkt magazynowy i nazwę na dokumentach.
 */

const BLOCKED_ORDER_STATUSES = new Set(['SHIPPED', 'DELIVERED', 'CANCELLED', 'PARTIALLY_RETURNED', 'RETURNED']);

export type SubstitutionBlockerCode =
  | 'ORDER_STATUS'
  | 'BUNDLE_COMPONENT'
  | 'CONFIRMED_WZ'
  | 'ISSUED_INVOICE'
  | 'RETURNED_ITEM'
  | 'SAME_PRODUCT'
  | 'PRODUCT_NOT_FOUND';

export type SubstitutionWarningCode =
  | 'DRAFT_WZ'
  | 'MISSING_STOCK'
  | 'STOCK_NOT_TRACKED'
  | 'PRODUCT_INACTIVE'
  | 'PERSONALIZATION_CASE'
  | 'DRAFT_INVOICE'
  | 'NO_SHOP_NOTE';

export interface SubstitutionIssue<TCode extends string> {
  code: TCode;
  message: string;
}

export interface OrderItemSubstitutionPreview {
  orderId: string;
  orderReference: string;
  orderItemId: string;
  canSubstitute: boolean;
  blockers: SubstitutionIssue<SubstitutionBlockerCode>[];
  warnings: SubstitutionIssue<SubstitutionWarningCode>[];
  currentItem: {
    sku: string;
    productName: string;
    quantity: number;
    warehouseProductId: string | null;
    warehouseProductSku: string | null;
    warehouseProductName: string | null;
    isSubstituted: boolean;
    substitutedFromName: string | null;
  };
  targetProduct: {
    id: string;
    sku: string;
    name: string;
    unit: string;
    currentStock: number;
    availableStock: number;
    isActive: boolean;
    isStockTracked: boolean;
  } | null;
  documents: {
    draftWzId: string | null;
    draftWzNumber: string | null;
    confirmedWzNumber: string | null;
    invoiceNumber: string | null;
  };
  shopNoteAvailable: boolean;
}

export interface OrderItemSubstitutionResult {
  orderId: string;
  orderItemId: string;
  substitutedFrom: { sku: string; productName: string; warehouseProductId: string | null };
  substitutedTo: { sku: string; productName: string; warehouseProductId: string };
  reservation: Awaited<ReturnType<typeof reserveOrder>>;
  warehouseDocument: { id: string; number: string | null; status: string } | null;
  cancelledDocumentNumber: string | null;
  shopNote: { status: 'SENT' | 'SKIPPED' | 'FAILED'; message: string | null };
  warnings: SubstitutionIssue<SubstitutionWarningCode>[];
}

const orderItemInclude = {
  order: {
    include: {
      shop: true,
      salesDocuments: { orderBy: { createdAt: 'desc' as const } },
      warehouseDocuments: true,
    },
  },
  warehouseProduct: true,
  personalizationCase: { select: { id: true, status: true } },
  returnItems: { select: { id: true } },
};

type OrderItemWithContext = Prisma.OrderItemGetPayload<{ include: typeof orderItemInclude }>;

async function loadOrderItem(orderId: string, orderItemId: string): Promise<OrderItemWithContext> {
  const tenantId = getTenantId();
  const item = await prisma.orderItem.findFirst({
    where: {
      id: orderItemId,
      orderId,
      ...(tenantId ? { order: { shop: { tenantId } } } : {}),
    },
    include: orderItemInclude,
  });

  if (!item) throw new Error('Pozycja zamówienia nie znaleziona');
  return item;
}

async function loadTargetProduct(warehouseProductId: string, tenantId: string) {
  return prisma.warehouseProduct.findFirst({
    where: { id: warehouseProductId, tenantId },
  });
}

/**
 * Stan dostępny = stan bieżący minus aktywne rezerwacje na innych pozycjach.
 */
async function availableStockFor(productId: string, tenantId: string, excludeOrderItemId: string) {
  const [product, reserved] = await Promise.all([
    prisma.warehouseProduct.findFirst({ where: { id: productId, tenantId }, select: { currentStock: true } }),
    prisma.warehouseReservation.aggregate({
      where: {
        tenantId,
        warehouseProductId: productId,
        status: 'ACTIVE',
        source: 'LOCAL_STOCK',
        orderItemId: { not: excludeOrderItemId },
      },
      _sum: { quantity: true },
    }),
  ]);

  const currentStock = new Prisma.Decimal(product?.currentStock ?? 0);
  const reservedQuantity = new Prisma.Decimal(reserved._sum.quantity ?? 0);
  return {
    currentStock: Number(currentStock),
    availableStock: Number(currentStock.minus(reservedQuantity)),
  };
}

function collectIssues(
  item: OrderItemWithContext,
  target: Awaited<ReturnType<typeof loadTargetProduct>>,
  availableStock: number | null,
) {
  const blockers: SubstitutionIssue<SubstitutionBlockerCode>[] = [];
  const warnings: SubstitutionIssue<SubstitutionWarningCode>[] = [];

  const activeDocuments = item.order.warehouseDocuments.filter(
    (document) => document.type === 'WZ' && document.status !== 'CANCELLED',
  );
  const confirmedWz = activeDocuments.find((document) => document.status === 'CONFIRMED');
  const draftWz = activeDocuments.find((document) => document.status === 'DRAFT');
  const invoice = item.order.salesDocuments.find(
    (document) => document.documentType === 'INVOICE' && ['ISSUED', 'SENT'].includes(document.status),
  );
  const draftInvoice = item.order.salesDocuments.find(
    (document) => document.documentType === 'INVOICE' && ['DRAFT', 'PENDING', 'FAILED'].includes(document.status),
  );

  if (BLOCKED_ORDER_STATUSES.has(item.order.operationalStatus)) {
    blockers.push({
      code: 'ORDER_STATUS',
      message: `Zamówienie ma status ${item.order.operationalStatus} — zamiana produktu jest możliwa tylko przed wydaniem`,
    });
  }

  if (item.sourceType === 'BUNDLE_COMPONENT') {
    blockers.push({
      code: 'BUNDLE_COMPONENT',
      message: 'Pozycja jest składnikiem zestawu — zamiana składników zestawu nie jest obsługiwana',
    });
  }

  if (confirmedWz) {
    blockers.push({
      code: 'CONFIRMED_WZ',
      message: `Towar został wydany dokumentem ${confirmedWz.number || 'WZ'} — anuluj dokument przed zamianą`,
    });
  }

  if (invoice) {
    blockers.push({
      code: 'ISSUED_INVOICE',
      message: `Do zamówienia wystawiono fakturę ${invoice.externalNumber || invoice.externalId || ''}`.trim() +
        ' — anuluj fakturę albo wystaw korektę przed zamianą',
    });
  }

  if (item.returnItems.length > 0) {
    blockers.push({
      code: 'RETURNED_ITEM',
      message: 'Pozycja występuje w zwrocie lub anulowaniu — zamiana nie jest możliwa',
    });
  }

  if (!target) {
    blockers.push({ code: 'PRODUCT_NOT_FOUND', message: 'Nie znaleziono produktu magazynowego do zamiany' });
  } else {
    if (target.id === item.warehouseProductId) {
      blockers.push({ code: 'SAME_PRODUCT', message: 'Wybrany produkt jest już przypisany do tej pozycji' });
    }
    if (!target.isActive) {
      warnings.push({ code: 'PRODUCT_INACTIVE', message: 'Produkt docelowy jest nieaktywny w magazynie' });
    }
    if (!target.isStockTracked) {
      warnings.push({
        code: 'STOCK_NOT_TRACKED',
        message: 'Produkt docelowy jest wykluczony z magazynu — pozycja nie zostanie zarezerwowana',
      });
    } else if (availableStock !== null && availableStock < item.quantity) {
      warnings.push({
        code: 'MISSING_STOCK',
        message: `Dostępny stan (${availableStock}) nie pokrywa ilości ${item.quantity} — pozycja trafi do domówienia`,
      });
    }
  }

  if (draftWz) {
    warnings.push({
      code: 'DRAFT_WZ',
      message: `Dokument ${draftWz.number || 'WZ'} w buforze zostanie anulowany i wystawiony ponownie po zamianie`,
    });
  }

  if (draftInvoice) {
    warnings.push({
      code: 'DRAFT_INVOICE',
      message: 'Faktura zamówienia jest w przygotowaniu — sprawdź jej treść po zamianie',
    });
  }

  if (item.personalizationCase) {
    warnings.push({
      code: 'PERSONALIZATION_CASE',
      message: 'Pozycja ma projekt personalizacji — szablon nie zmieni się razem z produktem',
    });
  }

  if (item.order.shop.platform !== 'PRESTASHOP') {
    warnings.push({
      code: 'NO_SHOP_NOTE',
      message: 'Sklep nie jest PrestaShop — notatka o zamianie nie zostanie wysłana',
    });
  }

  return { blockers, warnings, confirmedWz, draftWz, invoice };
}

export async function previewOrderItemSubstitution(
  orderId: string,
  orderItemId: string,
  input: SubstituteOrderItemInput,
): Promise<OrderItemSubstitutionPreview> {
  const item = await loadOrderItem(orderId, orderItemId);
  const tenantId = item.order.shop.tenantId;
  const target = await loadTargetProduct(input.warehouseProductId, tenantId);
  const stock = target ? await availableStockFor(target.id, tenantId, item.id) : null;
  const { blockers, warnings, confirmedWz, draftWz, invoice } = collectIssues(item, target, stock?.availableStock ?? null);

  return {
    orderId: item.orderId,
    orderReference: item.order.orderReference,
    orderItemId: item.id,
    canSubstitute: blockers.length === 0,
    blockers,
    warnings,
    currentItem: {
      sku: item.sku,
      productName: item.productNameSnapshot,
      quantity: item.quantity,
      warehouseProductId: item.warehouseProductId,
      warehouseProductSku: item.warehouseProduct?.sku ?? null,
      warehouseProductName: item.warehouseProduct?.name ?? null,
      isSubstituted: item.isSubstituted,
      substitutedFromName: item.substitutedFromName,
    },
    targetProduct: target
      ? {
        id: target.id,
        sku: target.sku,
        name: target.name,
        unit: target.unit,
        currentStock: stock?.currentStock ?? 0,
        availableStock: stock?.availableStock ?? 0,
        isActive: target.isActive,
        isStockTracked: target.isStockTracked,
      }
      : null,
    documents: {
      draftWzId: draftWz?.id ?? null,
      draftWzNumber: draftWz?.number ?? null,
      confirmedWzNumber: confirmedWz?.number ?? null,
      invoiceNumber: invoice?.externalNumber ?? invoice?.externalId ?? null,
    },
    shopNoteAvailable: item.order.shop.platform === 'PRESTASHOP',
  };
}

export async function substituteOrderItem(
  orderId: string,
  orderItemId: string,
  input: SubstituteOrderItemInput,
): Promise<OrderItemSubstitutionResult> {
  const item = await loadOrderItem(orderId, orderItemId);
  const tenantId = item.order.shop.tenantId;
  const target = await loadTargetProduct(input.warehouseProductId, tenantId);
  const stock = target ? await availableStockFor(target.id, tenantId, item.id) : null;
  const { blockers, warnings, draftWz } = collectIssues(item, target, stock?.availableStock ?? null);

  if (blockers.length > 0) {
    throw new Error(blockers.map((blocker) => blocker.message).join('. '));
  }
  if (!target) throw new Error('Nie znaleziono produktu magazynowego do zamiany');

  const previousName = item.productNameSnapshot;
  const previousSku = item.warehouseProduct?.sku ?? item.sku;
  const hadWz = Boolean(draftWz);

  // Bufor WZ trzymałby pozycję ze starym produktem, więc anulujemy go przed
  // zmianą i odtwarzamy po przeliczeniu rezerwacji.
  let cancelledDocumentNumber: string | null = null;
  if (draftWz) {
    const cancelled = await cancelDocument(draftWz.id, {
      reason: `Zamiana produktu w pozycji ${item.productNameSnapshot}`,
    });
    cancelledDocumentNumber = cancelled.number ?? null;
  }

  await prisma.orderItem.update({
    where: { id: item.id },
    data: {
      warehouseProductId: target.id,
      productNameSnapshot: target.name,
      isSubstituted: true,
      // Przy kolejnej zamianie oryginał zostaje ten pierwotny, nie poprzedni zamiennik.
      substitutedFromSku: item.isSubstituted ? item.substitutedFromSku : previousSku,
      substitutedFromName: item.isSubstituted ? item.substitutedFromName : previousName,
      substitutedFromProductId: item.isSubstituted ? item.substitutedFromProductId : item.warehouseProductId,
      substitutedAt: new Date(),
      substitutionReason: input.reason?.trim() || null,
    },
  });

  const reservation = await reserveOrder(item.orderId);

  let warehouseDocument: OrderItemSubstitutionResult['warehouseDocument'] = null;
  if (hadWz || (await shouldAutoCreateWzForTenant(tenantId))) {
    const wzResult = await createWzForOrder(item.orderId, hadWz ? { saveAsDraft: true } : {});
    if (wzResult.document) {
      warehouseDocument = {
        id: wzResult.document.id,
        number: wzResult.document.number ?? null,
        status: wzResult.document.status,
      };
    }
  }

  const shopNote = input.notifyShop === false
    ? { status: 'SKIPPED' as const, message: 'Notatka wyłączona przy zamianie' }
    : await sendShopNote(item, previousName, target.name, input.reason ?? null);

  return {
    orderId: item.orderId,
    orderItemId: item.id,
    substitutedFrom: {
      sku: previousSku,
      productName: previousName,
      warehouseProductId: item.warehouseProductId,
    },
    substitutedTo: { sku: target.sku, productName: target.name, warehouseProductId: target.id },
    reservation,
    warehouseDocument,
    cancelledDocumentNumber,
    shopNote,
    warnings,
  };
}

async function sendShopNote(
  item: OrderItemWithContext,
  previousName: string,
  nextName: string,
  reason: string | null,
): Promise<OrderItemSubstitutionResult['shopNote']> {
  const shop = item.order.shop;
  if (shop.platform !== 'PRESTASHOP') {
    return { status: 'SKIPPED', message: 'Notatki obsługiwane są tylko dla PrestaShop' };
  }

  const message = [
    `Zamiana produktu w zamówieniu ${item.order.orderReference}:`,
    `"${previousName}" → "${nextName}" (${item.quantity} szt.)`,
    reason?.trim() ? `Powód: ${reason.trim()}` : null,
  ].filter(Boolean).join(' ');

  try {
    const config = (shop.configJson as Record<string, any>) || {};
    const authType = config.authType === 'ADMIN_API' ? 'ADMIN_API' : 'WEB_SERVICE';
    const client = new PrestaShopClient({
      baseUrl: shop.baseUrl,
      apiKey: decrypt(shop.apiKey),
      authType,
      adminApiConfig: authType === 'ADMIN_API' ? config.adminApi : undefined,
    });

    const payload = (item.order.payloadJson as Record<string, any>) || {};
    await client.addOrderNote({
      orderId: item.order.externalOrderId,
      cartId: payload?.order?.id_cart ?? null,
      customerId: payload?.order?.id_customer ?? payload?.customer?.id ?? null,
      message,
    });

    return { status: 'SENT', message };
  } catch (error) {
    return {
      status: 'FAILED',
      message: error instanceof Error ? error.message : 'Nie udało się dodać notatki w sklepie',
    };
  }
}
