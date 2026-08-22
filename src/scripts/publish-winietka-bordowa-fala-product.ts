/**
 * Publikacja szablonu WINIETKA_E1 jako produktu: karta w PrestaShop
 * (kreatywne-papierki.pl), produkt personalizowany w panelu i wpis w module
 * Magazyn.
 *
 * Winietka jest SKLADANA: layout ma dwie strony, a `print.placements` sklada
 * je na arkuszu 105 x 100 mm z przodem obroconym o 180 stopni, zeby po
 * zgieciu napis stal do goscia. Sa tez dwa mockupy - przod i tyl - wiec
 * galeria dostaje dwa ujecia bez zadnej dodatkowej konfiguracji.
 *
 * Imie goscia to pole `INDIVIDUAL`: panel wystawia tyle wpisow, ile sztuk
 * w zamowieniu, czyli klient wkleja cala liste gosci naraz.
 *
 * PARA Z MENU. `PARTNER_REFERENCE` wskazuje menu z tej samej kolekcji
 * (`MENU-80X165`). Skrypt wpina je w `accessories`, czyli blok "propozycje"
 * na karcie produktu, i to samo robi skrypt menu w druga strone.
 *
 * Skrypt jest idempotentny - produkt rozpoznaje po referencji, cechy po
 * nazwach, a wpisy w panelu i magazynie robi przez upsert.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/publish-winietka-bordowa-fala-product.js
 *   PHOTO_ONLY=1     - zatrzymanie po wyrenderowaniu zdjec, sklep nietkniety
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
const TEMPLATE_CODE = 'WINIETKA_E1'
const CATALOG_NAME = 'Kreatywne Papierki'

/** Kategoria glowna + dodatkowa, w ktorej produkt tez ma byc widoczny. */
const CATEGORY_DEFAULT = '839' // Winietki i numery stołów (Ślub i wesele)
const CATEGORY_IDS = ['839', '49'] // + Winietki i wizytówki na stół (Papeteria)

const TAX_RULES_GROUP_ID = '1' // PL Standard Rate (23%)
const TAX_RATE = 0.23

const REFERENCE = 'WIN-BORDOWA-FALA'
const PRODUCT_NAME = 'Winietka personalizowana na stół – Bordowa Fala, składana 10,5 × 5 cm'

/** Menu z tej samej kolekcji - obie karty polecaja sie wzajemnie. */
const PARTNER_REFERENCE = 'MENU-80X165'

const PRICE_GROSS = Number(process.env.PRICE_GROSS || 1.9)
const PRICE_NET = Number((PRICE_GROSS / (1 + TAX_RATE)).toFixed(6))

const PRODUCT_ACTIVE = process.env.PRODUCT_ACTIVE === '0' ? '0' : '1'

/** '0' = mapowanie produktu-rodzica; warianty maja tu id kombinacji. */
const PARENT_COMBINATION_ID = '0'

// --- Cechy -------------------------------------------------------------

const FEATURES: Array<{ featureId: string; value: string }> = [
  { featureId: '16', value: 'winietka' }, // Typ produktu
  { featureId: '15', value: 'bordowa fala' }, // Motyw
  { featureId: '17', value: 'papier' }, // Materiał
  { featureId: '18', value: '10,5 x 5 cm' }, // Rozmiar
  { featureId: '28', value: 'Imię i nazwisko gościa' }, // Personalizacja
]

// --- Tresci ------------------------------------------------------------

const META_TITLE = 'Winietka na stół personalizowana – Bordowa Fala, składana 10,5 × 5 cm'
const META_DESCRIPTION =
  'Składana winietka weselna 10,5 × 5 cm z bordową falowaną ramką i imieniem gościa pismem odręcznym. ' +
  'Wklejasz całą listę gości naraz, kolor wiodący zmieniasz jednym kliknięciem. 1,90 zł za sztukę.'

