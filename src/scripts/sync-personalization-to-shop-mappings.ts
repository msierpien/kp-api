/**
 * Przenosi wiedze z produktow personalizowanych na mapowania sklepowe, zeby
 * widok "Mapowania produktow" pokazywal komplet: produkt sklepu -> produkt
 * magazynowy -> szablon personalizacji.
 *
 * Panel trzyma te informacje w dwoch miejscach:
 *   - Personalizacja > Produkty personalizowane (`PersonalizedProduct`),
 *     dopasowanie po SKU/EAN z pozycji zamowienia,
 *   - Magazyn > Mapowania (`ShopProductMapping.personalizationEnabled`
 *     + `personalizationTemplateId`).
 * Import zamowien obsluguje obie sciezki, ale tylko druga widac w magazynie.
 *
 * Skrypt dla kazdego produktu personalizowanego szuka mapowania o tym samym
 * SKU w tym samym sklepie i uzupelnia brakujace ogniwa:
 *   1. brak mapowania -> szuka pozycji w sklepie po referencji (produkt, potem
 *      kombinacja) i zaklada mapowanie; import masowy pomija produkty
 *      zalozone po jego ostatnim przebiegu,
 *   2. brak karty magazynowej -> zaklada ja (bez sledzenia stanow: papeteria
 *      powstaje na zamowienie, a sledzony stan 0 zamknalby sprzedaz),
 *   3. brak szablonu na mapowaniu -> dopina ten z produktu personalizowanego.
 *
 * Czego NIE robi: nie dotyka mapowan, ktore nie maja odpowiednika wsrod
 * produktow personalizowanych. Dzieki temu wariant sprzedawany bez edytora
 * (np. zaproszenie "do samodzielnego uzupelnienia") zostaje bez personalizacji.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/sync-personalization-to-shop-mappings.js
 *   DRY_RUN=1 - tylko raport, bez zapisu
 */
import { PrismaClient } from '@prisma/client'
import { decrypt } from '../lib/encryption'
import { prestaShopApi, type PrestaShopApi } from './lib/prestashop-webservice'

const prisma = new PrismaClient()

const TENANT_SLUG = process.env.TENANT_SLUG || 'kreatywne-papierki'
const DRY_RUN = process.env.DRY_RUN === '1'

type Report = {
  polaczone: string[]
  juzBylo: string[]
  bezMapowania: string[]
  szablonyBezProduktu: string[]
}

/** Stawki VAT grup podatkowych sklepu - webservice oddaje ceny netto. */
const TAX_RATES: Record<string, number> = { '1': 0.23, '2': 0.08, '3': 0.05, '4': 0 }

const grossPrice = (net: number | null, taxRulesGroupId: unknown) => {
  if (net === null) return null
  const rate = TAX_RATES[String(taxRulesGroupId ?? '1')] ?? 0.23
  return Number((net * (1 + rate)).toFixed(2))
}

/**
 * Pozycja w sklepie o danej referencji: najpierw produkt, potem kombinacja.
 * Cena wychodzi brutto - tyle widzi klient i tyle pokazuje kolumna "Cena
 * sklepu" przy pozostalych produktach personalizowanych.
 * Zwraca `null`, gdy sklep takiej referencji nie zna.
 */
async function findShopPosition(shop: PrestaShopApi, reference: string) {
  const encoded = encodeURIComponent(reference)

  const products = await shop.getJson<any>(
    `products?filter[reference]=[${encoded}]&display=[id,reference,name,price,active,id_tax_rules_group]&limit=1`
  )
  const product = toArray(products.products)[0]
  if (product) {
    return {
      externalProductId: String(product.id),
      externalCombinationId: '0',
      name: localizedName(product.name),
      price: grossPrice(numberOrNull(product.price), product.id_tax_rules_group),
      active: String(product.active ?? '1') !== '0',
    }
  }

  const combinations = await shop.getJson<any>(
    `combinations?filter[reference]=[${encoded}]&display=[id,id_product,reference,price]&limit=1`
  )
  const combination = toArray(combinations.combinations)[0]
  if (!combination) return null

  const parentResponse = await shop.getJson<any>(
    `products/${combination.id_product}?display=[id,name,price,active,id_tax_rules_group]`
  )
  // Webservice raz oddaje `product`, raz liste `products` - zaleznie od tego,
  // czy pytamy o zasob, czy o jego okrojony widok.
  const parent = parentResponse.product ?? toArray(parentResponse.products)[0] ?? {}
  const parentPrice = numberOrNull(parent.price)
  const impact = numberOrNull(combination.price) ?? 0

  return {
    externalProductId: String(combination.id_product),
    externalCombinationId: String(combination.id),
    name: localizedName(parent.name),
    price: parentPrice === null ? null : grossPrice(parentPrice + impact, parent.id_tax_rules_group),
    active: String(parent.active ?? '1') !== '0',
  }
}

