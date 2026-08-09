/**
 * Publikacja zaproszenia na roczek (szablon ROCZEK) jako produktu:
 * karta w PrestaShop (kreatywne-papierki.pl) + wpis produktu
 * personalizowanego w panelu.
 *
 * Produkt ma dwie wersje jako kombinacje jednego atrybutu:
 *   - "Do samodzielnego uzupełnienia" (ZAP-ROCZEK-S) - 5,00 zł brutto,
 *     druk z pustymi miejscami na treść, bez edytora,
 *   - "Personalizowane w edytorze" (ZAP-ROCZEK-P) - 6,50 zł brutto,
 *     klient po zakupie dostaje edytor i wpisuje treść.
 *
 * WAZNE: to referencja rozdziela te dwie sciezki. Cart.php sklada pozycje
 * zamowienia zapytaniem `IF(IFNULL(pa.reference,'')='', p.reference,
 * pa.reference)`, wiec kombinacja z wlasna referencja wpisuje do zamowienia
 * WLASNIE JA. Produkt personalizowany w panelu wskazuje tylko
 * `ZAP-ROCZEK-P`, wiec wersja do samodzielnego uzupelnienia nie zaklada
 * sprawy personalizacji i nie wysyla klientowi linku do edytora.
 * Zmiana referencji kombinacji rozspaja ten mechanizm.
 *
 * Skrypt jest idempotentny - produkt rozpoznaje po referencji, atrybut
 * i cechy po nazwach, kombinacje po wartosciach atrybutu, zdjecia po tym,
 * czy karta juz jakies ma.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/publish-roczek-product.js
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

const SHOP_ID = process.env.SHOP_ID || 'cmscv7k7l0001h4khpd8arr5i' // Kreatywne-papierki
const TEMPLATE_CODE = 'ROCZEK'

/** Kategoria glowna + dodatkowa, w ktorej produkt tez ma byc widoczny. */
const CATEGORY_DEFAULT = '828' // Roczek
const CATEGORY_IDS = ['828', '834'] // + Zaproszenia urodzinowe

const TAX_RULES_GROUP_ID = '1' // PL Standard Rate (23%)
const TAX_RATE = 0.23

const REFERENCE = 'ZAP-ROCZEK'
const PRODUCT_NAME = 'Zaproszenie na roczek – Miś z Balonikami'

/** Ceny katalogowe brutto; PrestaShop trzyma netto. */
const PRICE_GROSS_BASE = 5
const PRICE_GROSS_PERSONALIZED = 6.5
const toNet = (gross: number) => Number((gross / (1 + TAX_RATE)).toFixed(6))
const PRICE_NET = toNet(PRICE_GROSS_BASE)
const PERSONALIZATION_IMPACT_NET = Number((toNet(PRICE_GROSS_PERSONALIZED) - PRICE_NET).toFixed(6))

const PRODUCT_ACTIVE = process.env.PRODUCT_ACTIVE === '0' ? '0' : '1'

// --- Warianty ----------------------------------------------------------

const ATTRIBUTE_GROUP_NAME = 'Wersja zaproszenia'

type VariantSpec = {
  value: string
  reference: string
  impactNet: number
  personalized: boolean
}

const VARIANTS: VariantSpec[] = [
  // Pierwsza na liscie jest domyslna na karcie produktu.
  {
    value: 'Personalizowane w edytorze',
    reference: `${REFERENCE}-P`,
    impactNet: PERSONALIZATION_IMPACT_NET,
    personalized: true,
  },
  {
    value: 'Do samodzielnego uzupełnienia',
    reference: `${REFERENCE}-S`,
    impactNet: 0,
    personalized: false,
  },
]

// --- Cechy -------------------------------------------------------------
// Identyfikatory cech sa stale w tym sklepie; wartosci dobieramy po nazwie
// i dokladamy tylko te, ktorych jeszcze nie ma.

const FEATURES: Array<{ featureId: string; value: string }> = [
  { featureId: '16', value: 'zaproszenie' }, // Typ produktu
  { featureId: '15', value: 'miś' }, // Motyw
  { featureId: '17', value: 'papier' }, // Materiał
  { featureId: '18', value: '14 x 14 cm' }, // Rozmiar
  { featureId: '28', value: 'Cała treść zaproszenia' }, // Personalizacja
  { featureId: '7', value: 'Miś z Balonikami' }, // Kolekcja
]