const DESCRIPTION_SHORT = `<p><strong>Składana winietka na stół 10,5 × 5 cm</strong> z bordową, odręcznie rysowaną ramką i imieniem gościa pismem kaligraficznym. Do kompletu z <strong>menu „Bordowa Fala”</strong>.</p>
<p>✔ osobne imię na każdej sztuce – wklejasz całą listę gości naraz<br />✔ kartka stoi sama, nie potrzebuje stojaka<br />✔ ozdobny listek nadrukowany również z tyłu<br />✔ kolor wiodący zmieniasz jednym kliknięciem</p>`

const DESCRIPTION = `<h2>Winietka na stół „Bordowa Fala”</h2>
<p>Składana kartka 10,5 × 5 cm, która po zgięciu stoi na talerzu albo na obrusie – bez stojaka, bez klipsa, bez dodatkowych elementów. Z przodu bordowa ramka rysowana odręczną kreską, pod nią imię i nazwisko gościa pismem kaligraficznym. Z tyłu ten sam bordowy listek, więc karta wygląda dobrze także z drugiej strony stołu.</p>
<p>Ta sama kreska i ten sam bordowy wracają na <strong>menu „Bordowa Fala”</strong> z falowaną krawędzią – razem tworzą komplet na jedno nakrycie.</p>

<h2>Lista gości bez przepisywania</h2>
<p>Imię i nazwisko to pole ustawiane <strong>osobno dla każdej sztuki</strong>. Zamawiasz 80 winietek i dostajesz 80 pól do wypełnienia – a listę możesz wkleić z arkusza w jednym kroku, zamiast klikać nazwisko po nazwisku.</p>

<h2>Co ustalasz w edytorze</h2>
<ul>
<li><strong>imię i nazwisko każdego gościa</strong> – osobno na każdej winietce,</li>
<li><strong>kolor wiodący</strong> – napis i ozdobniki przestawiają się razem, więc butelkowa zieleń albo granat to jedno kliknięcie.</li>
</ul>
<p>Podgląd na bieżąco pokazuje gotową kartę, a my drukujemy dopiero po Twojej akceptacji.</p>

<h2>Specyfikacja produktu</h2>
<p><strong>Rodzaj:</strong> winietka składana, zadrukowana dwustronnie<br /><strong>Format po złożeniu:</strong> 105 × 50 mm<br /><strong>Nadruk:</strong> kolorowy, przód i tył<br /><strong>Personalizacja:</strong> imię i nazwisko gościa osobno na każdej sztuce, kolor wiodący<br /><strong>Cena:</strong> za sztukę</p>

<h2>Jak zamówić</h2>
<ol>
<li>Podaj liczbę winietek – zwykle po jednej na gościa.</li>
<li>Po złożeniu zamówienia otwierasz edytor i wklejasz listę gości.</li>
<li>Akceptujesz podgląd – drukujemy, bigujemy i wysyłamy gotowe do złożenia.</li>
</ol>

<h2>Do kompletu</h2>
<ul>
<li><strong>Menu „Bordowa Fala”</strong> – ta sama kreska i kolor, falowana krawędź wycinana ploterem</li>
</ul>`

// --- Zdjecia produktu --------------------------------------------------

/**
 * Ile razy szerszy od KARTY ma byc kadr danego ujecia.
 *
 * Winietka 105 x 50 mm zajmuje na scenie zdjeciowej niecala polowe szerokosci
 * i ledwie czwarta czesc wysokosci - w pelnym kadrze ginie miedzy talerzem
 * a serwetka. Kadr liczymy od naroznikow powierzchni mockupu, wiec zmiana
 * mockupu w panelu nie wymaga tu zadnej korekty.
 *
 * 1,0 = sama karta bez marginesu. Brak wpisu = pelny kadr sceny.
 */
const PHOTO_FRAME_RATIO: Record<number, number> = {
  0: 1.45, // Ujecie 1 - okladka, karta ma byc czytelna z miniatury
}

