/**
 * Jednorazowa poprawka produktu w PrestaShop (sklep Kreatywne-papierki):
 * - nadaje reference (SKU) produktowi-rodzicowi i jego kombinacjom,
 * - ustawia producenta (marke), jesli produkt go nie ma (tworzy w razie potrzeby).
 *
 * Uzycie w kontenerze API:
 *   node /app/scripts/fix-ps-product-variant-skus.js <productId> <baseSku> [--apply]
 *   np. node /app/scripts/fix-ps-product-variant-skus.js 517 zap-g --apply
 * Bez --apply tylko raportuje stan i planowane zmiany.
 */
const prisma = require('/app/dist/lib/prisma').default;
const { decrypt } = require('/app/dist/lib/encryption');
const { PrestaShopClient } = require('/app/dist/services/prestashop/prestashop-client');

const SHOP_ID = 'cmscv7k7l0001h4khpd8arr5i';
const MANUFACTURER_NAME = 'Kreatywne Papierki';

const [productId, baseSku] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');

function replaceTag(xml, tag, value) {
  const cdata = `<![CDATA[${value}]]>`;
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?[\\s\\S]*?(?:\\]\\]>)?</${tag}>`);
  if (re.test(xml)) return xml.replace(re, `<${tag}>${cdata}</${tag}>`);
  return xml.replace(new RegExp(`<${tag}\\s*/>`), `<${tag}>${cdata}</${tag}>`);
}

async function main() {
  if (!productId || !baseSku) {
    console.error('Uzycie: node fix-ps-product-variant-skus.js <productId> <baseSku> [--apply]');
    process.exit(1);
  }

  const shop = await prisma.shop.findUnique({ where: { id: SHOP_ID } });
  if (!shop) throw new Error('Sklep nie znaleziony');
  const config = shop.configJson || {};
  const client = new PrestaShopClient({
    baseUrl: shop.baseUrl,
    apiKey: decrypt(shop.apiKey),
    authType: config.authType || 'WEB_SERVICE',
    adminApiConfig: config.authType === 'ADMIN_API' ? config.adminApi : undefined,
  });
  const ws = (endpoint, init, opts) => client['fetchWebServiceText'](endpoint, init, opts);
  const wsJson = async (endpoint) => JSON.parse((await ws(endpoint, { headers: { Accept: 'application/json' } }, { outputFormat: 'JSON' })).text);

  console.log(`Tryb: ${APPLY ? 'ZAPIS' : 'DRY-RUN'}; produkt ${productId}, baza SKU: ${baseSku}\n`);

  const productData = (await wsJson(`products/${productId}`)).product;
  const name = Array.isArray(productData.name) ? productData.name[0]?.value : productData.name;
  console.log(`Produkt: ${name}`);
  console.log(`  reference: ${productData.reference || '(brak)'}`);
  console.log(`  id_manufacturer: ${productData.id_manufacturer || '(brak)'}`);

  const combinationRefs = (productData.associations?.combinations ?? []).map((c) => c.id)
    .sort((a, b) => Number(a) - Number(b));
  console.log(`  kombinacje: ${combinationRefs.length ? combinationRefs.join(', ') : '(brak)'}\n`);

  // Kombinacje: opisz i nadaj reference wg kolejnosci id
  let index = 0;
  for (const combinationId of combinationRefs) {
    index += 1;
    const targetRef = `${baseSku}-${index}`;
    const combination = (await wsJson(`combinations/${combinationId}`)).combination;
    const optionValueIds = (combination.associations?.product_option_values ?? []).map((v) => v.id);
    const optionNames = [];
    for (const valueId of optionValueIds) {
      const value = (await wsJson(`product_option_values/${valueId}`)).product_option_value;
      optionNames.push(Array.isArray(value.name) ? value.name[0]?.value : value.name);
    }
    console.log(`Kombinacja ${combinationId} (${optionNames.join(', ') || '?'}): reference '${combination.reference || ''}' -> '${targetRef}'`);
    if (!APPLY) continue;

    const { text: combinationXml } = await ws(`combinations/${combinationId}`, { headers: { Accept: 'application/xml' } });
    const payload = replaceTag(combinationXml, 'reference', targetRef);
    await ws(`combinations/${combinationId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
      body: payload,
    });
    console.log(`  ZAPISANO ${targetRef}`);
  }

  // Producent
  let manufacturerId = Number(productData.id_manufacturer) || 0;
  if (manufacturerId === 0) {
    const list = await wsJson(`manufacturers?filter[name]=[${encodeURIComponent(MANUFACTURER_NAME)}]&display=[id,name]`);
    const found = (list.manufacturers ?? [])[0];
    if (found) {
      manufacturerId = Number(found.id);
      console.log(`\nProducent '${MANUFACTURER_NAME}' istnieje (id ${manufacturerId})`);
    } else if (APPLY) {
      const body = `<?xml version="1.0" encoding="UTF-8"?><prestashop><manufacturer><name><![CDATA[${MANUFACTURER_NAME}]]></name><active><![CDATA[1]]></active></manufacturer></prestashop>`;
      const { text: created } = await ws('manufacturers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
        body,
      });
      manufacturerId = Number((created.match(/<id>(?:<!\[CDATA\[)?(\d+)/) || [])[1] || 0);
      console.log(`\nUtworzono producenta '${MANUFACTURER_NAME}' (id ${manufacturerId})`);
    } else {
      console.log(`\nProducent '${MANUFACTURER_NAME}' do utworzenia (dry-run)`);
    }
  } else {
    const manufacturer = (await wsJson(`manufacturers/${manufacturerId}`)).manufacturer;
    console.log(`\nProdukt ma juz producenta: ${manufacturer?.name ?? '?'} (id ${manufacturerId}) — bez zmian marki`);
  }

  // Rodzic: reference + producent w jednym PUT
  const needsParentRef = !String(productData.reference || '').trim();
  const needsManufacturer = Number(productData.id_manufacturer) === 0 && manufacturerId > 0;
  if (needsParentRef || needsManufacturer) {
    console.log(`Rodzic: ${needsParentRef ? `reference -> '${baseSku}'` : 'reference bez zmian'}; ${needsManufacturer ? `id_manufacturer -> ${manufacturerId}` : 'producent bez zmian'}`);
    if (APPLY) {
      const { text: productXml } = await ws(`products/${productId}`, { headers: { Accept: 'application/xml' } });
      let payload = productXml;
      // pola tylko-do-odczytu, ktorych PS nie przyjmuje w PUT (tagi moga miec atrybuty)
      for (const tag of ['manufacturer_name', 'quantity', 'position_in_category']) {
        payload = payload
          .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'), '')
          .replace(new RegExp(`<${tag}\\b[^>]*/>`, 'g'), '');
      }
      if (needsParentRef) payload = replaceTag(payload, 'reference', baseSku);
      if (needsManufacturer) payload = replaceTag(payload, 'id_manufacturer', String(manufacturerId));
      await ws(`products/${productId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
        body: payload,
      });
      console.log('  ZAPISANO rodzica');
    }
  } else {
    console.log('Rodzic: bez zmian');
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
