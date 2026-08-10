/**
 * Automatyzacje wysylajace klientowi link do edytora - PO JEDNEJ NA SKLEP.
 *
 * Dlaczego per sklep, a nie jedna wspolna: tresc maila jest czescia obslugi
 * konkretnego sklepu (inny ton, inne terminy, inny podpis), a warunek
 * `shopId` pozwala edytowac ja osobno w panelu. Nadawca i tak jest juz
 * rozdzielony po sklepach w ustawieniach SMTP.
 *
 * UWAGA na duble: automatyzacja BEZ warunku obejmuje wszystkie sklepy, wiec
 * zostawiona obok regul per sklep wyslalaby drugi mail z tego samego
 * zdarzenia. Skrypt wylacza wiec stara regule ogolna o tej samej nazwie.
 *
 * Dlaczego automatyzacja, a nie flaga AUTO_SEND_EMAILS: `SEND_EMAIL` wysyla
 * niezaleznie od flagi, a tresc redagujesz w panelu bez zmiany kodu. Obie
 * sciezki wlaczone naraz to znowu dwa maile.
 *
 * Tresc jest ZWYKLYM TEKSTEM - `sendAutomationEmail` zamienia znaki nowej
 * linii na `<br>`. Zmienne: {{customerName}}, {{orderReference}},
 * {{shopName}}, {{personalizationLinks}} (wszystkie produkty zamowienia,
 * kazdy z nazwa, liczba sztuk i adresem edytora) oraz {{personalizationUrl}}
 * (adres pierwszej sprawy - dla tresci pisanych pod jeden produkt).
 *
 * Idempotentny - regule rozpoznaje po nazwie i nadpisuje jej tresc.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/create-personalization-email-automation.js
 *   SHOP_IDS=id1,id2 - tylko wskazane sklepy (domyslnie: wszystkie tenanta)
 *   DRY_RUN=1        - pokaz, co powstanie, bez zapisu
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TENANT_SLUG = process.env.TENANT_SLUG || 'kreatywne-papierki'

/** Nazwa starej reguly bez warunku - wylaczamy ja, zeby nie dublowac maili. */
const LEGACY_NAME = 'Link do edytora po złożeniu zamówienia'

const ruleName = (shopName: string) => `${LEGACY_NAME} — ${shopName}`

const SUBJECT = 'Zaproszenie czeka na Twoją treść — zamówienie {{orderReference}}'

// Bez zwrotu po imieniu: puste `customerName` zostawiloby "Dzień dobry ,".
const BODY = `Dzień dobry,

dziękujemy za zamówienie {{orderReference}} w sklepie {{shopName}}.

Zamówione produkty są personalizowane — treść ustalasz sam w edytorze:

{{personalizationLinks}}

Wpisujesz tam imiona gości, datę i godzinę przyjęcia, miejsce oraz pozostałe napisy, a podgląd od razu pokazuje gotową kartę. Jeśli zamówienie obejmuje kilka sztuk, każdą możesz zaadresować do innego gościa.

Drukujemy dopiero po Twojej akceptacji, więc spokojnie sprawdź wszystko przed zatwierdzeniem — na tym etapie każda poprawka jest jeszcze bezpłatna. Linki są przypisane do Twojego zamówienia, prosimy nie udostępniać ich dalej.

W razie pytań wystarczy odpowiedzieć na tę wiadomość.

Pozdrawiamy,
{{shopName}}`

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new Error(`Brak tenanta "${TENANT_SLUG}"`)

  const only = (process.env.SHOP_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  const shops = await prisma.shop.findMany({
    where: { tenantId: tenant.id, ...(only.length ? { id: { in: only } } : {}) },
    select: { id: true, name: true },
    orderBy: { createdAt: 'asc' },
  })
  if (shops.length === 0) throw new Error('Tenant nie ma sklepow do obsluzenia')

  const planned = shops.map((shop) => ({
    shop: shop.name,
    name: ruleName(shop.name),
    // `shopId` jest polem rozpoznawanym wprost przez silnik regul
    // (`getFieldValue` czyta z niego `order.shop.id`).
    conditions: [{ field: 'shopId', operator: 'equals', value: shop.id }],
  }))

  if (process.env.DRY_RUN === '1') {
    console.log(JSON.stringify({ dryRun: true, tenant: TENANT_SLUG, reguly: planned, subject: SUBJECT }, null, 2))
    return
  }

  const results = []
  for (const shop of shops) {
    const data = {
      name: ruleName(shop.name),
      description: `Wysyła link do personalizacji po założeniu sprawy — sklep ${shop.name}.`,
      trigger: 'CASE_CREATED',
      conditions: [{ field: 'shopId', operator: 'equals', value: shop.id }],
      actions: [
        {
          type: 'SEND_EMAIL',
          config: { to: 'customer', subject: SUBJECT, body: BODY },
        },
      ],
      isActive: true,
      priority: 0,
    }

    const existing = await prisma.automation.findFirst({
      where: { tenantId: tenant.id, name: data.name },
    })
    const automation = existing
      ? await prisma.automation.update({ where: { id: existing.id }, data })
      : await prisma.automation.create({ data: { tenantId: tenant.id, ...data } })

    results.push({ sklep: shop.name, id: automation.id, utworzona: !existing })
  }

  // Regula ogolna obejmowalaby te same sprawy co reguly per sklep - zostawiona
  // aktywna wyslalaby drugi mail z tego samego zdarzenia.
  const legacy = await prisma.automation.updateMany({
    where: { tenantId: tenant.id, name: LEGACY_NAME, isActive: true },
    data: { isActive: false },
  })

  console.log(JSON.stringify({ reguly: results, wylaczonaOgolna: legacy.count }, null, 2))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
