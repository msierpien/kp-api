/**
 * Zamowienie TESTOWE na dwa dwustronne zaproszenia z ploterem - end to end.
 *
 * Zaklada zamowienie, pozycje na 2 sztuki i sprawe personalizacji z gotowymi
 * odpowiedziami - gotowa do wygenerowania paczki jednym kliknieciem w panelu.
 *
 * Paczki NIE generuje sam. Probowalem: `generateCasePrintPackage` wolany
 * z CLI zapisuje pliki i assety, po czym proces zawisa przed transakcja
 * koncowa (sprawa zostaje bez `READY_FOR_PRINT`). Serwis jest pisany pod
 * kontekst zadania HTTP - middleware tenanta i polaczenia kolejki zyja tam
 * inaczej niz w jednorazowym skrypcie. Generowanie z panelu przechodzi
 * prawdziwa sciezka i to ona jest wiarygodnym testem.
 *
 * Sprawa dostaje `status: SUBMITTED` i komplet odpowiedzi, wiec nie trzeba
 * przechodzic portalu klienta.
 *
 * Idempotentny po `orderReference` - ponowne uruchomienie kasuje poprzednie
 * zamowienie testowe (razem ze sprawa i assetami, kaskada) i zaklada nowe.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/create-zamowienie-testowe-ploter.js
 *   TEMPLATE_CODE=URODZINY_18_PLOTER node dist/scripts/...
 *
 * Potem: panel -> sprawa -> "Generuj paczkę".
 *
 * Sprzatanie po testach:
 *   CLEANUP=1 node dist/scripts/create-zamowienie-testowe-ploter.js
 */
import { PrismaClient } from '@prisma/client'
import { generateAccessToken, getTokenExpiryDate } from '../lib/token'

const prisma = new PrismaClient()

const TENANT_SLUG = process.env.TENANT_SLUG || 'kreatywne-papierki'
const TEMPLATE_CODE = process.env.TEMPLATE_CODE || 'ZAPROSZENIE_90X130_PLOTER'
const ORDER_REFERENCE = process.env.ORDER_REFERENCE || 'TEST-PLOTER-01'
const QUANTITY = Math.max(1, Number(process.env.QUANTITY) || 2)

/**
 * Odpowiedzi w formacie, ktory czyta `flattenCaseAnswers`: pola wspolne
 * osobno, pola per sztuka w `items` (tyle wpisow, ile zamowionych sztuk).
 */
const ANSWERS = {
  sharedAnswers: {
    age_number: '20',
    celebrant_genitive: 'Kasi',
    front_date: 'SOBOTA · 20 LISTOPADA · 17:00',
    invite_body: 'na przyjęcie z okazji moich dwudziestych urodzin, które odbędzie się dnia',
    event_datetime: '20 LISTOPADA 2025 ROKU O GODZINIE 17:00',
    event_place: 'w Restauracji Primma Vera w Warszawie.',
    signature: 'Kasia',
  },
  items: [
    { guest_name: 'Annę Kowalską' },
    { guest_name: 'Pana Jana Nowaka' },
  ],
}

async function cleanup() {
  const existing = await prisma.order.findFirst({ where: { orderReference: ORDER_REFERENCE } })
  if (!existing) return null
  // Kaskada z Order zdejmuje pozycje, sprawe, assety i zadania druku.
  await prisma.order.delete({ where: { id: existing.id } })
  return existing.id
}

async function main() {
  if (process.env.CLEANUP === '1') {
    const removed = await cleanup()
    console.log(JSON.stringify({ usunieto: removed ?? 'nie było czego usuwać' }, null, 2))
    return
  }

  const tenant = await prisma.tenant.findFirst({ where: { slug: TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new Error(`Brak tenanta o slugu "${TENANT_SLUG}"`)

  const template = await prisma.personalizationTemplate.findFirst({
    where: { tenantId: tenant.id, code: TEMPLATE_CODE },
  })
  if (!template) throw new Error(`Brak szablonu ${TEMPLATE_CODE}`)

  // Dowolny sklep tenanta - zamowienie testowe nie idzie do sklepu, ale
  // relacja jest wymagana.
  const shop = await prisma.shop.findFirst({ where: { tenantId: tenant.id }, select: { id: true, name: true } })
  if (!shop) throw new Error('Brak sklepu w tenancie')

  await cleanup()

  const order = await prisma.order.create({
    data: {
      // Order nie ma wlasnego tenantId - przynaleznosc idzie przez sklep.
      shopId: shop.id,
      externalOrderId: `test-${Date.now()}`,
      orderReference: ORDER_REFERENCE,
      customerEmail: 'test@kreatywnepapierki.pl',
      customerName: 'Zamówienie testowe (ploter)',
      totalPaid: 0,
      createdAtShop: new Date(),
      payloadJson: { test: true, powod: 'weryfikacja składu arkuszowego' },
      operationalStatus: 'NEW',
      items: {
        create: [
          {
            externalItemId: `test-item-${Date.now()}`,
            sku: TEMPLATE_CODE,
            productNameSnapshot: template.name,
            quantity: QUANTITY,
          },
        ],
      },
    },
    include: { items: true },
  })

  const orderItem = order.items[0]

  // Token linku klienta - bez niego panel nie pokaze "Linku do
  // personalizacji", a sprawa testowa ma zachowywac sie jak prawdziwa.
  const { token, hash, encrypted } = generateAccessToken()

  const caseItem = await prisma.personalizationCase.create({
    data: {
      customerTokenHash: hash,
      customerTokenEncrypted: encrypted,
      tokenActive: true,
      customerTokenExpiresAt: getTokenExpiryDate(),
      orderId: order.id,
      orderItemId: orderItem.id,
      templateId: template.id,
      templateVersionFrozen: template.version,
      status: 'SUBMITTED',
      submittedAt: new Date(),
      answersJson: {
        ...ANSWERS,
        // Tyle wpisow, ile sztuk - inaczej druga sztuka zostalaby bez imienia.
        items: Array.from({ length: QUANTITY }, (_, index) => ANSWERS.items[index] ?? ANSWERS.items[0]),
      },
    },
  })

  console.log(
    JSON.stringify(
      {
        orderId: order.id,
        orderReference: order.orderReference,
        sklep: shop.name,
        caseId: caseItem.id,
        szablon: `${template.code} (${template.name})`,
        sztuk: QUANTITY,
        panel: `/personalization/cases/${caseItem.id}`,
        linkKlienta: `/personalizacja/${token}`,
      },
      null,
      2
    )
  )

}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
