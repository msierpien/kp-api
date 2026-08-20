/**
 * Startowa biblioteka szablonow wiadomosci do klienta.
 *
 * Tresci sa wspolne dla wszystkich sklepow (`shopId = null`) — nazwe sklepu
 * wstawia `{{shopName}}`. Jesli ktorys sklep ma pisac inaczej, zduplikuj
 * szablon w panelu i przypisz go do sklepu; wpis sklepowy wygrywa nad
 * wspolnym.
 *
 * Idempotentny: rozpoznaje szablon po `key` i nadpisuje jego tresc. Zadnego
 * maila nie wysyla — zaklada tylko tresci, ktore potem wskazuje regula.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/create-email-templates.js
 *   DRY_RUN=1 - pokaz, co powstanie, bez zapisu
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TENANT_SLUG = process.env.TENANT_SLUG || 'kreatywne-papierki'
const DRY_RUN = process.env.DRY_RUN === '1'

interface TemplateSeed {
  key: string
  name: string
  description: string
  subject: string
  bodyText: string
  scope: 'ORDER' | 'CASE'
}

const TEMPLATES: TemplateSeed[] = [
  {
    key: 'shipment-ready-to-pickup',
    name: 'Paczka czeka w paczkomacie',
    description: 'Etap doręczenia READY_TO_PICKUP — przesyłka dotarła do punktu i czeka na odbiór.',
    scope: 'ORDER',
    subject: 'Paczka czeka na odbiór — zamówienie {{orderReference}}',
    bodyText: [
      'Dzień dobry,',
      '',
      'paczka z zamówienia {{orderReference}} dotarła na miejsce i czeka na odbiór.',
      '',
      'Punkt odbioru: {{pickupPoint}}',
      'Numer przesyłki: {{trackingNumber}}',
      'Podgląd przesyłki: {{trackingUrl}}',
      '',
      'Kod do otwarcia skrytki znajdziesz w wiadomości od InPostu — w SMS-ie',
      'albo w aplikacji InPost Mobile.',
      '',
      'Pozdrawiamy,',
      '{{shopName}}',
    ].join('\n'),
  },
  {
    key: 'shipment-out-for-delivery',
    name: 'Kurier doręcza dziś',
    description: 'Etap doręczenia OUT_FOR_DELIVERY — paczka jest na trasie kuriera.',
    scope: 'ORDER',
    subject: 'Kurier jedzie z paczką — zamówienie {{orderReference}}',
    bodyText: [
      'Dzień dobry,',
      '',
      'paczka z zamówienia {{orderReference}} jest już u kuriera i powinna dotrzeć dzisiaj.',
      '',
      'Numer przesyłki: {{trackingNumber}}',
      'Śledzenie: {{trackingUrl}}',
      '',
      'Gdyby kurier Cię nie zastał, zostawi informację o kolejnej próbie doręczenia.',
      '',
      'Pozdrawiamy,',
      '{{shopName}}',
    ].join('\n'),
  },
  {
    key: 'shipment-pickup-reminder',
    name: 'Przypomnienie o odbiorze paczki',
    description: 'Etap PICKUP_REMINDER — czas na odbiór dobiega końca, przesyłka wciąż w punkcie.',
    scope: 'ORDER',
    subject: 'Przypominamy o odbiorze paczki — {{orderReference}}',
    bodyText: [
      'Dzień dobry,',
      '',
      'paczka z zamówienia {{orderReference}} wciąż czeka na odbiór, a czas na jej',
      'odebranie powoli się kończy.',
      '',
      'Punkt odbioru: {{pickupPoint}}',
      'Numer przesyłki: {{trackingNumber}}',
      'Śledzenie: {{trackingUrl}}',
      '',
      'Nieodebrana przesyłka wróci do nas — wtedy trzeba będzie nadać ją ponownie.',
      '',
      'Pozdrawiamy,',
      '{{shopName}}',
    ].join('\n'),
  },
  {
    key: 'shipment-delivered',
    name: 'Przesyłka doręczona',
    description: 'Etap DELIVERED — paczka odebrana przez klienta.',
    scope: 'ORDER',
    subject: 'Paczka dotarła — dziękujemy za zamówienie {{orderReference}}',
    bodyText: [
      'Dzień dobry,',
      '',
      'paczka z zamówienia {{orderReference}} została odebrana. Dziękujemy za zakupy!',
      '',
      'Gdyby coś było nie tak z zawartością, odpisz na tę wiadomość — sprawdzimy.',
      '',
      'Pozdrawiamy,',
      '{{shopName}}',
    ].join('\n'),
  },
  {
    key: 'shipment-problem',
    name: 'Problem z doręczeniem',
    description:
      'Etap PROBLEM — nieudane doręczenie, awizo albo minięty czas odbioru. UWAGA: treść obiecuje reakcję sklepu.',
    scope: 'ORDER',
    subject: 'Problem z doręczeniem paczki — zamówienie {{orderReference}}',
    bodyText: [
      'Dzień dobry,',
      '',
      'przewoźnik zgłosił problem z doręczeniem paczki z zamówienia {{orderReference}}.',
      '',
      'Status przesyłki: {{shipmentStage}}',
      'Numer przesyłki: {{trackingNumber}}',
      'Szczegóły: {{trackingUrl}}',
      '',
      'Sprawdzimy, co się wydarzyło. Jeśli chcesz coś dopowiedzieć — na przykład',
      'podać inny adres albo punkt odbioru — odpisz na tę wiadomość.',
      '',
      'Pozdrawiamy,',
      '{{shopName}}',
    ].join('\n'),
  },
  {
    key: 'personalization-link',
    name: 'Link do personalizacji',
    description: 'Sprawa utworzona — pierwszy mail z linkiem do formularza personalizacji.',
    scope: 'CASE',
    subject: 'Twój link do personalizacji — zamówienie {{orderReference}}',
    bodyText: [
      'Dzień dobry,',
      '',
      'dziękujemy za zamówienie {{orderReference}}. Produkt {{productName}} ({{quantity}} szt.)',
      'czeka na Twoje dane — wpisujesz je w formularzu:',
      '',
      '{{personalizationUrl}}',
      '',
      'Gdy zatwierdzisz formularz, przygotujemy podgląd projektu i wyślemy go',
      'do akceptacji.',
      '',
      'Pozdrawiamy,',
      '{{shopName}}',
    ].join('\n'),
  },
  {
    key: 'personalization-reminder',
    name: 'Przypomnienie o personalizacji',
    description: 'Sprawa czeka na klienta dłużej niż zakłada warunek reguły — przypomnienie o formularzu.',
    scope: 'CASE',
    subject: 'Czekamy na Twoją personalizację — zamówienie {{orderReference}}',
    bodyText: [
      'Dzień dobry,',
      '',
      'formularz personalizacji do zamówienia {{orderReference}} nie został jeszcze',
      'wypełniony. Bez niego nie ruszymy z drukiem.',
      '',
      '{{personalizationUrl}}',
      '',
      'Jeśli coś jest niejasne albo potrzebujesz pomocy przy projekcie — odpisz',
      'na tę wiadomość.',
      '',
      'Pozdrawiamy,',
      '{{shopName}}',
    ].join('\n'),
  },
]

async function main() {
  const tenant = await prisma.tenant.findFirst({
    where: { slug: TENANT_SLUG },
    select: { id: true, name: true },
  })
  if (!tenant) throw new Error(`Brak tenanta "${TENANT_SLUG}"`)

  console.log(`Tenant: ${tenant.name} (${tenant.id})`)
  console.log(DRY_RUN ? 'DRY RUN — nic nie zapisuję\n' : '')

  for (const template of TEMPLATES) {
    const existing = await prisma.emailTemplate.findFirst({
      where: { tenantId: tenant.id, key: template.key },
      select: { id: true },
    })

    if (DRY_RUN) {
      console.log(`${existing ? 'nadpisze' : 'utworzy'}: ${template.key} — ${template.subject}`)
      continue
    }

    if (existing) {
      await prisma.emailTemplate.update({
        where: { id: existing.id },
        data: {
          name: template.name,
          description: template.description,
          subject: template.subject,
          bodyText: template.bodyText,
          scope: template.scope,
        },
      })
      console.log(`zaktualizowano: ${template.key}`)
    } else {
      await prisma.emailTemplate.create({
        data: {
          tenantId: tenant.id,
          key: template.key,
          name: template.name,
          description: template.description,
          subject: template.subject,
          bodyText: template.bodyText,
          scope: template.scope,
          shopId: null,
          isActive: true,
        },
      })
      console.log(`utworzono: ${template.key}`)
    }
  }

  const total = await prisma.emailTemplate.count({ where: { tenantId: tenant.id } })
  console.log(`\nSzablonów w bibliotece: ${total}`)
}

main()
  .catch((error) => {
    console.error('Nie udało się założyć szablonów:', error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