// --- Tresci ------------------------------------------------------------

const META_TITLE = 'Zaproszenie na roczek Miś z Balonikami – 14 × 14 cm, personalizowane'
const META_DESCRIPTION =
  'Składane zaproszenie na pierwsze urodziny 14 × 14 cm z akwarelowym misiem i wycinanymi detalami 3D. ' +
  'Wersja personalizowana z edytorem treści lub do samodzielnego uzupełnienia.'

const DESCRIPTION_SHORT = `<p>Składane <strong>zaproszenie na pierwsze urodziny 14 × 14 cm</strong> (po rozłożeniu 14 × 28 cm) z akwarelowym misiem w papierowej czapeczce. Miś i rozeta to <strong>osobno wycinane elementy naklejane na okładkę</strong> – zaproszenie ma wypukły, przestrzenny detal.</p>
<p>✔ dwie wersje: personalizowana w edytorze albo do samodzielnego uzupełnienia<br />✔ treść ustalasz po złożeniu zamówienia – w wygodnym edytorze<br />✔ wycinane detale 3D na okładce<br />✔ pełna treść w środku: imię dziecka, data, miejsce, prośba o potwierdzenie</p>`

const DESCRIPTION = `<h2>Zaproszenie na roczek „Miś z Balonikami”</h2>
<p>Składane zaproszenie na pierwsze urodziny z akwarelową ilustracją misia w papierowej czapeczce, trzymającego baloniki z jedynką. Ciepłe beże i błękit tworzą spokojną, pastelową kompozycję, która pasuje do dekoracji w stylu boho i do klasycznych, stonowanych przyjęć.</p>
<p>Okładkę zdobią <strong>osobno wycinane elementy naklejane na kartkę</strong> – rozeta z ozdobnym brzegiem i figura misia. Dzięki temu zaproszenie ma wypukły detal, którego nie da się uzyskać samym drukiem, i wygląda jak ręcznie składana papeteria.</p>
<p>W środku znajduje się pełna treść zaproszenia oraz druga wycinana ilustracja – prezent z balonikami. Wszystko drukujemy na jednym arkuszu składanym na pół.</p>

<h2>Dwie wersje do wyboru</h2>
<p><strong>Personalizowane w edytorze</strong> – po złożeniu zamówienia dostajesz dostęp do edytora, w którym wpisujesz imię dziecka, datę i godzinę przyjęcia, miejsce, zwrot do gości oraz prośbę o potwierdzenie przybycia. Podgląd na bieżąco pokazuje gotowe zaproszenie, a my drukujemy dopiero po Twojej akceptacji.</p>
<p><strong>Do samodzielnego uzupełnienia</strong> – zaproszenie z gotową grafiką i pustymi miejscami na treść, którą wpisujesz odręcznie. Tańsza wersja dla osób, które lubią własne pismo albo potrzebują zaproszeń „od ręki”.</p>

<h2>Specyfikacja produktu</h2>
<p><strong>Rodzaj:</strong> zaproszenie składane<br /><strong>Format po złożeniu:</strong> 140 × 140 mm<br /><strong>Format po rozłożeniu:</strong> 140 × 280 mm<br /><strong>Elementy ozdobne:</strong> wycinane detale naklejane na okładkę i wnętrze<br /><strong>Nadruk:</strong> kolorowy, okładka i wnętrze<br /><strong>Personalizacja:</strong> imię dziecka, data i godzina, miejsce przyjęcia, zwrot do gości, prośba o potwierdzenie<br /><strong>Koperta:</strong> nie jest częścią zestawu – można dokupić osobno</p>

<h2>Jak zamówić</h2>
<ol>
<li>Wybierz wersję: personalizowaną albo do samodzielnego uzupełnienia.</li>
<li>Podaj liczbę zaproszeń.</li>
<li>W wersji personalizowanej po złożeniu zamówienia otwierasz edytor i wpisujesz treść.</li>
<li>Akceptujesz podgląd – drukujemy, wycinamy detale i wysyłamy gotowe zaproszenia.</li>
</ol>

<h2>Na jaką okazję</h2>
<ul>
<li>pierwsze urodziny i roczek</li>
<li>drugie urodziny dziecka</li>
<li>chrzciny i baby shower w tej samej kolorystyce</li>
</ul>
<p>Zaproszenie należy do kolekcji „Miś z Balonikami” – w tym samym stylu przygotowaliśmy również winietki na stół, więc dekorację przyjęcia można ułożyć spójnie.</p>`

