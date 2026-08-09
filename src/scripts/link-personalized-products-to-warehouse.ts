/**
 * Dociagniecie kart personalizowanych (winietka MIS, zaproszenie ROCZEK) do
 * modulu Magazyn: mapowanie sklepowe + produkt magazynowy.
 *
 * Produkty powstaly w sklepie po ostatnim imporcie, wiec w panelu widac je
 * tylko w Personalizacja > Produkty personalizowane. Ten skrypt robi to samo,
 * co import ze sklepu, ale punktowo - bez przeliczania kilku tysiecy pozycji.
 *
 * Dwie rzeczy ustawiamy inaczej niz domyslny import:
 *
 * 1. `isStockTracked = false`. Papeteria powstaje na zamowienie, wiec nie ma
 *    czego rezerwowac. Przy wlaczonym sledzeniu synchronizacja stanow wysyla
 *    do PrestaShop stan magazynowy (0) i zamyka sprzedaz.
 *
 * 2. `personalizationEnabled` NA MAPOWANIU zostaje wylaczone. Import zamowien
 *    ma dwie sciezki personalizacji i sciezka przez mapowanie ma pierwszenstwo,
 *    a mapowanie dopasowuje sie po ID produktu - czyli objelaby OBIE wersje
 *    zaproszenia, takze te do samodzielnego uzupelnienia. Rozdzielenie wersji
 *    stoi na referencjach kombinacji i produkcie personalizowanym, wiec ta
 *    flaga musi zostac wylaczona.
 *
 * UWAGA na stan bazy: produkcyjna tabela `shop_product_mappings` ma kolumne
 * `external_combination_id` i unikat na (shop_id, external_product_id,
 * external_combination_id), czego nie ma w `prisma/schema.prisma`. Dlatego
 * zapisy ida przez findFirst + create/update, a nie `upsert` - ten opiera sie
 * na kluczu ze schematu i konczy sie bledem 42P10.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/link-personalized-products-to-warehouse.js
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TENANT_SLUG = process.env.TENANT_SLUG || 'kreatywne-papierki'
const SHOP_ID = process.env.SHOP_ID || 'cmscv7k7l0001h4khpd8arr5i' // Kreatywne-papierki
const CATALOG_NAME = 'Kreatywne Papierki'

/** Karty, ktore maja trafic do magazynu. Cena detaliczna brutto, jak w sklepie. */
const PRODUCTS = [
  {
    externalProductId: '9406',
    sku: 'WIN-MIS',
    name: 'Winietka personalizowana na stół – Miś z Balonikami',
    retailPrice: 1.5,
  },
  {
    externalProductId: '9407',
    sku: 'ZAP-ROCZEK',
    name: 'Zaproszenie na roczek – Miś z Balonikami',
    retailPrice: 5,
  },
]

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new Error(`Brak tenanta "${TENANT_SLUG}"`)

  const catalog =
    (await prisma.warehouseCatalog.findFirst({ where: { tenantId: tenant.id, name: CATALOG_NAME } })) ??
    (await prisma.warehouseCatalog.findFirst({ where: { tenantId: tenant.id } }))
  if (!catalog) throw new Error('Brak katalogu magazynowego dla tenanta')

  const summary: any[] = []

  for (const product of PRODUCTS) {
    // Wyszukanie + zapis zamiast `upsert`: klucze zlozone w tej bazie nie
    // pokrywaja sie ze schematem w repozytorium (patrz komentarz na dole),
    // a `upsert` opiera sie wlasnie na nich.
    const existingProduct = await prisma.warehouseProduct.findFirst({
      where: { tenantId: tenant.id, sku: product.sku },
    })

    const productData = {
      name: product.name,
      retailPrice: product.retailPrice,
      isActive: true,
      isStockTracked: false,
    }

    const warehouseProduct = existingProduct
      ? await prisma.warehouseProduct.update({ where: { id: existingProduct.id }, data: productData })
      : await prisma.warehouseProduct.create({
          data: {
            tenantId: tenant.id,
            catalogId: catalog.id,
            sku: product.sku,
            unit: 'szt',
            ...productData,
          },
        })

    const existingMapping = await prisma.shopProductMapping.findFirst({
      where: { shopId: SHOP_ID, externalProductId: product.externalProductId },
    })

    const mappingData = {
      externalSku: product.sku,
      externalName: product.name,
      externalPrice: product.retailPrice,
      warehouseProductId: warehouseProduct.id,
      isActive: true,
      lastSyncAt: new Date(),
    }

    const mapping = existingMapping
      ? await prisma.shopProductMapping.update({ where: { id: existingMapping.id }, data: mappingData })
      : await prisma.shopProductMapping.create({
          data: {
            tenantId: tenant.id,
            shopId: SHOP_ID,
            externalProductId: product.externalProductId,
            personalizationEnabled: false,
            ...mappingData,
          },
        })

    summary.push({
      sku: product.sku,
      warehouseProductId: warehouseProduct.id,
      stockTracked: warehouseProduct.isStockTracked,
      mappingId: mapping.id,
      externalProductId: mapping.externalProductId,
      personalizationEnabledOnMapping: mapping.personalizationEnabled,
    })
  }

  console.log(JSON.stringify({ catalog: catalog.name, tenant: TENANT_SLUG, products: summary }, null, 2))
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
