/**
 * Publikacja szablonu URODZINY_18 jako produktu: karta w PrestaShop
 * (kreatywne-papierki.pl), produkt personalizowany w panelu i wpis w module
 * Magazyn, zeby zamowienie dalo sie dopiac do sprawy personalizacji.
 *
 * Blizniak `publish-zaproszenie-12x17-product.ts`: karta ma JEDNA wersje -
 * personalizowana w edytorze - wiec nie ma atrybutu ani kombinacji, a
 * dopasowanie zamowienia idzie po referencji SAMEGO PRODUKTU (`ZAP-18-12X17`).
 *
 * CENA. Katalogowe 7,00 zl brutto to cena zaproszenia RAZEM z biala koperta
 * B6, ktora jest czescia zestawu - koperta nie jest wiec skladowa zestawu
 * `kp_advancedbundle`. Koperty ozdobne, koperty z wklejka i lakowa pieczec
 * doklada dopiero modul zestawow (typ `variant`, tryb `base_plus_items`),
 * doliczajac swoja cene katalogowa do tych 7,00 zl. Gdyby biala koperta byla
 * skladowa domyslnie zaznaczona, cena surowa w `product_shop.price` rozjechala
 * by sie z cena prezentowana (feed vs landing page) - modul synchronizuje
 * kolumne tylko dla trybow `sum` i `discount`.
 *
 * Zdjecia karty to mockupy szablonu wyrenderowane z domyslna trescia. Brak
 * mockupow w layoucie = karta zostaje bez zdjec (nie jest to blad).
 *
 * Skrypt jest idempotentny - produkt rozpoznaje po referencji, cechy po
 * nazwach, a wpisy w panelu i magazynie robi przez upsert.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/publish-urodziny-18-product.js
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
const TEMPLATE_CODE = 'URODZINY_18'
const CATALOG_NAME = 'Kreatywne Papierki'

/** Kategoria glowna + dodatkowe, w ktorych produkt tez ma byc widoczny. */
const CATEGORY_DEFAULT = '47' // Zaproszenia (Papeteria)
// 833 dolozone razem ze zdjeciami 30/40/50: karta obsluguje kazdy wiek,
// wiec ma byc widoczna takze poza kategoria osiemnastki.
const CATEGORY_IDS = ['47', '834', '829', '833'] // + Zaproszenia urodzinowe, 18. urodziny, Okrągłe urodziny

const TAX_RULES_GROUP_ID = '1' // PL Standard Rate (23%)
const TAX_RATE = 0.23

const REFERENCE = 'ZAP-18-12X17'
const PRODUCT_NAME = 'Zaproszenie na 18. urodziny – Czarna Kokarda 12 × 17 cm z kopertą'

/** Cena katalogowa brutto (zaproszenie + biala koperta B6); PrestaShop trzyma netto. */
const PRICE_GROSS = 7.0
const PRICE_NET = Number((PRICE_GROSS / (1 + TAX_RATE)).toFixed(6))

const PRODUCT_ACTIVE = process.env.PRODUCT_ACTIVE === '0' ? '0' : '1'

/** '0' = mapowanie produktu-rodzica; warianty maja tu id kombinacji. */
const PARENT_COMBINATION_ID = '0'

// --- Cechy -------------------------------------------------------------
// Identyfikatory cech sa stale w tym sklepie; wartosci dobieramy po nazwie
// i dokladamy tylko te, ktorych jeszcze nie ma.

const FEATURES: Array<{ featureId: string; value: string }> = [
  { featureId: '16', value: 'zaproszenie' }, // Typ produktu
  { featureId: '15', value: 'kokarda' }, // Motyw
  { featureId: '17', value: 'papier' }, // Materiał
  { featureId: '18', value: '12 x 17 cm' }, // Rozmiar
  { featureId: '28', value: 'Cała treść zaproszenia' }, // Personalizacja
]

// --- Tresci ------------------------------------------------------------

const META_TITLE = 'Zaproszenia urodzinowe z kopertą – Czarna Kokarda 12 × 17 cm (18, 30, 40, 50)'
const META_DESCRIPTION =
  'Eleganckie zaproszenie urodzinowe 12 × 17 cm z czarną kokardą i białą kopertą B6 w cenie. ' +
  'Liczbę lat wpisujesz sam – 18, 30, 40, 50 albo dowolną inną. Całą treść ustalasz w edytorze. 7 zł za sztukę.'

const DESCRIPTION_SHORT = `<p>Pionowe <strong>zaproszenie urodzinowe 12 × 17 cm</strong> w klasycznej czerni i bieli, z czarną kokardą i dużą liczbą lat złożoną krojem Bodoni. <strong>Liczbę lat wpisujesz sam</strong> – ta sama karta obsłuży 18, 30, 40, 50 i każdą inną rocznicę. <strong>Biała koperta B6 jest w cenie.</strong></p>
<p>✔ dowolny wiek – liczba lat, motto i cała treść są do zmiany<br />✔ osobny adresat na każdym zaproszeniu – wpisujesz listę gości<br />✔ koperty ozdobne i lakową pieczęć dobierasz obok przycisku „Do koszyka”<br />✔ druk dopiero po Twojej akceptacji podglądu</p>`

