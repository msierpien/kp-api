/**
 * Publikacja winietki "Botaniczna Zieleń" jako produktu: karta w PrestaShop
 * (kreatywne-papierki.pl) + wpis produktu personalizowanego w panelu.
 *
 * Skrypt jest idempotentny - rozpoznaje produkt po referencji `WIN-BOTANICZNA`,
 * zdjecie po tym, czy karta juz jakies ma. Ponowne uruchomienie aktualizuje
 * opisy i cene zamiast zakladac drugi produkt.
 *
 * Bez kombinacji (rodzaju papieru) - winietka ma jedna wersje, wiec minimalna
 * ilosc siedzi na samym produkcie. Gdyby doszly warianty, kombinacje NIE moga
 * dostac wlasnych referencji: PrestaShop wpisuje do pozycji zamowienia
 * referencje kombinacji, a dopasowanie produktu personalizowanego (sync-orders)
 * szuka po referencji produktu.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/publish-winietka-botaniczna-product.js
 *
 * Zmienne:
 *   PHOTO_ONLY=1     - tylko wyrenderuj zdjecie z mockupu i wyjdz (do obejrzenia)
 *   REPLACE_PHOTO=1  - przerysuj zdjecie i podmien je na karcie
 *   PRODUCT_ACTIVE=0 - zaloz karte niewidoczna w sklepie
 */
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { decrypt } from '../lib/encryption'
import { renderMockupPng } from '../services/renderer/fabric-renderer.service'
import {
  LANGUAGE_ID,
  cdata,
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
const TEMPLATE_CODE = 'WINIETKA_BOTANICZNA'
const CATEGORY_ID = process.env.CATEGORY_ID || '49' // Winietki i wizytówki na stół
const TAX_RULES_GROUP_ID = '1' // PL Standard Rate (23%)
const TAX_RATE = 0.23

const REFERENCE = 'WIN-BOTANICZNA'
const PRODUCT_NAME = 'Winietka personalizowana na stół – Botaniczna Zieleń'

/** Cena katalogowa brutto; PrestaShop trzyma netto, wiec dzielimy przez VAT. */
const PRICE_GROSS = 1.5
const PRICE_NET = Number((PRICE_GROSS / (1 + TAX_RATE)).toFixed(6))

const MINIMAL_QUANTITY = 10

/**
 * Widocznosc karty w sklepie. Pierwsze uruchomienie warto zrobic z
 * `PRODUCT_ACTIVE=0`: produkt powstaje niewidoczny, sprawdzamy zdjecie
 * i opisy, dopiero potem wlaczamy sprzedaz.
 */
const PRODUCT_ACTIVE = process.env.PRODUCT_ACTIVE === '0' ? '0' : '1'

const META_TITLE = 'Winietka personalizowana Botaniczna Zieleń – wesele, eukaliptus'
const META_DESCRIPTION =
  'Składana winietka na stół 105 × 50 mm z akwarelowym eukaliptusem. ' +
  'Imię i nazwisko każdego gościa drukujemy osobno. Minimalne zamówienie 10 szt.'

const DESCRIPTION_SHORT = `<p>Składana <strong>winietka na stół 105 × 50 mm</strong> z akwarelowym wieńcem eukaliptusa u góry i u dołu. Imię i nazwisko każdego gościa drukujemy osobno – nie ma jednej wspólnej treści dla całego zamówienia.</p>
<p>✔ personalizacja – osobne imię i nazwisko na każdej winietce<br />✔ delikatna zieleń pasująca do dekoracji z eukaliptusem<br />✔ winietka składana, stoi samodzielnie na stole<br />✔ minimalne zamówienie 10 szt.</p>`

const DESCRIPTION = `<h2>Winietka personalizowana „Botaniczna Zieleń”</h2>
<p>Składana winietka na stół z akwarelowym wieńcem eukaliptusa – gałązki i okrągłe listki w odcieniach szałwiowej i butelkowej zieleni obejmują imię gościa od góry i od dołu. Środek karty zostaje czysty, więc napis jest czytelny z drugiej strony stołu.</p>
<p>Winietka jest <strong>składana</strong> – po złożeniu stoi samodzielnie na talerzu lub obok nakrycia, bez dodatkowej podstawki.</p>
<p>Każda winietka drukowana jest z <strong>imieniem i nazwiskiem konkretnego gościa</strong>. Po złożeniu zamówienia wypełniasz listę gości – tyle wpisów, ile sztuk zamawiasz – a my drukujemy każdą winietkę osobno.</p>

<h2>Specyfikacja produktu</h2>
<p><strong>Rodzaj:</strong> winietka składana (namiotowa)<br /><strong>Format po złożeniu:</strong> 105 × 50 mm<br /><strong>Arkusz przed złożeniem:</strong> 105 × 100 mm<br /><strong>Orientacja:</strong> pozioma<br /><strong>Nadruk:</strong> kolorowy, jednostronny – na przedniej ściance<br /><strong>Personalizacja:</strong> imię i nazwisko gościa, osobno dla każdej sztuki<br /><strong>Minimalne zamówienie:</strong> 10 sztuk</p>

<h2>Jak zamówić</h2>
<ol>
<li>Podaj liczbę sztuk – tyle, ilu masz gości.</li>
<li>Wypełnij listę gości: imię i nazwisko dla każdej winietki osobno.</li>
<li>Resztą zajmujemy się my – drukujemy, składamy i wysyłamy gotowe winietki.</li>
</ol>

<h2>Na jaką okazję</h2>
<ul>
<li>wesele i przyjęcie weselne w stylu greenery</li>
<li>ślub w plenerze i wesele rustykalne</li>
<li>komunia i chrzciny</li>
<li>przyjęcia z dekoracją z eukaliptusa i zieleni</li>
<li>rocznice i uroczyste kolacje</li>
</ul>
<p>Zieleń eukaliptusa łączy się z bielą, beżem i złotem, więc winietka pasuje zarówno do klasycznej, jak i do rustykalnej aranżacji stołu.</p>`

// --- Zdjecie produktu --------------------------------------------------

/**
 * Zdjecie do karty produktu: mockup wyrenderowany z szablonu, wiec pokazuje
 * dokladnie to, co dostanie klient.
 */
async function ensureProductPhoto(layout: any, force = false) {
  const relative = path.join('templates', TEMPLATE_CODE, 'produkt', 'winietka-botaniczna-foto-1.jpg')
  const absolute = path.join(process.cwd(), 'storage', relative)
  if (fs.existsSync(absolute) && !force) return absolute

  const mockup = layout.mockups?.[0]
  if (!mockup) {
    throw new Error(`Szablon ${TEMPLATE_CODE} nie ma mockupu - nie ma z czego zrobic zdjecia produktu`)
  }

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

/**
 * Dostepnosc: winietka powstaje na zamowienie, wiec stan magazynowy zostaje
 * zerowy, a sklep ma pozwalac na zakup mimo braku stanu (`out_of_stock = 1`).
 */
async function allowOrdersWithoutStock(shop: PrestaShopApi, productId: string) {
  const stock = await shop.getJson<any>(`stock_availables?display=full&filter[id_product]=[${productId}]`)
  for (const entry of stock.stock_availables || []) {
    const xml = await shop.getXml(`stock_availables/${entry.id}`)
    const updated = setTag(xml, 'out_of_stock', '1')
    await shop.sendXml(`stock_availables/${entry.id}`, 'PUT', updated)
  }
}

// --- Produkt -----------------------------------------------------------

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
async function updateProduct(shop: PrestaShopApi, productId: string) {
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

  // REPLACE_PHOTO=1 - przerysowanie zdjecia i podmiana go na karcie, np. po
  // poprawce renderera albo zmianie ukladu winietki.
  const replacePhoto = process.env.REPLACE_PHOTO === '1'
  const photoPath = await ensureProductPhoto(template.layoutJson as any, replacePhoto)

  // PHOTO_ONLY=1 - zdjecie do obejrzenia, zanim cokolwiek pojawi sie w sklepie.
  if (process.env.PHOTO_ONLY === '1') {
    const { size } = fs.statSync(photoPath)
    console.log(JSON.stringify({ photo: photoPath, bytes: size }, null, 2))
    return
  }

  const shopRecord = await prisma.shop.findUnique({ where: { id: SHOP_ID } })
  if (!shopRecord) throw new Error(`Brak sklepu ${SHOP_ID}`)
  const shop = prestaShopApi({ baseUrl: shopRecord.baseUrl, apiKey: decrypt(shopRecord.apiKey) })

  let productId = await findProductIdByReference(shop)
  const created = !productId
  if (!productId) {
    productId = await createProduct(shop)
  }
  await updateProduct(shop, productId)
  await allowOrdersWithoutStock(shop, productId)

  const product = await shop.getJson<any>(`products/${productId}`)
  const images: any[] = product.product?.associations?.images || []
  if (replacePhoto) {
    for (const image of images) {
      await shop.deleteResource(`images/products/${productId}/${image.id}`)
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
