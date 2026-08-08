/**
 * Publikacja winietki "MIS" jako produktu: karta w PrestaShop
 * (kreatywne-papierki.pl) + wpis produktu personalizowanego w panelu.
 *
 * Skrypt jest idempotentny - rozpoznaje produkt po referencji `WIN-MIS`,
 * atrybut po nazwie, kombinacje po wartosciach atrybutu, zdjecie po tym, czy
 * karta juz jakies ma. Ponowne uruchomienie aktualizuje opisy i cene zamiast
 * zakladac drugi produkt.
 *
 * WAZNE: kombinacje celowo NIE dostaja wlasnych referencji. PrestaShop
 * wpisuje do pozycji zamowienia referencje kombinacji, jesli ta jest
 * ustawiona - a dopasowanie produktu personalizowanego (sync-orders) szuka
 * po referencji produktu. Wlasna referencja kombinacji zerwalaby to
 * dopasowanie i zamowienie nie trafiloby do personalizacji.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/publish-mis-product.js
 */
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { decrypt } from '../lib/encryption'
import { renderMockupPng } from '../services/renderer/fabric-renderer.service'

const prisma = new PrismaClient()

const SHOP_ID = process.env.SHOP_ID || 'cmscv7k7l0001h4khpd8arr5i' // Kreatywne-papierki
const TEMPLATE_CODE = 'MIS'
const CATEGORY_ID = process.env.CATEGORY_ID || '49' // Winietki i wizytówki na stół
const LANGUAGE_ID = '1'
const TAX_RULES_GROUP_ID = '1' // PL Standard Rate (23%)
const TAX_RATE = 0.23

const REFERENCE = 'WIN-MIS'
const PRODUCT_NAME = 'Winietka personalizowana na stół – Miś z Balonikami'

/** Cena katalogowa brutto; PrestaShop trzyma netto, wiec dzielimy przez VAT. */
const PRICE_GROSS = 1.5
const PRICE_NET = Number((PRICE_GROSS / (1 + TAX_RATE)).toFixed(6))

const MINIMAL_QUANTITY = 10

/**
 * Widocznosc karty w sklepie. Pierwsze uruchomienie warto zrobic z
 * `PRODUCT_ACTIVE=0`: produkt powstaje niewidoczny, sprawdzamy zdjecie,
 * warianty i opisy, dopiero potem wlaczamy sprzedaz.
 */
const PRODUCT_ACTIVE = process.env.PRODUCT_ACTIVE === '0' ? '0' : '1'

const ATTRIBUTE_GROUP_NAME = 'Rodzaj papieru'
const ATTRIBUTE_VALUES = ['Karton z fakturą', 'Karton gładki']

const META_TITLE = 'Winietka personalizowana Miś z Balonikami – roczek i urodziny dziecka'
const META_DESCRIPTION =
  'Składana winietka na stół 105 × 50 mm z akwarelowym misiem z balonikami. ' +
  'Imię i nazwisko każdego gościa drukujemy osobno. Papier do wyboru, minimalne zamówienie 10 szt.'

const DESCRIPTION_SHORT = `<p>Składana <strong>winietka na stół 105 × 50 mm</strong> z akwarelową ilustracją misia w papierowej czapeczce z bukietem balonów. Imię i nazwisko każdego gościa drukujemy osobno – nie ma jednej wspólnej treści dla całego zamówienia.</p>
<p>✔ personalizacja – osobne imię i nazwisko na każdej winietce<br />✔ papier do wyboru: karton z fakturą lub gładki<br />✔ winietka składana, stoi samodzielnie na stole<br />✔ minimalne zamówienie 10 szt.</p>`

