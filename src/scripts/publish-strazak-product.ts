/**
 * Publikacja zaproszenia strażackiego (szablon STRAZAK) jako produktu:
 * karta w PrestaShop (kreatywne-papierki.pl) + wpis produktu
 * personalizowanego w panelu.
 *
 * Produkt ma dwie wersje jako kombinacje jednego atrybutu:
 *   - "Personalizowane w edytorze" (ZAP-STRAZAK-P) - 7,00 zl brutto,
 *   - "Do samodzielnego uzupełnienia" (ZAP-STRAZAK-S) - 5,50 zl brutto.
 *
 * WAZNE: to referencja rozdziela te dwie sciezki. Cart.php sklada pozycje
 * zamowienia zapytaniem `IF(IFNULL(pa.reference,'')='', p.reference,
 * pa.reference)`, wiec kombinacja z wlasna referencja wpisuje do zamowienia
 * WLASNIE JA. Produkt personalizowany w panelu wskazuje tylko
 * `ZAP-STRAZAK-P`, wiec wersja do samodzielnego uzupelnienia nie zaklada
 * sprawy personalizacji i nie wysyla klientowi linku do edytora.
 *
 * Zdjecia karty budujemy z RENDEROW STRON, nie z mockupow - szablon zadnych
 * nie ma, bo zaproszenie jest plaska kartka, a nie skladana winietka. Pierwsze
 * zdjecie sklada przod z doklejonym krążkiem, czyli pokazuje to, czego zaden
 * pojedynczy arkusz druku nie pokazuje.
 *
 * Skrypt jest idempotentny - produkt rozpoznaje po referencji, atrybut
 * i cechy po nazwach, kombinacje po referencjach, zdjecia po tym, czy karta
 * juz jakies ma.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/publish-strazak-product.js
 *   PRODUCT_ACTIVE=1 - karta od razu widoczna w sklepie (domyslnie UKRYTA)
 *   REPLACE_PHOTOS=1 - przerysowanie i podmiana zdjec
 */
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { getTemplatePages } from '@msierpien/kp-template-core'
import { decrypt } from '../lib/encryption'
import { renderPrintPagePng } from '../services/renderer/fabric-renderer.service'
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
const TEMPLATE_CODE = 'STRAZAK'

/** Kategoria glowna + dodatkowa, w ktorej produkt tez ma byc widoczny. */
const CATEGORY_DEFAULT = '834' // Zaproszenia urodzinowe
const CATEGORY_IDS = ['834', '820'] // + Urodziny dziecka

const TAX_RULES_GROUP_ID = '1' // PL Standard Rate (23%)
const TAX_RATE = 0.23

const REFERENCE = 'ZAP-STRAZAK'
const PRODUCT_NAME = 'Zaproszenie urodzinowe – Mały Strażak'

/** Ceny katalogowe brutto; PrestaShop trzyma netto. */
const PRICE_GROSS_BASE = 5.5
const PRICE_GROSS_PERSONALIZED = 7
const toNet = (gross: number) => Number((gross / (1 + TAX_RATE)).toFixed(6))
const PRICE_NET = toNet(PRICE_GROSS_BASE)
const PERSONALIZATION_IMPACT_NET = Number((toNet(PRICE_GROSS_PERSONALIZED) - PRICE_NET).toFixed(6))

/**
 * Domyslnie karta powstaje UKRYTA - odwrotnie niz przy roczku. Opis, cena
 * i zdjecia sa tu propozycja, wiec produkt ma najpierw przejsc przeglad,
 * a dopiero potem trafic do sklepu.
 */
const PRODUCT_ACTIVE = process.env.PRODUCT_ACTIVE === '1' ? '1' : '0'

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
  { featureId: '15', value: 'straż pożarna' }, // Motyw
  { featureId: '17', value: 'papier' }, // Materiał
  { featureId: '18', value: '10,5 x 14,8 cm' }, // Rozmiar
  { featureId: '28', value: 'Cała treść zaproszenia' }, // Personalizacja
  { featureId: '7', value: 'Mały Strażak' }, // Kolekcja
]