const DESCRIPTION = `<h2>Zaproszenie urodzinowe „Czarna Kokarda” – na każdy wiek</h2>
<p>Pionowa karta 12 × 17 cm dla urodzin, które mają wyglądać dorośle. Czysta biel papieru, czarna typografia i satynowa kokarda po prawej stronie – bez konfetti, bez balonów, bez brokatu. U góry motto oddzielone cienką kreską, pod nim duża liczba lat złożona krojem Bodoni Moda, a niżej kolumna treści zamknięta odręcznym podpisem.</p>
<p><strong>To nie jest karta wyłącznie na osiemnastkę.</strong> Liczba lat to zwykłe pole w edytorze – wpisujesz 18, 30, 40, 50, 60 albo dowolną inną. Motto u góry też zmieniasz na własne, więc karta bez śladu przestawia się z przyjęcia maturzystki na jubileusz w gronie znajomych.</p>
<p>Ten sam układ pasuje na przyjęcie w sali bankietowej, na kameralną kolację w restauracji i na domówkę – decyduje treść, którą wpisujesz sam.</p>

<h2>Biała koperta B6 w cenie</h2>
<p>Do każdego zaproszenia dokładamy <strong>białą kopertę B6 (12,5 × 17,5 cm)</strong> – karta wchodzi do niej bez składania. Cena 7 zł dotyczy kompletu: zaproszenie + koperta.</p>
<p>Jeśli chcesz mocniejszy efekt, obok przycisku „Do koszyka” wybierzesz dodatkowo płatne:</p>
<ul>
<li><strong>koperty ozdobne kolorowe</strong> – papiery Keaykolour i Crush, m.in. bordo, butelkowa zieleń, pudrowy róż, grafit,</li>
<li><strong>koperty z wklejką</strong> – wnętrze z wzorem kwiatowym lub botanicznym,</li>
<li><strong>lakową pieczęć</strong> – zamknięcie koperty w stylu vintage.</li>
</ul>

<h2>Co ustalasz w edytorze</h2>
<p>Po złożeniu zamówienia dostajesz dostęp do edytora, w którym wpisujesz:</p>
<ul>
<li><strong>liczbę lat</strong> – dwie cyfry w przerwie pionowej kreski, dowolny wiek,</li>
<li><strong>listę gości</strong> – osobny adresat na każdym zaproszeniu w zamówieniu, np. „Sz. P. Annę i Macieja Spoczyńskich”,</li>
<li><strong>okazję</strong> – tekst pod liczbą, np. „na przyjęcie z okazji moich czterdziestych urodzin”,</li>
<li><strong>datę i godzinę przyjęcia</strong>,</li>
<li><strong>miejsce przyjęcia</strong> – nazwa lokalu i adres,</li>
<li><strong>podpis</strong> – imię jubilata pismem odręcznym,</li>
<li><strong>motto u góry karty</strong> – klikasz je na podglądzie i wpisujesz własne albo usuwasz.</li>
</ul>
<p>Podgląd na bieżąco pokazuje gotowe zaproszenie, a my drukujemy dopiero po Twojej akceptacji.</p>

<h2>Specyfikacja produktu</h2>
<p><strong>Rodzaj:</strong> zaproszenie jednostronne<br /><strong>Format:</strong> 120 × 170 mm<br /><strong>Nadruk:</strong> kolorowy, jednostronny<br /><strong>Kroje pisma:</strong> Bodoni Moda, Cormorant Infant, pismo odręczne<br /><strong>Personalizacja:</strong> liczba lat i cała treść zaproszenia, adresat osobny dla każdej sztuki<br /><strong>Koperta:</strong> biała B6 12,5 × 17,5 cm w cenie; ozdobne i z wklejką do dokupienia</p>

<h2>Jak zamówić</h2>
<ol>
<li>Podaj liczbę zaproszeń i ewentualnie wybierz koperty ozdobne.</li>
<li>Po złożeniu zamówienia otwierasz edytor, wpisujesz liczbę lat, treść i listę gości.</li>
<li>Akceptujesz podgląd – drukujemy i wysyłamy gotowe zaproszenia razem z kopertami.</li>
</ol>

<h2>Na jaką okazję</h2>
<ul>
<li>18. urodziny – przyjęcie w sali, restauracji albo w domu</li>
<li>30. i 40. urodziny – kameralna kolacja albo impreza w gronie znajomych</li>
<li>50., 60. i kolejne jubileusze – elegancka oprawa bez motywów dziecięcych</li>
<li>rocznice i uroczystości rodzinne w czarno-białej kolorystyce</li>
</ul>`