const DESCRIPTION = `<h2>Winietka personalizowana „Miś z Balonikami”</h2>
<p>Składana winietka na stół z akwarelową ilustracją misia w papierowej czapeczce, trzymającego bukiet balonów. Ciepłe, beżowo-brązowe odcienie pasują do dekoracji w stylu boho i do klasycznych, stonowanych aranżacji stołu.</p>
<p>Winietka jest <strong>składana</strong> – po złożeniu stoi samodzielnie na talerzu lub obok nakrycia, bez dodatkowej podstawki. Imię gościa zapisujemy elegancką szeryfową antykwą w kolorze ciepłego brązu, dobranym do ilustracji.</p>
<p>Każda winietka drukowana jest z <strong>imieniem i nazwiskiem konkretnego gościa</strong>. Po złożeniu zamówienia wypełniasz listę gości – tyle wpisów, ile sztuk zamawiasz – a my drukujemy każdą winietkę osobno.</p>

<h2>Specyfikacja produktu</h2>
<p><strong>Rodzaj:</strong> winietka składana (namiotowa)<br /><strong>Format po złożeniu:</strong> 105 × 50 mm<br /><strong>Arkusz przed złożeniem:</strong> 105 × 100 mm<br /><strong>Orientacja:</strong> pozioma<br /><strong>Nadruk:</strong> kolorowy, jednostronny – na przedniej ściance<br /><strong>Papier:</strong> do wyboru – karton z delikatną fakturą albo karton gładki<br /><strong>Personalizacja:</strong> imię i nazwisko gościa, osobno dla każdej sztuki<br /><strong>Minimalne zamówienie:</strong> 10 sztuk</p>

<h2>Jak zamówić</h2>
<ol>
<li>Wybierz rodzaj papieru.</li>
<li>Podaj liczbę sztuk – tyle, ilu masz gości.</li>
<li>Wypełnij listę gości: imię i nazwisko dla każdej winietki osobno.</li>
<li>Resztą zajmujemy się my – drukujemy, składamy i wysyłamy gotowe winietki.</li>
</ol>

<h2>Na jaką okazję</h2>
<ul>
<li>roczek i drugie urodziny</li>
<li>urodziny dziecka</li>
<li>chrzciny</li>
<li>baby shower</li>
<li>rodzinne przyjęcia w stylu boho</li>
</ul>
<p>Winietka pochodzi z tej samej kolekcji co pozostała papeteria z misiem – zestaw dekoracji stołu można ułożyć w jednym stylu.</p>`

// --- PrestaShop: minimalny klient webservice ---------------------------
// Klient z `services/prestashop` obsluguje tworzenie produktu, ale nie
// atrybutow ani kombinacji - a te sa tu sednem (dwa rodzaje papieru).

type Shop = { baseUrl: string; apiKey: string }

function api(shop: Shop) {
  const baseUrl = shop.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '')
  const auth = 'Basic ' + Buffer.from(`${shop.apiKey}:`).toString('base64')

  async function request(endpoint: string, init: RequestInit = {}, format: 'JSON' | 'XML' = 'JSON') {
    const separator = endpoint.includes('?') ? '&' : '?'
    const url = `${baseUrl}/api/${endpoint}${format === 'JSON' ? `${separator}output_format=JSON` : ''}`
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: auth,
        Accept: format === 'JSON' ? 'application/json' : 'application/xml',
        ...(init.headers || {}),
      },
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${init.method || 'GET'} ${endpoint} -> ${response.status}: ${text.slice(0, 600)}`)
    }
    return { text, response }
  }

  return {
    baseUrl,
    async getJson<T = any>(endpoint: string): Promise<T> {
      const { text } = await request(endpoint)
      return text ? JSON.parse(text) : ({} as T)
    },
    async getXml(endpoint: string) {
      const { text } = await request(endpoint, {}, 'XML')
      return text
    },
    async sendXml(endpoint: string, method: 'POST' | 'PUT', body: string) {
      const { text } = await request(
        endpoint,
        { method, body, headers: { 'Content-Type': 'application/xml' } },
        'XML'
      )
      return text
    },
    async deleteImage(productId: string, imageId: string) {
      await request(`images/products/${productId}/${imageId}`, { method: 'DELETE' }, 'XML')
    },
    async uploadImage(productId: string, filePath: string) {
      const buffer = fs.readFileSync(filePath)
      const form = new FormData()
      const mimeType = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg'
      form.append('image', new Blob([buffer], { type: mimeType }), path.basename(filePath))
      const response = await fetch(`${baseUrl}/api/images/products/${productId}`, {
        method: 'POST',
        headers: { Authorization: auth },
        body: form,
      })
      const text = await response.text()
      if (!response.ok) throw new Error(`upload zdjecia -> ${response.status}: ${text.slice(0, 400)}`)
      return text
    },
  }
}

const cdata = (value: string) => value.replace(/]]>/g, ']]]]><![CDATA[>')
const xmlValue = (text: string, tag: string) =>
  text.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:]]>)?\\s*</${tag}>`))?.[1]?.trim() ?? ''