// --- Tresci ------------------------------------------------------------

const META_TITLE = 'Zaproszenie urodzinowe Mały Strażak – A6, z krążkiem z imieniem'
const META_DESCRIPTION =
  'Zaproszenie na urodziny dziecka 10,5 × 14,8 cm z akwarelową grafiką strażacką i doklejanym krążkiem ' +
  'z imieniem dziecka. Wersja personalizowana w edytorze lub do samodzielnego uzupełnienia.'

const DESCRIPTION_SHORT = `<p><strong>Zaproszenie urodzinowe A6 (10,5 × 14,8 cm)</strong> z akwarelową grafiką strażacką – wóz z drabiną, hydrant, hełm i płomienie. Do zestawu dokładamy <strong>okrągły krążek 7 cm z imieniem dziecka</strong>, naklejany na środku przodu.</p>
<p>✔ dwie wersje: personalizowana w edytorze albo do samodzielnego uzupełnienia<br />✔ krążek z imieniem jako osobny, naklejany element<br />✔ nadruk dwustronny – grafika z przodu, cała treść z tyłu<br />✔ treść ustalasz po złożeniu zamówienia, w wygodnym edytorze</p>`

const DESCRIPTION = `<h2>Zaproszenie urodzinowe „Mały Strażak”</h2>
<p>Zaproszenie na urodziny dziecka z akwarelową ilustracją w strażackim motywie: wóz bojowy z drabiną, hydrant tryskający wodą, gaśnica, zwinięty wąż, hełm z gwiazdą i płomienie. Ciepła czerwień na fakturze papieru akwarelowego – rysunek wygląda jak namalowany, a nie wygenerowany.</p>
<p>Przód karty to sam rysunek, bez napisów. Na jego środku naklejamy <strong>osobno drukowany i wycinany krążek o średnicy 7 cm</strong> z imieniem dziecka, obwiedziony czerwoną obręczą, z napisami biegnącymi po łuku. Dzięki temu zaproszenie ma wypukły, naklejany detal, a imię solenizanta widać od pierwszego spojrzenia.</p>
<p>Cała treść zaproszenia znajduje się z tyłu, na czystym papierze, z pasem grafiki przy dolnej krawędzi.</p>

<h2>Dwie wersje do wyboru</h2>
<p><strong>Personalizowane w edytorze</strong> – po złożeniu zamówienia dostajesz dostęp do edytora, w którym wpisujesz imię dziecka, zwrot do gościa, datę i godzinę, miejsce przyjęcia oraz prośbę o potwierdzenie przybycia. Imię gościa ustalasz <strong>osobno dla każdego zaproszenia</strong>, więc każde jest wypisane imiennie. Podgląd na bieżąco pokazuje gotową kartę, a my drukujemy dopiero po Twojej akceptacji.</p>
<p><strong>Do samodzielnego uzupełnienia</strong> – zaproszenie z gotową grafiką i pustymi miejscami na treść, którą wpisujesz odręcznie. Tańsza wersja dla osób, które lubią własne pismo albo potrzebują zaproszeń „od ręki”.</p>

<h2>Specyfikacja produktu</h2>
<p><strong>Rodzaj:</strong> zaproszenie jednokartkowe, dwustronne<br /><strong>Format:</strong> 105 × 148 mm (A6)<br /><strong>Krążek z imieniem:</strong> koło o średnicy 70 mm, wycinane i naklejane<br /><strong>Nadruk:</strong> kolorowy, przód i tył<br /><strong>Personalizacja:</strong> imię dziecka, imię gościa (osobno na każdym zaproszeniu), data i godzina, miejsce przyjęcia, prośba o potwierdzenie<br /><strong>Koperta:</strong> nie jest częścią zestawu – można dokupić osobno</p>

<h2>Jak zamówić</h2>
<ol>
<li>Wybierz wersję: personalizowaną albo do samodzielnego uzupełnienia.</li>
<li>Podaj liczbę zaproszeń.</li>
<li>W wersji personalizowanej po złożeniu zamówienia otwierasz edytor i wpisujesz treść, w tym imię każdego gościa osobno.</li>
<li>Akceptujesz podgląd – drukujemy, wycinamy krążki i wysyłamy gotowe zaproszenia.</li>
</ol>

<h2>Na jaką okazję</h2>
<ul>
<li>urodziny chłopca i dziewczynki w motywie strażackim</li>
<li>przyjęcie tematyczne „mały ratownik”</li>
<li>urodziny w remizie, sali zabaw albo na dworze</li>
</ul>`

