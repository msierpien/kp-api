/**
 * Jednorazowa naprawa roboczych WZ, ktore zostaly otwarte po wysylce zamowienia.
 *
 * Zwolnienie rezerwacji przy przejsciu w SHIPPED oddalo towar na stan, wiec dokumenty
 * dla wyslanych/dostarczonych zamowien trzeba zatwierdzic (nowa logika confirmDocument
 * odpina martwa rezerwacje i zdejmuje stan), a dokumenty dla zwrotow anulowac.
 *
 * Uruchomienie w kontenerze API:
 *   node /app/scripts/repair-open-wz.js            # dry-run
 *   node /app/scripts/repair-open-wz.js --apply    # zapis
 */
const prisma = require('/app/dist/lib/prisma').default;
const { confirmDocument, cancelDocument } = require('/app/dist/services/admin/warehouse-documents.service');

const APPLY = process.argv.includes('--apply');
const CONFIRM_STATUSES = ['SHIPPED', 'DELIVERED'];
const CANCEL_STATUSES = ['RETURNED', 'PARTIALLY_RETURNED', 'CANCELLED'];

async function main() {
  const documents = await prisma.warehouseDocument.findMany({
    where: { type: 'WZ', status: 'DRAFT' },
    include: {
      order: { select: { orderReference: true, operationalStatus: true } },
      items: { include: { product: { select: { sku: true, name: true, currentStock: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Tryb: ${APPLY ? 'ZAPIS' : 'DRY-RUN'}; robocze WZ: ${documents.length}\n`);

  const results = [];

  for (const document of documents) {
    const status = document.order?.operationalStatus ?? 'BRAK';
    const label = `${document.number} (${document.order?.orderReference ?? '-'}, ${status})`;

    if (CONFIRM_STATUSES.includes(status)) {
      if (!APPLY) {
        results.push({ label, action: 'DO ZATWIERDZENIA', detail: stockPreview(document) });
        continue;
      }
      try {
        await confirmDocument(document.id);
        results.push({ label, action: 'ZATWIERDZONY' });
      } catch (error) {
        results.push({ label, action: 'BLAD', detail: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }

    if (CANCEL_STATUSES.includes(status)) {
      if (!APPLY) {
        results.push({ label, action: 'DO ANULOWANIA' });
        continue;
      }
      try {
        await cancelDocument(document.id, { reason: 'Zamowienie zwrocone/anulowane — WZ nie zostalo wydane' });
        results.push({ label, action: 'ANULOWANY' });
      } catch (error) {
        results.push({ label, action: 'BLAD', detail: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }

    results.push({ label, action: 'POMINIETY (zamowienie w realizacji)' });
  }

  for (const result of results) {
    console.log(`${result.action.padEnd(34)} ${result.label}${result.detail ? `\n   ${result.detail}` : ''}`);
  }

  await prisma.$disconnect();
}

/** Pokazuje, ile stanu zejdzie po zatwierdzeniu i czy ktoras pozycja zejdzie ponizej zera. */
function stockPreview(document) {
  return document.items
    .map((item) => {
      const quantity = Number(item.quantity);
      const stock = Number(item.product.currentStock);
      const flag = stock - quantity < 0 ? '  <-- ZEJDZIE PONIZEJ ZERA' : '';
      return `${item.product.sku}: ${stock} - ${quantity} = ${stock - quantity}${flag}`;
    })
    .join('\n   ');
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