// --- Zdjecia produktu --------------------------------------------------

/**
 * Zdjecia karty: mockupy szablonu wyrenderowane z przykladowa trescia, wiec
 * klient oglada dokladnie to, co dostanie. Kolejnosc jak w layoucie -
 * pierwsze staje sie zdjeciem glownym.
 */
async function ensureProductPhotos(layout: any, force: boolean) {
  const mockups: any[] = [...(layout.mockups || [])]
  if (mockups.length === 0) throw new Error('Szablon ROCZEK nie ma mockupow')

  // Pierwsze wgrane zdjecie zostaje glownym na karcie, wiec na poczatek idzie
  // ujecie z okladka (pierwsza strona projektu), nie z rozkladowka.
  const coverPageId = layout.pages?.[0]?.id
  mockups.sort((a, b) => {
    const showsCover = (mockup: any) =>
      (mockup.surfaces || []).some((surface: any) => surface.pageId === coverPageId) ? 0 : 1
    return showsCover(a) - showsCover(b)
  })

  const answers = await defaultAnswers()
  const dir = path.join(process.cwd(), 'storage', 'templates', TEMPLATE_CODE, 'produkt')
  const files: string[] = []

  for (const [index, mockup] of mockups.entries()) {
    const absolute = path.join(dir, `zaproszenie-roczek-foto-${index + 1}.jpg`)
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

// --- Atrybut i kombinacje ---------------------------------------------

async function ensureAttributeGroup(shop: PrestaShopApi) {
  const groups = await shop.getJson<any>('product_options?display=full')
  const existing = (groups.product_options || []).find(
    (group: any) => localized(group.name).trim().toLowerCase() === ATTRIBUTE_GROUP_NAME.toLowerCase()
  )
  if (existing) return String(existing.id)

  const payload = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product_option>
    <is_color_group>0</is_color_group>
    <group_type>select</group_type>
    <position>0</position>
    <name><language id="${LANGUAGE_ID}"><![CDATA[${cdata(ATTRIBUTE_GROUP_NAME)}]]></language></name>
    <public_name><language id="${LANGUAGE_ID}"><![CDATA[${cdata(ATTRIBUTE_GROUP_NAME)}]]></language></public_name>
  </product_option>
</prestashop>`

  return xmlValue(await shop.sendXml('product_options', 'POST', payload), 'id')
}

async function ensureAttributeValues(shop: PrestaShopApi, groupId: string) {
  const group = await shop.getJson<any>(`product_options/${groupId}`)
  const existingIds: string[] = (group.product_option?.associations?.product_option_values || []).map(
    (value: any) => String(value.id)
  )

  const byName = new Map<string, string>()
  for (const valueId of existingIds) {
    const value = await shop.getJson<any>(`product_option_values/${valueId}`)
    byName.set(localized(value.product_option_value?.name).trim().toLowerCase(), valueId)
  }

  const result = new Map<string, string>()
  for (const [index, variant] of VARIANTS.entries()) {
    const found = byName.get(variant.value.toLowerCase())
    if (found) {
      result.set(variant.value, found)
      continue
    }
    const payload = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product_option_value>
    <id_attribute_group>${groupId}</id_attribute_group>
    <color></color>
    <position>${index}</position>
    <name><language id="${LANGUAGE_ID}"><![CDATA[${cdata(variant.value)}]]></language></name>
  </product_option_value>
</prestashop>`
    result.set(variant.value, xmlValue(await shop.sendXml('product_option_values', 'POST', payload), 'id'))
  }

  return result
}

async function ensureCombinations(shop: PrestaShopApi, productId: string, valueIds: Map<string, string>) {
  const product = await shop.getJson<any>(`products/${productId}`)
  const existing: any[] = product.product?.associations?.combinations || []

  // Kombinacje rozpoznajemy po referencji - to ona rozdziela wersje z edytorem
  // od wersji do samodzielnego uzupelnienia.
  const byReference = new Map<string, string>()
  for (const item of existing) {
    const combination = await shop.getJson<any>(`combinations/${item.id}`)
    const reference = String(combination.combination?.reference || '')
    if (reference) byReference.set(reference, String(item.id))
  }

  const created = new Map<string, string>()
  for (const [index, variant] of VARIANTS.entries()) {
    const alreadyThere = byReference.get(variant.reference)
    if (alreadyThere) {
      created.set(variant.reference, alreadyThere)
      continue
    }

    const payload = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <combination>
    <id_product>${productId}</id_product>
    <reference><![CDATA[${cdata(variant.reference)}]]></reference>
    <minimal_quantity>1</minimal_quantity>
    <price>${variant.impactNet.toFixed(6)}</price>
    <default_on>${index === 0 ? 1 : ''}</default_on>
    <associations>
      <product_option_values nodeType="product_option_value" api="product_option_values">
        <product_option_value><id>${valueIds.get(variant.value)}</id></product_option_value>
      </product_option_values>
    </associations>
  </combination>
</prestashop>`

    created.set(variant.reference, xmlValue(await shop.sendXml('combinations', 'POST', payload), 'id'))
  }

  return created
}

/** Zaproszenia powstaja na zamowienie - stan zerowy, ale sprzedaz otwarta. */
async function allowOrdersWithoutStock(shop: PrestaShopApi, productId: string) {
  const stock = await shop.getJson<any>(`stock_availables?display=full&filter[id_product]=[${productId}]`)
  for (const entry of stock.stock_availables || []) {
    const xml = await shop.getXml(`stock_availables/${entry.id}`)
    await shop.sendXml(`stock_availables/${entry.id}`, 'PUT', setTag(xml, 'out_of_stock', '1'))
  }
}

// --- Cechy -------------------------------------------------------------

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

// --- Produkt personalizowany w panelu ----------------------------------

/**
 * W panelu istnieje TYLKO wersja personalizowana - to ona ma referencje
 * `ZAP-ROCZEK-P`. Wersja do samodzielnego uzupelnienia nie ma dopasowania,
 * wiec synchronizacja zamowien nie zaklada dla niej sprawy personalizacji.
 */
async function ensurePersonalizedProduct(templateId: string) {
  const variant = VARIANTS.find((item) => item.personalized)!
  const existing = await prisma.personalizedProduct.findFirst({
    where: { shopId: SHOP_ID, identifierType: 'SKU', identifierValue: variant.reference },
  })

  const data = { name: `${PRODUCT_NAME} (personalizowane)`, templateId, isActive: true }

  if (existing) {
    return prisma.personalizedProduct.update({ where: { id: existing.id }, data })
  }

  return prisma.personalizedProduct.create({
    data: { shopId: SHOP_ID, identifierType: 'SKU', identifierValue: variant.reference, ...data },
  })
}

async function main() {
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

  const groupId = await ensureAttributeGroup(shop)
  const valueIds = await ensureAttributeValues(shop, groupId)
  const combinations = await ensureCombinations(shop, productId, valueIds)
  await allowOrdersWithoutStock(shop, productId)

  const product = await shop.getJson<any>(`products/${productId}`)
  const images: any[] = product.product?.associations?.images || []
  if (replacePhotos) {
    for (const image of images) {
      await shop.deleteResource(`images/products/${productId}/${image.id}`)
    }
  }
  if (images.length === 0 || replacePhotos) {
    for (const photo of photos) {
      await shop.uploadImage(productId, photo)
    }
  }

  const personalizedProduct = await ensurePersonalizedProduct(template.id)

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
          priceGross: { base: PRICE_GROSS_BASE, personalized: PRICE_GROSS_PERSONALIZED },
          categories: CATEGORY_IDS,
          attributeGroupId: groupId,
          combinations: Object.fromEntries(combinations),
          features: features.map((item) => `${item.featureId}=${item.valueId}`),
          photos: images.length === 0 || replacePhotos ? photos.map((file) => path.basename(file)) : 'juz byly',
          url: `${shop.baseUrl}/index.php?id_product=${productId}&controller=product`,
        },
        panel: {
          personalizedProductId: personalizedProduct.id,
          identifierValue: personalizedProduct.identifierValue,
          templateId: template.id,
          templateCode: TEMPLATE_CODE,
          shop: shopRecord.name,
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