/** Podmienia zawartosc pojedynczego pola w XML zasobu. */
function setTag(xml: string, tag: string, value: string) {
  const pattern = new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`)
  const replacement = `<${tag}><![CDATA[${cdata(value)}]]></${tag}>`
  return pattern.test(xml) ? xml.replace(pattern, replacement) : xml
}

/** Podmienia pole wielojezyczne (sklep ma jeden jezyk - pl). */
function setLangTag(xml: string, tag: string, value: string) {
  const pattern = new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`)
  const replacement = `<${tag}><language id="${LANGUAGE_ID}"><![CDATA[${cdata(value)}]]></language></${tag}>`
  return pattern.test(xml) ? xml.replace(pattern, replacement) : xml
}

/** Pola, ktore PrestaShop wystawia tylko do odczytu - PUT z nimi konczy sie bledem. */
function stripReadOnly(xml: string) {
  return xml
    .replace(/<manufacturer_name[\s\S]*?<\/manufacturer_name>/g, '')
    .replace(/<quantity[\s\S]*?<\/quantity>/g, '')
}

// --- Zdjecie produktu --------------------------------------------------

/**
 * Zdjecie do karty produktu: mockup wyrenderowany z szablonu, wiec pokazuje
 * dokladnie to, co dostanie klient. Proporcje 2:3 w pionie bierzemy z samego
 * zdjecia (1024 x 1536).
 */
async function ensureProductPhoto(layout: any, force = false) {
  const relative = path.join('templates', TEMPLATE_CODE, 'produkt', 'winietka-mis-foto-1.jpg')
  const absolute = path.join(process.cwd(), 'storage', relative)
  if (fs.existsSync(absolute) && !force) return absolute

  const mockup = layout.mockups?.[0]
  if (!mockup) throw new Error('Szablon MIS nie ma mockupu - nie ma z czego zrobic zdjecia produktu')

  const png = await renderMockupPng(layout, { guest_name: 'Anna Kowalska' }, mockup)

  // PrestaShop odrzuca pliki powyzej 2000 KB, a render PNG wazy okolo 2 MB -
  // zdjecie produktowe i tak nalezy do JPEG.
  const { createCanvas, loadImage } = await import('canvas')
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  canvas.getContext('2d').drawImage(image as any, 0, 0)
  const jpeg = canvas.toBuffer('image/jpeg', { quality: 0.9 })

  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, jpeg)
  return absolute
}

// --- Atrybut i kombinacje ---------------------------------------------

async function ensureAttributeGroup(shop: ReturnType<typeof api>) {
  const groups = await shop.getJson<any>('product_options?display=full')
  const existing = (groups.product_options || []).find((group: any) => {
    const name = Array.isArray(group.name) ? group.name[0]?.value : group.name
    return String(name).trim().toLowerCase() === ATTRIBUTE_GROUP_NAME.toLowerCase()
  })
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

  const created = await shop.sendXml('product_options', 'POST', payload)
  return xmlValue(created, 'id')
}

