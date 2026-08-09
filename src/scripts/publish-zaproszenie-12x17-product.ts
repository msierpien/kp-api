/**
 * Publikacja szablonu ZAPROSZENIE_12X17 jako produktu: karta w PrestaShop
 * (kreatywne-papierki.pl), produkt personalizowany w panelu i wpis w module
 * Magazyn, zeby zamowienie dalo sie dopiac do sprawy personalizacji.
 *
 * W przeciwienstwie do `publish-roczek-product.ts` karta ma JEDNA wersje -
 * personalizowana w edytorze. Nie ma wiec atrybutu ani kombinacji, a
 * dopasowanie zamowienia idzie po referencji SAMEGO PRODUKTU (`ZAP-12X17`):
 * tyle wystarczy, dopoki nie dojdzie wariant do samodzielnego uzupelnienia -
 * wtedy referencje musza przejac kombinacje, jak przy roczku.
 *
 * Zdjecia karty to mockupy szablonu wyrenderowane z domyslna trescia. Brak
 * mockupow w layoucie = karta zostaje bez zdjec (nie jest to blad).
 *
 * Skrypt jest idempotentny - produkt rozpoznaje po referencji, cechy po
 * nazwach, a wpisy w panelu i magazynie robi przez upsert.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/publish-zaproszenie-12x17-product.js
 *   PRODUCT_ACTIVE=0 - karta powstaje niewidoczna w sklepie
 *   REPLACE_PHOTOS=1 - przerysowanie i podmiana zdjec
 */
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { decrypt } from '../lib/encryption'
import { renderMockupPng } from '../services/renderer/fabric-renderer.service'
import {
  LANGUAGE_ID,
  cdata,
  localized,
  prestaShopApi,
  setLangTag,
  setTag,
  slugify,
  stripReadOnly,
  xmlValue,
  type PrestaShopApi,
} from './lib/prestashop-webservice'

const prisma = new PrismaClient()

const TENANT_SLUG = process.env.TENANT_SLUG || 'kreatywne-papierki'
const SHOP_ID = process.env.SHOP_ID || 'cmscv7k7l0001h4khpd8arr5i' // Kreatywne-papierki
const TEMPLATE_CODE = 'ZAPROSZENIE_12X17'
const CATALOG_NAME = 'Kreatywne Papierki'

/** Kategoria glowna + dodatkowa, w ktorej produkt tez ma byc widoczny. */
const CATEGORY_DEFAULT = '828' // Roczek
const CATEGORY_IDS = ['828', '834'] // + Zaproszenia urodzinowe

const TAX_RULES_GROUP_ID = '1' // PL Standard Rate (23%)
const TAX_RATE = 0.23

const REFERENCE = 'ZAP-12X17'
const PRODUCT_NAME = 'Zaproszenie na pierwsze urodziny – Królik 12 × 17 cm'

/** Cena katalogowa brutto; PrestaShop trzyma netto. */
const PRICE_GROSS = 6.5
const PRICE_NET = Number((PRICE_GROSS / (1 + TAX_RATE)).toFixed(6))

const PRODUCT_ACTIVE = process.env.PRODUCT_ACTIVE === '0' ? '0' : '1'

/** '0' = mapowanie produktu-rodzica; warianty maja tu id kombinacji. */
const PARENT_COMBINATION_ID = '0'

// --- Cechy -------------------------------------------------------------
// Identyfikatory cech sa stale w tym sklepie; wartosci dobieramy po nazwie
// i dokladamy tylko te, ktorych jeszcze nie ma.

const FEATURES: Array<{ featureId: string; value: string }> = [
  { featureId: '16', value: 'zaproszenie' }, // Typ produktu
  { featureId: '15', value: 'królik' }, // Motyw
  { featureId: '17', value: 'papier' }, // Materiał
  { featureId: '18', value: '12 x 17 cm' }, // Rozmiar
  { featureId: '28', value: 'Cała treść zaproszenia' }, // Personalizacja
]