const toArray = (value: unknown) => (Array.isArray(value) ? value : value ? [value] : [])
const numberOrNull = (value: unknown) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
const localizedName = (value: unknown) =>
  Array.isArray(value) ? String((value[0] as any)?.value ?? '') : String(value ?? '')

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new Error(`Brak tenanta "${TENANT_SLUG}"`)

  const catalog =
    (await prisma.warehouseCatalog.findFirst({ where: { tenantId: tenant.id, name: 'Kreatywne Papierki' } })) ??
    (await prisma.warehouseCatalog.findFirst({ where: { tenantId: tenant.id } }))
  if (!catalog) throw new Error('Brak katalogu magazynowego')

  const personalizedProducts = await prisma.personalizedProduct.findMany({
    where: { isActive: true, shop: { tenantId: tenant.id } },
    include: { shop: { select: { id: true, name: true, platform: true } }, template: { select: { id: true, code: true } } },
  })

  const report: Report = { polaczone: [], juzBylo: [], bezMapowania: [], szablonyBezProduktu: [] }

  for (const item of personalizedProducts) {
    const label = `${item.identifierValue} (${item.template.code}, ${item.shop.name})`

    // Sklepy MANUAL nie maja katalogu po stronie sklepu, wiec i mapowan.
    if (item.shop.platform !== 'PRESTASHOP') {
      report.bezMapowania.push(`${label} - sklep bez katalogu (${item.shop.platform})`)
      continue
    }

    let mapping = await prisma.shopProductMapping.findFirst({
      where: {
        shopId: item.shop.id,
        externalSku: { equals: item.identifierValue, mode: 'insensitive' },
      },
      include: { warehouseProduct: { select: { id: true, sku: true } } },
    })

    if (!mapping) {
      const shopRecord = await prisma.shop.findUnique({ where: { id: item.shop.id } })
      if (!shopRecord?.apiKey) {
        report.bezMapowania.push(`${label} - sklep bez klucza API`)
        continue
      }

      const shopApi = prestaShopApi({ baseUrl: shopRecord.baseUrl, apiKey: decrypt(shopRecord.apiKey) })
      const position = await findShopPosition(shopApi, item.identifierValue)
      if (!position) {
        report.bezMapowania.push(`${label} - sklep nie zna tej referencji`)
        continue
      }

      if (DRY_RUN) {
        report.polaczone.push(`${label} - mapowanie + karta magazynowa + szablon (do zalozenia)`)
        continue
      }

      mapping = await prisma.shopProductMapping.create({
        data: {
          tenantId: tenant.id,
          shopId: item.shop.id,
          externalProductId: position.externalProductId,
          externalCombinationId: position.externalCombinationId,
          externalSku: item.identifierValue,
          externalName: position.name || item.name,
          externalPrice: position.price ?? undefined,
          isActive: position.active,
          lastSyncAt: new Date(),
        },
        include: { warehouseProduct: { select: { id: true, sku: true } } },
      })
    }

    const needsWarehouse = !mapping.warehouseProductId
    const needsTemplate = !mapping.personalizationEnabled || mapping.personalizationTemplateId !== item.template.id
    // Mapowanie zalozone recznie bywa bez ceny - w widoku mapowan zostaje wtedy
    // pusta kolumna "Cena sklepu", wiec dociagamy ja ze sklepu.
    const needsPrice = mapping.externalPrice === null

    if (!needsWarehouse && !needsTemplate && !needsPrice) {
      report.juzBylo.push(label)
      continue
    }

    const changes = [
      needsWarehouse ? 'karta magazynowa' : null,
      needsTemplate ? 'szablon' : null,
      needsPrice ? 'cena' : null,
    ].filter(Boolean)

    if (DRY_RUN) {
      report.polaczone.push(`${label} - ${changes.join(' + ')}`)
      continue
    }

    let externalPrice = mapping.externalPrice
    if (needsPrice) {
      const shopRecord = await prisma.shop.findUnique({ where: { id: item.shop.id } })
      if (shopRecord?.apiKey) {
        const shopApi = prestaShopApi({ baseUrl: shopRecord.baseUrl, apiKey: decrypt(shopRecord.apiKey) })
        const position = await findShopPosition(shopApi, item.identifierValue)
        if (position?.price !== null && position?.price !== undefined) {
          externalPrice = position.price as any
        }
      }
    }

    let warehouseProductId = mapping.warehouseProductId
    if (needsWarehouse) {
      const warehouseProduct = await prisma.warehouseProduct.upsert({
        where: { tenantId_sku: { tenantId: tenant.id, sku: mapping.externalSku } },
        create: {
          tenantId: tenant.id,
          catalogId: catalog.id,
          sku: mapping.externalSku,
          name: mapping.externalName || item.name,
          unit: 'szt',
          retailPrice: mapping.externalPrice ?? undefined,
          isActive: true,
          isStockTracked: false,
        },
        update: { isActive: true, isStockTracked: false },
      })
      warehouseProductId = warehouseProduct.id
    }

    await prisma.shopProductMapping.update({
      where: { id: mapping.id },
      data: {
        warehouseProductId,
        personalizationEnabled: true,
        personalizationTemplateId: item.template.id,
        externalPrice: externalPrice ?? undefined,
      },
    })

    report.polaczone.push(`${label} - ${changes.join(' + ')}`)
  }

  // Szablony, ktorych nie ma jak podpiac - brakuje im produktu w sklepie.
  const templates = await prisma.personalizationTemplate.findMany({
    where: { tenantId: tenant.id, isActive: true },
    select: {
      code: true,
      _count: { select: { personalizedProducts: true, shopProductMappings: true } },
    },
    orderBy: { code: 'asc' },
  })
  for (const template of templates) {
    if (template._count.personalizedProducts === 0 && template._count.shopProductMappings === 0) {
      report.szablonyBezProduktu.push(template.code)
    }
  }

  console.log(JSON.stringify({ dryRun: DRY_RUN, ...report }, null, 2))
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
