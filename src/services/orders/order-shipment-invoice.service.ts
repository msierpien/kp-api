import prisma from '../../lib/prisma';
import { getTenantId } from '../../lib/tenant-context';
import {
  confirmDocument,
  createWzForOrder,
  syncWzDraftItemsWithReservations,
} from '../admin/warehouse-documents.service';
import {
  describeCoverageItem,
  evaluateOrderStockCoverage,
  type OrderStockCoverageItem,
} from './order-stock-coverage.service';

/**
 * Nadanie listu przewozowego = paczka wyjezdza, wiec zamowienie ma dostac
 * fakture VAT i dokument WZ. Kolejnosc jest celowa: najpierw faktura, potem
 * skutki magazynowe — nieudana faktura nie moze zdjac towaru ze stanu.
 *
 * Braku towaru nie obchodzimy: gdy pokrycie jest niepelne, NIC sie nie dzieje
 * (ani faktura, ani WZ), a panel dostaje liste brakujacych pozycji.
 */

export interface IssueInvoiceAfterShipmentConfig {
  /** Domyslnie true: bez pokrycia magazynowego wstrzymujemy fakture i WZ. */
  blockOnMissingStock?: boolean;
  /** Domyslnie true: brakujacy WZ powstaje razem z faktura. */
  ensureWz?: boolean;
  /** Domyslnie true: WZ zamykamy dopiero, gdy kazda pozycja ma skan EAN. */
  requireScanned?: boolean;
}

export type ShipmentWarehouseDocumentStatus =
  | 'NONE'
  | 'CREATED_DRAFT'
  | 'CONFIRMED'
  | 'ALREADY_CONFIRMED'
  | 'REQUIRES_CONFIRMATION'
  | 'FAILED';

export interface ShipmentWarehouseDocumentResult {
  status: ShipmentWarehouseDocumentStatus;
  documentId?: string;
  documentNumber?: string;
  reason?: string;
}

export type ShipmentInvoiceStatus =
  | 'ISSUED'
  | 'ALREADY_ISSUED'
  | 'STOCK_MISSING'
  | 'SKIPPED'
  | 'FAILED';

export interface ShipmentInvoiceResult {
  status: ShipmentInvoiceStatus;
  message: string;
  invoiceId?: string;
  invoiceNumber?: string | null;
  warehouseDocument: ShipmentWarehouseDocumentResult;
  /** Wypelnione tylko przy STOCK_MISSING — pozycje bez pokrycia na stanie. */
  stockIssues?: OrderStockCoverageItem[];
}

function orderWhere(orderId: string) {
  const tenantId = getTenantId();
  return {
    id: orderId,
    ...(tenantId ? { shop: { tenantId } } : {}),
  };
}