// --- Zdjecia produktu --------------------------------------------------

const PHOTO_SIZE = 1400
/** Tlo zdjec - cieply odcien papieru, zeby biala kartka miala sie od czego odciac. */
const PHOTO_BACKGROUND = '#f0ece7'

/**
 * Zdjecia karty budowane z renderow stron.
 *
 * Szablon nie ma mockupow (to plaska kartka, nie ma czego wyginac), wiec
 * zamiast zdjecia produktu skladamy same wydruki na jednolitym tle. Pierwsze
 * ujecie DOKLEJA krążek do przodu - inaczej klient widzialby dwa niepowiazane
 * arkusze i nie wiedzial, jak to ma wygladac po zlozeniu.
 */
export async function ensureProductPhotos(layout: any, force: boolean) {
  const answers = await defaultAnswers()
  const pages = getTemplatePages(layout)
  const dir = path.join(process.env.STORAGE_PATH || path.join(process.cwd(), 'storage'), 'templates', TEMPLATE_CODE, 'produkt')

  const names = ['przod-z-krazkiem', 'tyl-tresc', 'krazek']
  const targets = names.map((name) => path.join(dir, `zaproszenie-strazak-${name}.jpg`))
  if (!force && targets.every((file) => fs.existsSync(file))) return targets

  const renders = new Map<string, { buffer: Buffer; widthPx: number; heightPx: number }>()
  for (const page of pages) {
    const render = await renderPrintPagePng(layout, page, answers)
    renders.set(page.id, render)
  }

  const { createCanvas, loadImage } = await import('canvas')

  /** Kartka bez spadu - spad to naddatek dla krajarki, nie czesc produktu. */
  const trim = async (pageId: string) => {
    const render = renders.get(pageId)!
    const page = pages.find((item) => item.id === pageId)!
    const dpi = Number(page.canvas.dpi) || 300
    const bleedPx = Math.round(((Number(page.canvas.bleedMm) || 0) / 25.4) * dpi)
    const image = await loadImage(render.buffer)
    const width = render.widthPx - bleedPx * 2
    const height = render.heightPx - bleedPx * 2
    const canvas = createCanvas(width, height)
    canvas.getContext('2d').drawImage(image as any, bleedPx, bleedPx, width, height, 0, 0, width, height)
    return { canvas, width, height }
  }

  const frame = () => {
    const canvas = createCanvas(PHOTO_SIZE, PHOTO_SIZE)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = PHOTO_BACKGROUND
    ctx.fillRect(0, 0, PHOTO_SIZE, PHOTO_SIZE)
    return { canvas, ctx }
  }

  const cardHeight = Math.round(PHOTO_SIZE * 0.82)

  const drawCard = (ctx: any, card: any, cardWidth: number, cardHeightPx: number) => {
    const x = Math.round((PHOTO_SIZE - cardWidth) / 2)
    const y = Math.round((PHOTO_SIZE - cardHeightPx) / 2)
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.22)'
    ctx.shadowBlur = 34
    ctx.shadowOffsetY = 14
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(x, y, cardWidth, cardHeightPx)
    ctx.restore()
    ctx.drawImage(card, x, y, cardWidth, cardHeightPx)
    return { x, y }
  }

  const front = await trim('page-1')
  const back = await trim('page-2')
  const badge = await loadImage(renders.get('page-3')!.buffer)

  const frontScale = cardHeight / front.height
  const frontWidth = Math.round(front.width * frontScale)

  // 1. Przod z doklejonym krążkiem.
  const first = frame()
  const placed = drawCard(first.ctx, front.canvas, frontWidth, cardHeight)
  // Krążek trzyma skale kartki: 70 mm z 148 mm wysokosci strony.
  const badgeDiameter = Math.round(cardHeight * (70 / 148))
  const badgeRadius = badgeDiameter / 2 - 6
  const badgeCx = placed.x + frontWidth / 2
  const badgeCy = placed.y + cardHeight / 2
  first.ctx.save()
  first.ctx.shadowColor = 'rgba(0,0,0,0.28)'
  first.ctx.shadowBlur = 18
  first.ctx.shadowOffsetY = 7
  first.ctx.beginPath()
  first.ctx.arc(badgeCx, badgeCy, badgeRadius, 0, Math.PI * 2)
  first.ctx.fillStyle = '#ffffff'
  first.ctx.fill()
  first.ctx.restore()
  first.ctx.save()
  first.ctx.beginPath()
  first.ctx.arc(badgeCx, badgeCy, badgeRadius, 0, Math.PI * 2)
  first.ctx.clip()
  first.ctx.drawImage(badge, badgeCx - badgeDiameter / 2, badgeCy - badgeDiameter / 2, badgeDiameter, badgeDiameter)
  first.ctx.restore()

  // 2. Tyl z trescia.
  const second = frame()
  drawCard(second.ctx, back.canvas, Math.round(back.width * (cardHeight / back.height)), cardHeight)

  // 3. Sam krążek, wyciety w kolo - zeby bylo widac, ze to osobny element.
  const third = frame()
  const soloDiameter = Math.round(PHOTO_SIZE * 0.72)
  const soloRadius = soloDiameter / 2 - 6
  third.ctx.save()
  third.ctx.shadowColor = 'rgba(0,0,0,0.24)'
  third.ctx.shadowBlur = 30
  third.ctx.shadowOffsetY = 12
  third.ctx.beginPath()
  third.ctx.arc(PHOTO_SIZE / 2, PHOTO_SIZE / 2, soloRadius, 0, Math.PI * 2)
  third.ctx.fillStyle = '#ffffff'
  third.ctx.fill()
  third.ctx.restore()
  third.ctx.save()
  third.ctx.beginPath()
  third.ctx.arc(PHOTO_SIZE / 2, PHOTO_SIZE / 2, soloRadius, 0, Math.PI * 2)
  third.ctx.clip()
  third.ctx.drawImage(
    badge,
    (PHOTO_SIZE - soloDiameter) / 2,
    (PHOTO_SIZE - soloDiameter) / 2,
    soloDiameter,
    soloDiameter
  )
  third.ctx.restore()

  fs.mkdirSync(dir, { recursive: true })
  // JPEG, nie PNG: PrestaShop odrzuca pliki powyzej 2000 KB, a render w tej
  // rozdzielczosci wazy w PNG grubo ponad limit.
  const canvases = [first.canvas, second.canvas, third.canvas]
  targets.forEach((file, index) => {
    fs.writeFileSync(file, canvases[index].toBuffer('image/jpeg', { quality: 0.92 }))
  })

  return targets
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
 * `ZAP-STRAZAK-P`. Wersja do samodzielnego uzupelnienia nie ma dopasowania,
 * wiec synchronizacja zamowien nie zaklada dla niej sprawy personalizacji.
 */
async function ensurePersonalizedProduct(templateId: string, externalProductId: string) {
  const variant = VARIANTS.find((item) => item.personalized)!
  const existing = await prisma.personalizedProduct.findFirst({
    where: { shopId: SHOP_ID, identifierType: 'SKU', identifierValue: variant.reference },
  })

  // `externalProductId` panel tylko przechowuje (dopasowanie zamowien idzie po
  // referencji), ale bez niego nie widac, ktora karta w sklepie to jest.
  const data = { name: `${PRODUCT_NAME} (personalizowane)`, templateId, externalProductId, isActive: true }

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

  const personalizedProduct = await ensurePersonalizedProduct(template.id, productId)

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
          externalProductId: personalizedProduct.externalProductId,
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