/**
 * Wycinek wokol karty, w proporcji ORYGINALU - obie fotografie zostaja wtedy
 * tego samego ksztaltu i galeria nie skacze. Kadr jest docinany do krawedzi
 * zdjecia, a przy okazji przesuwany do srodka, zeby przyciecie z jednej strony
 * nie zjadalo marginesu z drugiej.
 */
function surfaceCrop(mockup: any, width: number, height: number, ratio?: number) {
  const corners: Array<{ x: number; y: number }> = mockup?.surfaces?.[0]?.corners ?? []
  if (!ratio || corners.length === 0) return { x: 0, y: 0, width, height }

  const xs = corners.map((corner) => corner.x)
  const ys = corners.map((corner) => corner.y)
  const cardWidth = (Math.max(...xs) - Math.min(...xs)) * width
  const centerX = ((Math.min(...xs) + Math.max(...xs)) / 2) * width
  const centerY = ((Math.min(...ys) + Math.max(...ys)) / 2) * height

  const cropWidth = Math.min(width, Math.round(cardWidth * ratio))
  const cropHeight = Math.min(height, Math.round((cropWidth * height) / width))

  const clamp = (value: number, max: number) => Math.max(0, Math.min(value, max))

  return {
    x: clamp(Math.round(centerX - cropWidth / 2), width - cropWidth),
    y: clamp(Math.round(centerY - cropHeight / 2), height - cropHeight),
    width: cropWidth,
    height: cropHeight,
  }
}

/**
 * Zdjecia karty: mockupy szablonu wyrenderowane realna trescia, wiec klient
 * oglada dokladnie to, co dostanie. Brak mockupow = brak zdjec, a nie blad.
 *
 * Ten szablon nie ma wariantow, ma za to DWA mockupy - przod i tyl karty -
 * wiec galeria dostaje dwa ujecia. Obsluga wariantow zostaje na wypadek,
 * gdyby doszly (np. wersja z numerem stolu); przy pustej liscie wychodzi
 * jedno ujecie na mockup.
 */
