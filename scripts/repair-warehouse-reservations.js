/**
 * Jednorazowa naprawa sierot rezerwacje↔dokumenty po audycie 2026-08-07.
 *
 * Klasy problemow:
 * 1. Pozycje CONFIRMED WZ wskazujace rezerwacje WHOLESALE_BACKORDER — konsumpcja/SKIP
 *    nigdy nie zdjely stanu, towar wyjechal, currentStock zawyzony. Naprawa: zdjac
 *    stan i odpiac rezerwacje (pomijamy pozycje, ktore zeszlyby ponizej zera — raport).
 * 2. ACTIVE rezerwacje zamowien SHIPPED/DELIVERED/CANCELLED/RETURNED:
 *    backorder → CANCELLED bez ruchu stanu; LOCAL pokryta zatwierdzonym WZ → CONSUMED
 *    bez ruchu stanu; LOCAL niepokryta → tylko raport (decyzja reczna).
 *
 * Uruchomienie w kontenerze API:
 *   node /app/scripts/repair-warehouse-reservations.js            # dry-run
 *   node /app/scripts/repair-warehouse-reservations.js --apply    # zapis
 */
const prisma = require('/app/dist/lib/prisma').default;

const APPLY = process.argv.includes('--apply');
const CLOSED_STATUSES = ['SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED', 'PARTIALLY_RETURNED'];

async function repairBackorderWzItems(report) {
  const items = await prisma.warehouseDocumentItem.findMany({
    where: {
      document: { type: 'WZ', status: 'CONFIRMED' },
      reservation: { source: 'WHOLESALE_BACKORDER' },
    },
    include: {
      document: { select: { number: true } },
      product: { select: { id: true, sku: true, name: true, currentStock: true } },
      reservation: { select: { id: true, status: true } },
    },
  });

  for (const item of items) {
    const quantity = Number(item.quantity);
    const stock = Number(item.product.currentStock);
    const label = `${item.document.number} ${item.product.sku} ${quantity} szt. (stan ${stock})`;

    if (stock - quantity < 0) {
      report.push(`RAPORT (zejdzie ponizej zera — wymaga inwentaryzacji)  ${label}`);
      continue;
    }

    if (!APPLY) {
      report.push(`DO KOREKTY (stan -${quantity}, odpiecie rezerwacji)     ${label}`);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.warehouseProduct.update({
        where: { id: item.product.id },
        data: { currentStock: { decrement: item.quantity } },
      });
      await tx.warehouseDocumentItem.update({
        where: { id: item.id },
        data: { reservationId: null },
      });
      if (item.reservation && item.reservation.status === 'ACTIVE') {
        await tx.warehouseReservation.update({
          where: { id: item.reservation.id },
          data: { status: 'CANCELLED', cancelledAt: new Date(), reason: 'Naprawa: pozycja wydana WZ bez pokrycia lokalnego' },
        });
      }
    });
    report.push(`SKORYGOWANO (stan -${quantity})                          ${label}`);
  }

  return items.map((item) => item.product.id);
}

async function repairStaleActiveReservations(report) {
  const reservations = await prisma.warehouseReservation.findMany({
    where: {
      status: 'ACTIVE',
      order: { operationalStatus: { in: CLOSED_STATUSES } },
    },
    include: {
      warehouseProduct: { select: { id: true, sku: true } },
      order: { select: { id: true, orderReference: true, operationalStatus: true } },
    },
  });

  const touchedProductIds = [];
  for (const reservation of reservations) {
    const label = `${reservation.order.orderReference} (${reservation.order.operationalStatus}) ${reservation.warehouseProduct.sku} ${Number(reservation.quantity)} szt. [${reservation.source}]`;

    if (reservation.source === 'WHOLESALE_BACKORDER') {
      if (APPLY) {
        await prisma.warehouseReservation.update({
          where: { id: reservation.id },
          data: { status: 'CANCELLED', cancelledAt: new Date(), reason: 'Naprawa: zamowienie zamkniete' },
        });
      }
      report.push(`${APPLY ? 'ANULOWANO' : 'DO ANULOWANIA'} (backorder, bez ruchu stanu)  ${label}`);
      continue;
    }

    // LOCAL: sprawdz pokrycie zatwierdzonym WZ
    const covered = await prisma.warehouseDocumentItem.count({
      where: {
        reservationId: reservation.id,
        document: { type: 'WZ', status: 'CONFIRMED' },
      },
    });
    if (covered > 0) {
      if (APPLY) {
        await prisma.warehouseReservation.update({
          where: { id: reservation.id },
          data: { status: 'CONSUMED', consumedAt: new Date() },
        });
      }
      report.push(`${APPLY ? 'SKONSUMOWANO' : 'DO KONSUMPCJI'} (pokryta WZ, bez ruchu)   ${label}`);
      touchedProductIds.push(reservation.warehouseProduct.id);
      continue;
    }

    report.push(`RAPORT (LOCAL bez pokrycia WZ — decyzja reczna)          ${label}`);
  }

  return touchedProductIds;
}

async function main() {
  console.log(`Tryb: ${APPLY ? 'ZAPIS' : 'DRY-RUN'}\n`);
  const report = [];

  const productIds1 = await repairBackorderWzItems(report);
  const productIds2 = await repairStaleActiveReservations(report);

  if (report.length === 0) {
    console.log('Brak sierot do naprawy.');
  } else {
    for (const line of report) console.log(line);
  }

  if (APPLY) {
    const productIds = Array.from(new Set([...productIds1, ...productIds2]));
    if (productIds.length > 0) {
      try {
        const { syncStockForProducts } = require('/app/dist/services/stock/stock-sync.service');
        await syncStockForProducts(productIds, 'MANUAL', undefined);
        console.log(`\nZlecono synchronizacje stanow do sklepu dla ${productIds.length} produktow.`);
      } catch (error) {
        console.warn('\nNie udalo sie zlecic synchronizacji stanow:', error.message);
      }
    }
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
