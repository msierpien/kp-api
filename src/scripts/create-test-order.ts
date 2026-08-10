/**
 * Testowe zamowienie reczne - do sprawdzenia sciezki personalizacji bez
 * skladania prawdziwego zakupu w sklepie.
 *
 * Idzie DOKLADNIE ta sama sciezka co przycisk "Zamowienie reczne" w panelu
 * (`createManualOrder`), wiec sprawdza to, co dziala na produkcji: dopasowanie
 * produktu po SKU, zalozenie sprawy personalizacji i token do portalu.
 *
 * Maile: `createManualOrder` wysyla je tylko przy AUTO_SEND_EMAILS=true.
 * Na produkcji jest `false`, a SMTP celuje w mailhoga - test nie wysle nic
 * do prawdziwego adresata. Mimo to domyslny adres to `example.com`
 * (RFC 2606, nigdy nie istnieje).
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/create-test-order.js
 *   SKU=ZAP-12X17 QTY=3 EMAIL=... REFERENCE=... - nadpisanie domyslnych
 */
import { PrismaClient } from '@prisma/client'
import { createManualOrder } from '../services/admin/orders.service'

const prisma = new PrismaClient()

/**
 * Sklep MANUAL - `createManualOrder` odrzuca kazdy inny typ, a sklep
 * PrestaShop przyjmuje zamowienia wylacznie przez import ze sklepu.
 */
const SHOP_ID = process.env.SHOP_ID || 'cms3p01ke004sr2ccpmsrw8ge' // Zamówienia telefoniczne (MANUAL)
const SKU = process.env.SKU || 'ZAP-12X17'
const QUANTITY = Number(process.env.QTY || 3)
const EMAIL = process.env.EMAIL || 'test@example.com'
const CUSTOMER = process.env.CUSTOMER || 'Test Personalizacji'

/** Referencja z data i godzina - kolejne testy nie zderzaja sie kluczem. */
const REFERENCE =
  process.env.REFERENCE || `TEST-${SKU}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`

async function main() {
  // Produkt personalizowany jest przypisany DO SKLEPU, wiec kanal reczny
  // potrzebuje wlasnego wpisu na to samo SKU i ten sam szablon - inaczej
  // zamowienie powstanie, ale bez sprawy personalizacji.
  const source = await prisma.personalizedProduct.findFirst({
    where: { identifierValue: SKU, isActive: true },
    include: { template: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!source) throw new Error(`Zaden sklep nie ma produktu personalizowanego o SKU ${SKU}`)

  const existing = await prisma.personalizedProduct.findFirst({
    where: { shopId: SHOP_ID, identifierType: 'SKU', identifierValue: SKU },
  })
  const product = existing
    ? await prisma.personalizedProduct.update({
        where: { id: existing.id },
        data: { templateId: source.templateId, name: source.name, isActive: true },
        include: { template: true },
      })
    : await prisma.personalizedProduct.create({
        data: {
          shopId: SHOP_ID,
          identifierType: 'SKU',
          identifierValue: SKU,
          templateId: source.templateId,
          name: source.name,
          isActive: true,
        },
        include: { template: true },
      })

  const unitPrice = Number(
    (await prisma.warehouseProduct.findFirst({ where: { sku: SKU }, select: { retailPrice: true } }))
      ?.retailPrice ?? 6.5
  )

  const order = await createManualOrder({
    shopId: SHOP_ID,
    orderReference: REFERENCE,
    customerEmail: EMAIL,
    customerName: CUSTOMER,
    totalPaid: Number((unitPrice * QUANTITY).toFixed(2)),
    currency: 'PLN',
    language: 'pl',
    items: [
      {
        sku: SKU,
        productName: product?.name || SKU,
        quantity: QUANTITY,
        unitPrice,
      },
    ],
    notes: 'Zamówienie testowe - sprawdzenie ścieżki personalizacji.',
  })

  console.log(
    JSON.stringify(
      {
        zamowienie: {
          reference: REFERENCE,
          sztuk: QUANTITY,
          kwota: Number((unitPrice * QUANTITY).toFixed(2)),
        },
        szablon: product?.template?.name ?? 'BRAK - produkt nie jest personalizowany',
        odpowiedz: order,
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