// --- Tresci ------------------------------------------------------------

const META_TITLE = 'Zaproszenie na pierwsze urodziny Królik – 12 × 17 cm, personalizowane'
const META_DESCRIPTION =
  'Zaproszenie na roczek z akwarelowym królikiem, format 12 × 17 cm. Całą treść wpisujesz w edytorze: ' +
  'listę gości, datę z kalendarza, miejsce przyjęcia i prośbę o potwierdzenie.'

const DESCRIPTION_SHORT = `<p>Pionowe <strong>zaproszenie na pierwsze urodziny 12 × 17 cm</strong> z akwarelowym królikiem. Po złożeniu zamówienia otwierasz edytor i wpisujesz całą treść – od zwrotu do gości po odręczny podpis.</p>
<p>✔ osobny adresat na każdym zaproszeniu – wpisujesz listę gości<br />✔ data wybierana z kalendarza, godzina z listy<br />✔ druk dopiero po Twojej akceptacji podglądu</p>`

const DESCRIPTION = `<h2>Zaproszenie na pierwsze urodziny „Królik”</h2>
<p>Pionowe zaproszenie 12 × 17 cm z akwarelową ilustracją królika. Pastelowa, spokojna kompozycja pasuje do dekoracji w stylu boho i do klasycznych, stonowanych przyjęć – równie dobrze na roczek, jak na chrzciny czy drugie urodziny.</p>
<p>Pod ilustracją biegnie kolumna treści, a dół karty zajmuje pas trzech kolumn rozdzielonych delikatnymi liniami: <strong>data | miejsce przyjęcia | godzina</strong>.</p>

<h2>Co ustalasz w edytorze</h2>
<p>Po złożeniu zamówienia dostajesz dostęp do edytora, w którym wpisujesz:</p>
<ul>
<li><strong>listę gości</strong> – osobny adresat na każdym zaproszeniu w zamówieniu,</li>
<li><strong>datę przyjęcia</strong> – wybierasz ją z kalendarza, na karcie staje jako dzień z miesiącem i rok pod spodem,</li>
<li><strong>godzinę</strong> – z listy albo własną,</li>
<li><strong>miejsce przyjęcia</strong> – nazwa lokalu i adres,</li>
<li><strong>prośbę o potwierdzenie przybycia</strong> wraz z numerem telefonu,</li>
<li><strong>pozostałe napisy</strong> – zwrot wprowadzający, okazję i podpis; mają gotowe brzmienie, ale możesz je zmienić.</li>
</ul>
<p>Podgląd na bieżąco pokazuje gotowe zaproszenie, a my drukujemy dopiero po Twojej akceptacji.</p>

<h2>Specyfikacja produktu</h2>
<p><strong>Rodzaj:</strong> zaproszenie jednostronne<br /><strong>Format:</strong> 120 × 170 mm<br /><strong>Nadruk:</strong> kolorowy, jednostronny<br /><strong>Personalizacja:</strong> cała treść zaproszenia, adresat osobny dla każdej sztuki<br /><strong>Koperta:</strong> nie jest częścią zestawu – można dokupić osobno</p>

<h2>Jak zamówić</h2>
<ol>
<li>Podaj liczbę zaproszeń.</li>
<li>Po złożeniu zamówienia otwierasz edytor i wpisujesz treść oraz listę gości.</li>
<li>Akceptujesz podgląd – drukujemy i wysyłamy gotowe zaproszenia.</li>
</ol>

<h2>Na jaką okazję</h2>
<ul>
<li>pierwsze urodziny i roczek</li>
<li>drugie urodziny dziecka</li>
<li>chrzciny i baby shower w tej samej kolorystyce</li>
</ul>`

// --- Zdjecia produktu --------------------------------------------------