async function ensureAttributeValues(shop: ReturnType<typeof api>, groupId: string) {
  const group = await shop.getJson<any>(`product_options/${groupId}`)
  const valueIds: string[] = (group.product_option?.associations?.product_option_values || []).map((value: any) =>
    String(value.id)
  )

  const byName = new Map<string, string>()
  for (const valueId of valueIds) {
    const value = await shop.getJson<any>(`product_option_values/${valueId}`)
    const name = Array.isArray(value.product_option_value?.name)
      ? value.product_option_value.name[0]?.value
      : value.product_option_value?.name
    byName.set(String(name).trim().toLowerCase(), valueId)
  }

  const result: string[] = []
  for (const [index, name] of ATTRIBUTE_VALUES.entries()) {
    const found = byName.get(name.toLowerCase())
    if (found) {
      result.push(found)
      continue
    }
    const payload = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product_option_value>
    <id_attribute_group>${groupId}</id_attribute_group>
    <color></color>
    <position>${index}</position>
    <name><language id="${LANGUAGE_ID}"><![CDATA[${cdata(name)}]]></language></name>
  </product_option_value>
</prestashop>`
    const created = await shop.sendXml('product_option_values', 'POST', payload)
    result.push(xmlValue(created, 'id'))
  }

  return result
}

async function ensureCombinations(shop: ReturnType<typeof api>, productId: string, valueIds: string[]) {
  const product = await shop.getJson<any>(`products/${productId}`)
  const existing: any[] = product.product?.associations?.combinations || []
  if (existing.length > 0) {
    return existing.map((combination: any) => String(combination.id))
  }

  const created: string[] = []
  for (const [index, valueId] of valueIds.entries()) {
    // Bez <reference>: patrz komentarz na gorze pliku - wlasna referencja
    // kombinacji podmienilaby referencje w pozycji zamowienia.
    const payload = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <combination>
    <id_product>${productId}</id_product>
    <minimal_quantity>${MINIMAL_QUANTITY}</minimal_quantity>
    <price>0.000000</price>
    <default_on>${index === 0 ? 1 : ''}</default_on>
    <associations>
      <product_option_values nodeType="product_option_value" api="product_option_values">
        <product_option_value><id>${valueId}</id></product_option_value>
      </product_option_values>
    </associations>
  </combination>
</prestashop>`
    const response = await shop.sendXml('combinations', 'POST', payload)
    created.push(xmlValue(response, 'id'))
  }

  return created
}

/**
 * Dostepnosc: winietka powstaje na zamowienie, wiec stan magazynowy zostaje
 * zerowy, a sklep ma pozwalac na zakup mimo braku stanu (`out_of_stock = 1`).
 */
async function allowOrdersWithoutStock(shop: ReturnType<typeof api>, productId: string) {
  const stock = await shop.getJson<any>(`stock_availables?display=full&filter[id_product]=[${productId}]`)
  for (const entry of stock.stock_availables || []) {
    const xml = await shop.getXml(`stock_availables/${entry.id}`)
    const updated = setTag(xml, 'out_of_stock', '1')
    await shop.sendXml(`stock_availables/${entry.id}`, 'PUT', updated)
  }
}

// --- Produkt -----------------------------------------------------------

async function findProductIdByReference(shop: ReturnType<typeof api>) {
  const data = await shop.getJson<any>(
    `products?filter[reference]=[${encodeURIComponent(REFERENCE)}]&display=[id,reference]&limit=1`
  )
  const products = data.products ? (Array.isArray(data.products) ? data.products : [data.products]) : []
  return products[0] ? String(products[0].id) : null
}

function slugify(value: string) {
  return (
    value
      // NFD nie rozklada "l" z kreska, wiec bez tej podmiany "stol" gubi
      // cala litere i w adresie zostaje "sto".
      .replace(/\u0142/g, 'l')
      .replace(/\u0141/g, 'L')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'produkt'
  )
}

async function createProduct(shop: ReturnType<typeof api>) {
  const payload = `<?xml version="1.0" encoding="UTF-8"?>
<prestashop xmlns:xlink="http://www.w3.org/1999/xlink">
  <product>
    <id_shop_default>1</id_shop_default>
    <id_category_default>${CATEGORY_ID}</id_category_default>
    <id_tax_rules_group>${TAX_RULES_GROUP_ID}</id_tax_rules_group>
    <state>1</state>
    <reference><![CDATA[${REFERENCE}]]></reference>
    <price>${PRICE_NET}</price>
    <minimal_quantity>${MINIMAL_QUANTITY}</minimal_quantity>
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
      <categories nodeType="category" api="categories">
        <category><id>${CATEGORY_ID}</id></category>
      </categories>
    </associations>
  </product>
</prestashop>`

  const created = await shop.sendXml('products', 'POST', payload)
  const id = xmlValue(created, 'id')
  if (!id) throw new Error('PrestaShop nie zwrocil id nowego produktu')
  return id
}