// --- Zdjecia produktu: cztery ujecia wieku -----------------------------

/**
 * Karta obsluguje dowolna liczbe lat, wiec galeria pokazuje cztery
 * najczestsze okragle urodziny zamiast czterech razy osiemnastki.
 *
 * `quote_text` NIE jest polem formularza - to warstwa `textbox` z
 * `editable: true`, ktora klient nadpisuje wprost na podgladzie
 * (`layoutOverrides.layers[id].text`). Renderer rozwiazuje textboxy po
 * `properties.fieldKey` z odpowiedzi, wiec ten sam klucz wystarczy tutaj
 * i zdjecia nie obiecuja czegos, czego produkt nie potrafi.
 */
const AGE_SHOTS: Array<{ age: string; occasion: string; quote: string; signature: string }> = [
  {
    age: '18',
    occasion: 'NA PRZYJĘCIE Z OKAZJI MOICH\nOSIEMNASTYCH URODZIN',
    quote: 'Osiemnaście lat to początek nowej podróży\n– pełnej marzeń, wyzwań i pięknych chwil',
    signature: 'Dorota',
  },
  {
    age: '30',
    occasion: 'NA PRZYJĘCIE Z OKAZJI MOICH\nTRZYDZIESTYCH URODZIN',
    quote: 'Trzydzieści lat to najlepszy moment,\nżeby świętować w dobrym towarzystwie',
    signature: 'Marta',
  },
  {
    age: '40',
    occasion: 'NA PRZYJĘCIE Z OKAZJI MOICH\nCZTERDZIESTYCH URODZIN',
    quote: 'Czterdzieści lat brzmi bardzo poważnie\n– dopóki nie zacznie się przyjęcie',
    signature: 'Anna',
  },
  {
    age: '50',
    occasion: 'NA PRZYJĘCIE Z OKAZJI MOICH\nPIĘĆDZIESIĄTYCH URODZIN',
    quote: 'Pięćdziesiąt lat to pół wieku wspomnień\n– a najlepsze wciąż przed nami',
    signature: 'Ewa',
  },
]


// --- Zdjecia produktu --------------------------------------------------

/**
 * Zdjecia karty: mockupy szablonu wyrenderowane realna trescia, wiec klient
 * oglada dokladnie to, co dostanie. Brak mockupow = brak zdjec, a nie blad -
 * karta moze poczekac na grafike.
 *
 * Szablon nie ma `variants`, a mimo to zdjec jest kilka: galeria pokazuje
 * `AGE_SHOTS`, czyli te sama karte z rozna liczba lat. Kolejnosc `AGE_SHOTS`
 * jest kolejnoscia wysylki do PrestaShop, a pierwsze zdjecie zostaje okladka.
 */
async function ensureProductPhotos(layout: any, force: boolean) {
  const mockups: any[] = layout?.mockups || []
  if (mockups.length === 0) return []

  const base = await defaultAnswers()

  const shots = AGE_SHOTS.map((shot) => ({
    suffix: shot.age,
    answers: {
      ...base,
      age_number: shot.age,
      occasion_text: shot.occasion,
      signature: shot.signature,
      quote_text: shot.quote,
    },
  }))

  const dir = path.join(process.cwd(), 'storage', 'templates', TEMPLATE_CODE, 'produkt')
  const files: string[] = []

  // Ujecia przed mockupami: przy kilku scenach galeria idzie wtedy
  // 18/30/40/50 w pierwszej scenie, a nie 18 w kazdej po kolei.
  const jobs = shots.flatMap((shot) =>
    mockups.map((mockup, index) => ({
      mockup,
      name: `urodziny-${shot.suffix}-lat-${index + 1}.jpg`,
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
 * `personalizationEnabled` NA MAPOWANIU zostaje wlaczone - karta ma jedna
 * wersje, wiec nie ma czego rozdzielac, a `orders.service` bierze szablon
 * z mapowania ALBO z produktu personalizowanego (`mappingTemplate ||
 * personalizedProduct?.template`). Produkt personalizowany zostaje jako
 * sciezka zapasowa.
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

  // Zdjecie ogladamy, zanim cokolwiek pojawi sie w sklepie.
  if (process.env.PHOTO_ONLY === '1') {
    console.log(JSON.stringify({ photoOnly: true, zdjecia: photos }, null, 2))
    return
  }

  const shopRecord = await prisma.shop.findUnique({ where: { id: SHOP_ID } })
  if (!shopRecord) throw new Error(`Brak sklepu ${SHOP_ID}`)
  const shop = prestaShopApi({ baseUrl: shopRecord.baseUrl, apiKey: decrypt(shopRecord.apiKey) })

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