/**
 * Zdjecia karty: mockupy szablonu wyrenderowane z domyslna trescia, wiec
 * klient oglada dokladnie to, co dostanie. Brak mockupow = brak zdjec,
 * a nie blad - karta moze poczekac na grafike.
 *
 * Szablon z wariantami (pierwsze / drugie / trzecie urodziny) dostaje zdjecie
 * KAZDEGO wariantu: `renderMockupPng` wybiera strony przez
 * `getTemplatePagesForAnswers`, wiec wystarczy podstawic odpowiedz, ktora
 * dopasowuje dany wariant.
 */
async function ensureProductPhotos(layout: any, force: boolean) {
  const mockups: any[] = layout?.mockups || []
  if (mockups.length === 0) return []

  const base = await defaultAnswers()
  const variantFieldKey: string | undefined = layout?.variantFieldKey
  const variants: any[] = Array.isArray(layout?.variants) ? layout.variants : []

  // Bez wariantow zostaje jedno ujecie na mockup - jak przy karcie bez wyboru.
  const shots =
    variantFieldKey && variants.length > 0
      ? variants.map((variant) => ({
          suffix: variant.id,
          answers: { ...base, [variantFieldKey]: variant.matchValue ?? base[variantFieldKey] },
        }))
      : [{ suffix: 'default', answers: base }]

  const dir = path.join(process.cwd(), 'storage', 'templates', TEMPLATE_CODE, 'produkt')
  const files: string[] = []

  const jobs = mockups.flatMap((mockup, index) =>
    shots.map((shot) => ({ mockup, name: `zaproszenie-12x17-${shot.suffix}-${index + 1}.jpg`, answers: shot.answers }))
  )

  for (const job of jobs) {
    const { mockup, answers } = job
    const absolute = path.join(dir, job.name)
    if (fs.existsSync(absolute) && !force) {
      files.push(absolute)
      continue
    }

    const png = await renderMockupPng(layout, answers, mockup)

    // PrestaShop odrzuca pliki powyzej 2000 KB, a render PNG wazy okolo 2 MB.
    const { createCanvas, loadImage } = await import('canvas')
    const image = await loadImage(png)
    const canvas = createCanvas(image.width, image.height)
    canvas.getContext('2d').drawImage(image as any, 0, 0)

    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(absolute, canvas.toBuffer('image/jpeg', { quality: 0.9 }))
    files.push(absolute)
  }

  return files
}

/** Domyslne odpowiedzi z formularza - to one wypelniaja zdjecia pogladowe. */
async function defaultAnswers() {
  const fields = await prisma.formField.findMany({
    where: { form: { template: { code: TEMPLATE_CODE } } },
  })
  return Object.fromEntries(fields.map((field) => [field.key, field.defaultValue ?? '']))
}

// --- Cechy w sklepie ---------------------------------------------------