async function findExistingInvoice(orderId: string) {
  return prisma.salesDocument.findFirst({
    where: {
      orderId,
      documentType: 'INVOICE',
      documentKey: 'PRIMARY',
      ...(getTenantId() ? { tenantId: getTenantId() as string } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

async function confirmWzIfScanned(
  documentId: string,
  requireScanned: boolean,
): Promise<ShipmentWarehouseDocumentResult> {
  // Draft moze byc nieaktualny wzgledem rezerwacji (np. realokacja po PZ), wiec
  // skany oceniamy dopiero po synchronizacji pozycji.
  await syncWzDraftItemsWithReservations(documentId);
  const document = await prisma.warehouseDocument.findUniqueOrThrow({
    where: { id: documentId },
    include: { items: true },
  });

  if (document.status === 'CONFIRMED') {
    return { status: 'ALREADY_CONFIRMED', documentId: document.id, documentNumber: document.number };
  }

  const allScanned = document.items.length > 0 && document.items.every((item) => Boolean(item.scannedEan?.trim()));
  if (requireScanned && !allScanned) {
    return {
      status: 'REQUIRES_CONFIRMATION',
      documentId: document.id,
      documentNumber: document.number,
      reason: 'WZ ma pozycje bez skanu EAN',
    };
  }

  try {
    await confirmDocument(document.id);
    return { status: 'CONFIRMED', documentId: document.id, documentNumber: document.number };
  } catch (error) {
    return {
      status: 'FAILED',
      documentId: document.id,
      documentNumber: document.number,
      reason: error instanceof Error ? error.message : 'Nie udało się zatwierdzić WZ',
    };
  }
}

async function ensureOrderWz(
  orderId: string,
  requireScanned: boolean,
): Promise<ShipmentWarehouseDocumentResult> {
  const tenantId = getTenantId();
  const existing = await prisma.warehouseDocument.findFirst({
    where: {
      orderId,
      type: 'WZ',
      status: { not: 'CANCELLED' },
      ...(tenantId ? { tenantId } : {}),
    },
    orderBy: { createdAt: 'asc' },
  });

  if (existing) {
    if (existing.status === 'CONFIRMED') {
      return { status: 'ALREADY_CONFIRMED', documentId: existing.id, documentNumber: existing.number };
    }
    return confirmWzIfScanned(existing.id, requireScanned);
  }

  try {
    // Zapis jako roboczy: o zamknieciu decyduje dopiero ocena skanow ponizej.
    const created = await createWzForOrder(orderId, { saveAsDraft: true });
    if (!created.document) {
      return { status: 'NONE', reason: created.skippedReason ?? 'Nie utworzono WZ' };
    }

    const confirmation = await confirmWzIfScanned(created.document.id, requireScanned);
    if (confirmation.status === 'REQUIRES_CONFIRMATION') {
      return { ...confirmation, status: 'CREATED_DRAFT' };
    }
    return confirmation;
  } catch (error) {
    return {
      status: 'FAILED',
      reason: error instanceof Error ? error.message : 'Nie udało się utworzyć WZ',
    };
  }
}

export async function issueInvoiceAfterShipment(
  orderId: string,
  config: IssueInvoiceAfterShipmentConfig = {},
): Promise<ShipmentInvoiceResult> {
  const blockOnMissingStock = config.blockOnMissingStock !== false;
  const ensureWz = config.ensureWz !== false;
  const requireScanned = config.requireScanned !== false;

  const order = await prisma.order.findFirst({
    where: orderWhere(orderId),
    select: { id: true, orderReference: true },
  });
  if (!order) throw new Error('Zamówienie nie znalezione');

  const coverage = await evaluateOrderStockCoverage(orderId);
  if (blockOnMissingStock && !coverage.covered) {
    return {
      status: 'STOCK_MISSING',
      message: [
        'Brak towaru na magazynie — faktura i WZ wstrzymane, stan magazynowy bez zmian.',
        ...coverage.blocking.map(describeCoverageItem),
      ].join(' '),
      stockIssues: coverage.blocking,
      warehouseDocument: { status: 'NONE', reason: 'Wstrzymane z powodu braku towaru' },
    };
  }

  const existingInvoice = await findExistingInvoice(orderId);
  const alreadyIssued = existingInvoice && ['ISSUED', 'SENT'].includes(existingInvoice.status);

  let invoiceId = existingInvoice?.id;
  let invoiceNumber = existingInvoice?.externalNumber ?? null;

  if (!alreadyIssued) {
    // Import w locie: invoices.service uruchamia automatyzacje faktury, wiec
    // staly import zamknalby cykl modulow.
    const { issueOrderInvoice } = await import('../admin/invoices.service');
    let issued;
    try {
      issued = await issueOrderInvoice(orderId);
    } catch (error) {
      return {
        status: 'FAILED',
        message: error instanceof Error ? error.message : 'Nie udało się wystawić faktury',
        warehouseDocument: { status: 'NONE', reason: 'Faktura nie została wystawiona' },
      };
    }

    if (issued.status !== 'ISSUED' && issued.status !== 'SENT') {
      return {
        status: 'FAILED',
        message: issued.errorMessage || 'iFirma nie wystawiła faktury',
        invoiceId: issued.id,
        warehouseDocument: { status: 'NONE', reason: 'Faktura nie została wystawiona' },
      };
    }

    invoiceId = issued.id;
    invoiceNumber = issued.externalNumber ?? null;
  }

  const warehouseDocument = ensureWz
    ? await ensureOrderWz(orderId, requireScanned)
    : { status: 'NONE' as const, reason: 'Tworzenie WZ wyłączone w automatyzacji' };

  const invoiceLabel = invoiceNumber ? `Faktura ${invoiceNumber}` : 'Faktura';
  const invoiceMessage = alreadyIssued
    ? `${invoiceLabel} była już wystawiona`
    : `${invoiceLabel} wystawiona`;

  const warehouseMessage = (() => {
    switch (warehouseDocument.status) {
      case 'CONFIRMED':
        return `${warehouseDocument.documentNumber} zatwierdzony`;
      case 'ALREADY_CONFIRMED':
        return `${warehouseDocument.documentNumber} był już zatwierdzony`;
      case 'CREATED_DRAFT':
        return `${warehouseDocument.documentNumber} utworzony jako roboczy — ${warehouseDocument.reason}`;
      case 'REQUIRES_CONFIRMATION':
        return `${warehouseDocument.documentNumber} wymaga potwierdzenia — ${warehouseDocument.reason}`;
      case 'FAILED':
        return `nie udało się zamknąć WZ: ${warehouseDocument.reason}`;
      default:
        return warehouseDocument.reason ?? 'bez dokumentu WZ';
    }
  })();

  return {
    status: alreadyIssued ? 'ALREADY_ISSUED' : 'ISSUED',
    message: `${invoiceMessage}, ${warehouseMessage}.`,
    invoiceId,
    invoiceNumber,
    warehouseDocument,
  };
}