async function ensureProductPhotos(layout: any, force: boolean) {
  const mockups: any[] = layout?.mockups || []
  if (mockups.length === 0) return []

  const base = await defaultAnswers()
  const variantFieldKey: string | undefined = layout?.variantFieldKey
  const variants: any[] = Array.isArray(layout?.variants) ? layout.variants : []

  const shots =
    variantFieldKey && variants.length > 0
      ? variants.map((variant) => ({
          suffix: variant.id,
          answers: { ...base, [variantFieldKey]: variant.matchValue ?? base[variantFieldKey] },
        }))
      : [{ suffix: 'default', answers: base }]

  const dir = path.join(process.cwd(), 'storage', 'templates', TEMPLATE_CODE, 'produkt')
  const files: string[] = []

  const jobs = shots.flatMap((shot) =>
    mockups.map((mockup, index) => ({
      mockup,
      index,
      name: `winietka-bordowa-fala-${shot.suffix}-${index + 1}.jpg`,
      answers: shot.answers,
    }))
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
    const crop = surfaceCrop(mockup, image.width, image.height, PHOTO_FRAME_RATIO[job.index])
    const canvas = createCanvas(crop.width, crop.height)
    canvas
      .getContext('2d')
      .drawImage(image as any, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)

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

/** Blok "propozycji" na karcie produktu - pusty, gdy partnera jeszcze nie ma. */
function accessoriesBlock(partnerId: string | null) {
  const items = partnerId ? `      <product><id>${partnerId}</id></product>\n` : ''
  return `    <accessories nodeType="product" api="products">\n${items}    </accessories>`
}

/** Podmienia caly blok w `<associations>` (kategorie, cechy, propozycje). */
function setAssociationBlock(xml: string, blockName: string, block: string) {
  const pattern = new RegExp(`<${blockName}(\\s[^>]*)?(/>|>[\\s\\S]*?</${blockName}>)`)
  return pattern.test(xml) ? xml.replace(pattern, block.trim()) : xml
}

async function findProductIdByReference(shop: PrestaShopApi, reference: string) {
  const data = await shop.getJson<any>(
    `products?filter[reference]=[${encodeURIComponent(reference)}]&display=[id,reference]&limit=1`
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
  features: Array<{ featureId: string; valueId: string }>,
  partnerId: string | null
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
  // Bez partnera blok zostaje nietkniety - inaczej kazde uruchomienie przed
  // publikacja drugiej karty kasowalo by recznie dodane propozycje.
  if (partnerId) xml = setAssociationBlock(xml, 'accessories', accessoriesBlock(partnerId))
  await shop.sendXml(`products/${productId}`, 'PUT', xml)
}

/** Papeteria powstaje na zamowienie - stan zerowy, ale sprzedaz otwarta. */
async function allowOrdersWithoutStock(shop: PrestaShopApi, productId: string) {
  const stock = await shop.getJson<any>(`stock_availables?display=full&filter[id_product]=[${productId}]`)
  for (const entry of stock.stock_availables || []) {
    const xml = await shop.getXml(`stock_availables/${entry.id}`)
    await shop.sendXml(`stock_availables/${entry.id}`, 'PUT', setTag(xml, 'out_of_stock', '1'))
  }
}

/**
 * Propozycja w druga strone. PrestaShop trzyma `accessories` jako relacje
 * jednokierunkowa, wiec bez tego menu polecaloby winietke, a winietka nie
 * wiedziala by o menu.
 */
async function linkBack(shop: PrestaShopApi, partnerId: string, productId: string) {
  let xml = await shop.getXml(`products/${partnerId}`)
  if (new RegExp(`<accessories[\\s\\S]*?<id>\\s*${productId}\\s*</id>`).test(xml)) return false
  xml = stripReadOnly(xml)
  xml = setAssociationBlock(xml, 'accessories', accessoriesBlock(productId))
  await shop.sendXml(`products/${partnerId}`, 'PUT', xml)
  return true
}

// --- Panel i magazyn ---------------------------------------------------

/** Produkt personalizowany dopasowywany po referencji karty. */
async function ensurePersonalizedProduct(templateId: string, externalProductId: string) {
  const existing = await prisma.personalizedProduct.findFirst({
    where: { shopId: SHOP_ID, identifierType: 'SKU', identifierValue: REFERENCE },
  })

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

  const replacePhotos = process.env.REPLACE_PHOTOS === '1'
  const photos = await ensureProductPhotos(template.layoutJson as any, replacePhotos)

  // Zdjecia ogladamy, zanim cokolwiek pojawi sie w sklepie.
  if (process.env.PHOTO_ONLY === '1') {
    console.log(JSON.stringify({ photoOnly: true, zdjecia: photos }, null, 2))
    return
  }

  const shopRecord = await prisma.shop.findUnique({ where: { id: SHOP_ID } })
  if (!shopRecord) throw new Error(`Brak sklepu ${SHOP_ID}`)
  const shop = prestaShopApi({ baseUrl: shopRecord.baseUrl, apiKey: decrypt(shopRecord.apiKey) })

  let productId = await findProductIdByReference(shop, REFERENCE)
  const created = !productId
  if (!productId) productId = await createProduct(shop)

  const partnerId = await findProductIdByReference(shop, PARTNER_REFERENCE)
  const features = await ensureFeatureValues(shop)
  await updateProduct(shop, productId, features, partnerId)
  await allowOrdersWithoutStock(shop, productId)
  const linkedBack = partnerId ? await linkBack(shop, partnerId, productId) : false

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
          propozycje: partnerId ? `${PARTNER_REFERENCE} (#${partnerId})${linkedBack ? ' + wpis zwrotny' : ''}` : 'brak partnera w sklepie',
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