async function ensureFeatureValues(shop: PrestaShopApi) {
  const pairs: Array<{ featureId: string; valueId: string }> = []

  for (const feature of FEATURES) {
    // `limit` musi objac WSZYSTKIE wartosci cechy: przy domyslnym oknie
    // istniejaca wartosc wypadala poza lista i skrypt zakladal jej duplikat.
    const values = await shop.getJson<any>(
      `product_feature_values?display=full&filter[id_feature]=[${feature.featureId}]&limit=0,5000`
    )
    const existing = (values.product_feature_values || []).find(
      (item: any) => localized(item.value).trim().toLowerCase() === feature.value.toLowerCase()
    )

    if (existing) {
      pairs.push({ featureId: feature.featureId, valueId: String(existing.id) })
      continue
    }

    const payload = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product_feature_value>
    <id_feature>${feature.featureId}</id_feature>
    <custom>0</custom>
    <value><language id="${LANGUAGE_ID}"><![CDATA[${cdata(feature.value)}]]></language></value>
  </product_feature_value>
</prestashop>`

    pairs.push({
      featureId: feature.featureId,
      valueId: xmlValue(await shop.sendXml('product_feature_values', 'POST', payload), 'id'),
    })
  }

  return pairs
}

// --- Produkt -----------------------------------------------------------

function categoriesBlock() {
  const items = CATEGORY_IDS.map((id) => `      <category><id>${id}</id></category>`).join('\n')
  return `    <categories nodeType="category" api="categories">\n${items}\n    </categories>`
}

function featuresBlock(pairs: Array<{ featureId: string; valueId: string }>) {
  const items = pairs
    .map(
      (pair) =>
        `      <product_feature><id>${pair.featureId}</id><id_feature_value>${pair.valueId}</id_feature_value></product_feature>`
    )
    .join('\n')
  return `    <product_features nodeType="product_feature" api="product_features">\n${items}\n    </product_features>`
}

/** Podmienia caly blok w `<associations>` (kategorie, cechy). */
function setAssociationBlock(xml: string, blockName: string, block: string) {
  const pattern = new RegExp(`<${blockName}(\\s[^>]*)?(/>|>[\\s\\S]*?</${blockName}>)`)
  return pattern.test(xml) ? xml.replace(pattern, block.trim()) : xml
}

async function findProductIdByReference(shop: PrestaShopApi) {
  const data = await shop.getJson<any>(
    `products?filter[reference]=[${encodeURIComponent(REFERENCE)}]&display=[id,reference]&limit=1`
  )
  const products = data.products ? (Array.isArray(data.products) ? data.products : [data.products]) : []
  return products[0] ? String(products[0].id) : null
}

async function createProduct(shop: PrestaShopApi) {
  const payload = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product>
    <id_shop_default>1</id_shop_default>
    <id_category_default>${CATEGORY_DEFAULT}</id_category_default>
    <id_tax_rules_group>${TAX_RULES_GROUP_ID}</id_tax_rules_group>
    <state>1</state>
    <reference><![CDATA[${cdata(REFERENCE)}]]></reference>
    <price>${PRICE_NET}</price>
    <minimal_quantity>1</minimal_quantity>
    <active>${PRODUCT_ACTIVE}</active>
    <available_for_order>1</available_for_order>
    <show_price>1</show_price>
    <visibility>both</visibility>
    <name><language id="${LANGUAGE_ID}"><![CDATA[${cdata(PRODUCT_NAME)}]]></language></name>
    <link_rewrite><language id="${LANGUAGE_ID}"><![CDATA[${slugify(PRODUCT_NAME)}]]></language></link_rewrite>
    <description><language id="${LANGUAGE_ID}"><![CDATA[${cdata(DESCRIPTION)}]]></language></description>
    <description_short><language id="${LANGUAGE_ID}"><![CDATA[${cdata(DESCRIPTION_SHORT)}]]></language></description_short>
    <meta_title><language id="${LANGUAGE_ID}"><![CDATA[${cdata(META_TITLE)}]]></language></meta_title>
    <meta_description><language id="${LANGUAGE_ID}"><![CDATA[${cdata(META_DESCRIPTION)}]]></language></meta_description>
    <associations>
${categoriesBlock()}
    </associations>
  </product>
</prestashop>`

  const id = xmlValue(await shop.sendXml('products', 'POST', payload), 'id')
  if (!id) throw new Error('PrestaShop nie zwrocil id nowego produktu')
  return id
}

async function updateProduct(
  shop: PrestaShopApi,
  productId: string,
  features: Array<{ featureId: string; valueId: string }>
) {
  let xml = await shop.getXml(`products/${productId}`)
  xml = stripReadOnly(xml)
  xml = setTag(xml, 'price', String(PRICE_NET))
  xml = setTag(xml, 'active', PRODUCT_ACTIVE)
  xml = setTag(xml, 'available_for_order', '1')
  xml = setTag(xml, 'minimal_quantity', '1')
  xml = setTag(xml, 'id_tax_rules_group', TAX_RULES_GROUP_ID)
  xml = setTag(xml, 'id_category_default', CATEGORY_DEFAULT)
  xml = setLangTag(xml, 'name', PRODUCT_NAME)
  xml = setLangTag(xml, 'link_rewrite', slugify(PRODUCT_NAME))
  xml = setLangTag(xml, 'description', DESCRIPTION)
  xml = setLangTag(xml, 'description_short', DESCRIPTION_SHORT)
  xml = setLangTag(xml, 'meta_title', META_TITLE)
  xml = setLangTag(xml, 'meta_description', META_DESCRIPTION)
  xml = setAssociationBlock(xml, 'categories', categoriesBlock())
  xml = setAssociationBlock(xml, 'product_features', featuresBlock(features))
  await shop.sendXml(`products/${productId}`, 'PUT', xml)
}

/** Zaproszenia powstaja na zamowienie - stan zerowy, ale sprzedaz otwarta. */
async function allowOrdersWithoutStock(shop: PrestaShopApi, productId: string) {
  const stock = await shop.getJson<any>(`stock_availables?display=full&filter[id_product]=[${productId}]`)
  for (const entry of stock.stock_availables || []) {
    const xml = await shop.getXml(`stock_availables/${entry.id}`)
    await shop.sendXml(`stock_availables/${entry.id}`, 'PUT', setTag(xml, 'out_of_stock', '1'))
  }
}

// --- Panel i magazyn ---------------------------------------------------

/**
 * Produkt personalizowany dopasowywany po referencji karty - jedyna wersja
 * tego zaproszenia jest personalizowana, wiec nie ma czego rozdzielac.
 */
async function ensurePersonalizedProduct(templateId: string, externalProductId: string) {
  const existing = await prisma.personalizedProduct.findFirst({
    where: { shopId: SHOP_ID, identifierType: 'SKU', identifierValue: REFERENCE },
  })

  // `externalProductId` panel tylko przechowuje (dopasowanie zamowien idzie po
  // referencji), ale bez niego nie widac, ktora karta w sklepie to jest.
  const data = { name: PRODUCT_NAME, templateId, externalProductId, isActive: true }

  if (existing) {
    return prisma.personalizedProduct.update({ where: { id: existing.id }, data })
  }

  return prisma.personalizedProduct.create({
    data: { shopId: SHOP_ID, identifierType: 'SKU', identifierValue: REFERENCE, ...data },
  })
}

/**
 * Wpis w module Magazyn - to samo, co robi import ze sklepu, ale punktowo.
 *
 * `isStockTracked = false`, bo papeteria powstaje na zamowienie: przy
 * wlaczonym sledzeniu synchronizacja stanow wyslalaby do PrestaShop zero
 * i zamknela sprzedaz.
 *
 * `personalizationEnabled` NA MAPOWANIU zostaje wlaczone - inaczej niz przy
 * roczku. Tam flaga musiala byc wylaczona, bo karta ma dwie wersje i sciezka
 * przez mapowanie objelaby takze te do samodzielnego uzupelnienia. Tu wersja
 * jest jedna, wiec nie ma czego rozdzielac, a `orders.service` bierze szablon
 * z mapowania ALBO z produktu personalizowanego (`mappingTemplate ||
 * personalizedProduct?.template`) - jedna sprawa, nie dwie. Produkt
 * personalizowany zostaje jako sciezka zapasowa.
 */
async function ensureWarehouseEntry(tenantId: string, externalProductId: string, templateId: string) {
  const catalog =
    (await prisma.warehouseCatalog.findFirst({ where: { tenantId, name: CATALOG_NAME } })) ??
    (await prisma.warehouseCatalog.findFirst({ where: { tenantId } }))
  if (!catalog) throw new Error('Brak katalogu magazynowego dla tenanta')

  const productData = {
    name: PRODUCT_NAME,
    retailPrice: PRICE_GROSS,
    isActive: true,
    isStockTracked: false,
  }

  const warehouseProduct = await prisma.warehouseProduct.upsert({
    where: { tenantId_sku: { tenantId, sku: REFERENCE } },
    create: { tenantId, catalogId: catalog.id, sku: REFERENCE, unit: 'szt', ...productData },
    update: productData,
  })

  const mappingData = {
    externalSku: REFERENCE,
    externalName: PRODUCT_NAME,
    externalPrice: PRICE_GROSS,
    warehouseProductId: warehouseProduct.id,
    personalizationEnabled: true,
    personalizationTemplateId: templateId,
    isActive: true,
    lastSyncAt: new Date(),
  }

  const mapping = await prisma.shopProductMapping.upsert({
    where: {
      shopId_externalProductId_externalCombinationId: {
        shopId: SHOP_ID,
        externalProductId,
        externalCombinationId: PARENT_COMBINATION_ID,
      },
    },
    create: {
      tenantId,
      shopId: SHOP_ID,
      externalProductId,
      externalCombinationId: PARENT_COMBINATION_ID,
      ...mappingData,
    },
    update: mappingData,
  })

  return { catalog, warehouseProduct, mapping }
}

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new Error(`Brak tenanta "${TENANT_SLUG}"`)

  const template = await prisma.personalizationTemplate.findFirst({ where: { code: TEMPLATE_CODE } })
  if (!template) throw new Error(`Brak szablonu ${TEMPLATE_CODE}`)

  const shopRecord = await prisma.shop.findUnique({ where: { id: SHOP_ID } })
  if (!shopRecord) throw new Error(`Brak sklepu ${SHOP_ID}`)
  const shop = prestaShopApi({ baseUrl: shopRecord.baseUrl, apiKey: decrypt(shopRecord.apiKey) })

  const replacePhotos = process.env.REPLACE_PHOTOS === '1'
  const photos = await ensureProductPhotos(template.layoutJson as any, replacePhotos)

  let productId = await findProductIdByReference(shop)
  const created = !productId
  if (!productId) productId = await createProduct(shop)

  const features = await ensureFeatureValues(shop)
  await updateProduct(shop, productId, features)
  await allowOrdersWithoutStock(shop, productId)

  const personalizedProduct = await ensurePersonalizedProduct(template.id, productId)
  const warehouse = await ensureWarehouseEntry(tenant.id, productId, template.id)

  const product = await shop.getJson<any>(`products/${productId}`)
  const images: any[] = product.product?.associations?.images || []

  if (replacePhotos) {
    for (const image of images) {
      await shop.deleteResource(`images/products/${productId}/${image.id}`)
    }
  }
  if (photos.length > 0 && (images.length === 0 || replacePhotos)) {
    for (const photo of photos) {
      await shop.uploadImage(productId, photo)
    }
  }

  console.log(
    JSON.stringify(
      {
        prestashop: {
          productId,
          created,
          reference: REFERENCE,
          name: PRODUCT_NAME,
          active: PRODUCT_ACTIVE === '1',
          priceNet: PRICE_NET,
          priceGross: PRICE_GROSS,
          categories: CATEGORY_IDS,
          features: features.map((item) => `${item.featureId}=${item.valueId}`),
          zdjecia:
            photos.length > 0 && (images.length === 0 || replacePhotos)
              ? photos.map((file) => path.basename(file))
              : `bez zmian (${images.length})`,
          url: `${shopRecord.baseUrl}/index.php?id_product=${productId}&controller=product`,
        },
        panel: {
          personalizedProductId: personalizedProduct.id,
          identifierValue: personalizedProduct.identifierValue,
          templateId: template.id,
          templateCode: TEMPLATE_CODE,
          shop: shopRecord.name,
        },
        magazyn: {
          catalog: warehouse.catalog.name,
          warehouseProductId: warehouse.warehouseProduct.id,
          sku: warehouse.warehouseProduct.sku,
          stockTracked: warehouse.warehouseProduct.isStockTracked,
          mappingId: warehouse.mapping.id,
          personalizationEnabledOnMapping: warehouse.mapping.personalizationEnabled,
          personalizationTemplateIdOnMapping: warehouse.mapping.personalizationTemplateId,
        },
      },
      null,
      2
    )
  )
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