/** Dociaga tresci na istniejacej karcie - bez ruszania tego, czego nie znamy. */
async function updateProduct(shop: ReturnType<typeof api>, productId: string) {
  let xml = await shop.getXml(`products/${productId}`)
  xml = stripReadOnly(xml)
  xml = setTag(xml, 'price', String(PRICE_NET))
  xml = setTag(xml, 'minimal_quantity', String(MINIMAL_QUANTITY))
  xml = setTag(xml, 'active', PRODUCT_ACTIVE)
  xml = setTag(xml, 'available_for_order', '1')
  xml = setTag(xml, 'id_tax_rules_group', TAX_RULES_GROUP_ID)
  xml = setTag(xml, 'id_category_default', CATEGORY_ID)
  xml = setLangTag(xml, 'name', PRODUCT_NAME)
  xml = setLangTag(xml, 'link_rewrite', slugify(PRODUCT_NAME))
  xml = setLangTag(xml, 'description', DESCRIPTION)
  xml = setLangTag(xml, 'description_short', DESCRIPTION_SHORT)
  xml = setLangTag(xml, 'meta_title', META_TITLE)
  xml = setLangTag(xml, 'meta_description', META_DESCRIPTION)
  await shop.sendXml(`products/${productId}`, 'PUT', xml)
}

// --- Produkt personalizowany w panelu ----------------------------------

async function ensurePersonalizedProduct(templateId: string, externalProductId: string) {
  const existing = await prisma.personalizedProduct.findFirst({
    where: { shopId: SHOP_ID, identifierType: 'SKU', identifierValue: REFERENCE },
  })

  const data = {
    name: PRODUCT_NAME,
    templateId,
    externalProductId,
    isActive: true,
  }

  if (existing) {
    return prisma.personalizedProduct.update({ where: { id: existing.id }, data })
  }

  return prisma.personalizedProduct.create({
    data: {
      shopId: SHOP_ID,
      identifierType: 'SKU',
      identifierValue: REFERENCE,
      ...data,
    },
  })
}

async function main() {
  const template = await prisma.personalizationTemplate.findFirst({ where: { code: TEMPLATE_CODE } })
  if (!template) throw new Error(`Brak szablonu ${TEMPLATE_CODE}`)

  const shopRecord = await prisma.shop.findUnique({ where: { id: SHOP_ID } })
  if (!shopRecord) throw new Error(`Brak sklepu ${SHOP_ID}`)
  const shop = api({ baseUrl: shopRecord.baseUrl, apiKey: decrypt(shopRecord.apiKey) })

  // REPLACE_PHOTO=1 - przerysowanie zdjecia i podmiana go na karcie, np. po
  // poprawce renderera albo zmianie ukladu winietki.
  const replacePhoto = process.env.REPLACE_PHOTO === '1'
  const photoPath = await ensureProductPhoto(template.layoutJson as any, replacePhoto)

  let productId = await findProductIdByReference(shop)
  const created = !productId
  if (!productId) {
    productId = await createProduct(shop)
  }
  await updateProduct(shop, productId)

  const groupId = await ensureAttributeGroup(shop)
  const valueIds = await ensureAttributeValues(shop, groupId)
  const combinationIds = await ensureCombinations(shop, productId, valueIds)
  await allowOrdersWithoutStock(shop, productId)

  const product = await shop.getJson<any>(`products/${productId}`)
  const images: any[] = product.product?.associations?.images || []
  if (replacePhoto) {
    for (const image of images) {
      await shop.deleteImage(productId, String(image.id))
    }
  }
  if (images.length === 0 || replacePhoto) {
    await shop.uploadImage(productId, photoPath)
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
          priceNet: PRICE_NET,
          priceGross: PRICE_GROSS,
          categoryId: CATEGORY_ID,
          minimalQuantity: MINIMAL_QUANTITY,
          active: PRODUCT_ACTIVE === '1',
          attributeGroupId: groupId,
          attributeValueIds: valueIds,
          combinationIds,
          photo: images.length === 0 || replacePhoto ? path.basename(photoPath) : 'juz bylo',
          url: `${shop.baseUrl}/index.php?id_product=${productId}&controller=product`,
        },
        panel: {
          personalizedProductId: personalizedProduct.id,
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
