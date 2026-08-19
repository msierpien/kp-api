/**
 * Automatyzacja: po utworzeniu listu przewozowego wystaw fakture VAT i WZ.
 *
 * Nadanie listu jest ostatnim momentem, w ktorym zamowienie jest jeszcze
 * "w reku" — dlatego wtedy powstaje faktura, a brakujacy WZ dopisuje sie sam.
 *
 * Braki magazynowe zatrzymuja WSZYSTKO: przy niepelnym pokryciu nie powstaje
 * ani faktura, ani WZ, stan zostaje nietkniety, a panel pokazuje liste
 * brakujacych pozycji. Inaczej faktura opisywalaby towar, ktorego nie ma.
 *
 * WZ zamyka sie dopiero po skanach EAN (jak regula "Zamknij WZ po fakturze").
 * Bez kompletu skanow dokument zostaje roboczy i czeka na potwierdzenie stanu.
 *
 * Idempotentny - regule rozpoznaje po nazwie i nadpisuje jej konfiguracje.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/create-shipment-invoice-automation.js
 *   DRY_RUN=1 - pokaz, co powstanie, bez zapisu
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TENANT_SLUG = process.env.TENANT_SLUG || 'kreatywne-papierki'

const RULE_NAME = 'Faktura VAT i WZ po nadaniu listu przewozowego'

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new Error(`Brak tenanta "${TENANT_SLUG}"`)

  const data = {
    name: RULE_NAME,
    description: 'Po utworzeniu listu przewozowego wystawia fakturę VAT i uzupełnia WZ. Przy braku towaru wstrzymuje jedno i drugie — bez skutków magazynowych.',
    trigger: 'ORDER_SHIPMENT_CREATED',
    conditions: [],
    actions: [
      {
        type: 'ISSUE_INVOICE_AFTER_SHIPMENT',
        config: {
          blockOnMissingStock: true,
          ensureWz: true,
          requireScanned: true,
        },
      },
    ],
    isActive: true,
    priority: 50,
  }

  if (process.env.DRY_RUN === '1') {
    console.log(JSON.stringify({ dryRun: true, tenant: TENANT_SLUG, regula: data }, null, 2))
    return
  }

  const existing = await prisma.automation.findFirst({
    where: { tenantId: tenant.id, name: RULE_NAME },
  })
  const automation = existing
    ? await prisma.automation.update({ where: { id: existing.id }, data })
    : await prisma.automation.create({ data: { tenantId: tenant.id, ...data } })

  console.log(JSON.stringify({ id: automation.id, utworzona: !existing }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
