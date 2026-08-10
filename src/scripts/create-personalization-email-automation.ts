/**
 * Automatyzacja: mail z linkiem do edytora zaraz po zalozeniu sprawy.
 *
 * Dlaczego automatyzacja, a nie flaga AUTO_SEND_EMAILS: obie sciezki
 * wychodza z tego samego miejsca (`CASE_CREATED`), wiec wlaczone naraz
 * wyslalyby klientowi DWA maile - jeden z szablonu zaszytego w kodzie,
 * drugi z tej reguly. Automatyzacja wygrywa, bo jej tresc redagujesz
 * w panelu (Automatyzacje) bez zmiany kodu i deployu.
 *
 * `SEND_EMAIL` wysyla niezaleznie od AUTO_SEND_EMAILS - flaga steruje
 * wylacznie szablonem wbudowanym.
 *
 * Tresc jest ZWYKLYM TEKSTEM: `sendAutomationEmail` robi z niej HTML,
 * zamieniajac znaki nowej linii na `<br>`. Zmienne: {{customerName}},
 * {{orderReference}}, {{productName}}, {{quantity}}, {{shopName}},
 * {{personalizationUrl}}.
 *
 * Idempotentny - rozpoznaje regule po nazwie i nadpisuje jej tresc.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/create-personalization-email-automation.js
 *   DRY_RUN=1 - pokaz tresc, nie zapisuj
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TENANT_SLUG = process.env.TENANT_SLUG || 'kreatywne-papierki'
const NAME = 'Link do edytora po złożeniu zamówienia'

const SUBJECT = 'Zaproszenie czeka na Twoją treść — zamówienie {{orderReference}}'

// Bez zwrotu po imieniu: puste `customerName` zostawiloby "Dzień dobry ,".
const BODY = `Dzień dobry,

dziękujemy za zamówienie {{orderReference}} w sklepie {{shopName}}.

Treść zaproszenia ustalasz sam w edytorze — wpisujesz imiona gości, datę i godzinę przyjęcia, miejsce oraz pozostałe napisy, a podgląd od razu pokazuje gotową kartę:

{{personalizationUrl}}

Drukujemy dopiero po Twojej akceptacji, więc spokojnie sprawdź wszystko przed zatwierdzeniem. Link jest przypisany do Twojego zamówienia — prosimy nie udostępniać go dalej.

Zamówiony produkt: {{productName}} — {{quantity}} szt.

W razie pytań wystarczy odpowiedzieć na tę wiadomość.

Pozdrawiamy,
{{shopName}}`

async function main() {
  const tenant = await prisma.tenant.findFirst({ where: { slug: TENANT_SLUG }, select: { id: true } })
  if (!tenant) throw new Error(`Brak tenanta "${TENANT_SLUG}"`)

  const data = {
    name: NAME,
    description: 'Wysyła klientowi link do personalizacji zaraz po założeniu sprawy.',
    trigger: 'CASE_CREATED',
    conditions: {},
    actions: [
      {
        type: 'SEND_EMAIL',
        config: {
          to: 'customer',
          subject: SUBJECT,
          body: BODY,
        },
      },
    ],
    isActive: true,
    priority: 0,
  }

  if (process.env.DRY_RUN === '1') {
    console.log(JSON.stringify({ dryRun: true, tenant: TENANT_SLUG, ...data }, null, 2))
    return
  }

  const existing = await prisma.automation.findFirst({ where: { tenantId: tenant.id, name: NAME } })
  const automation = existing
    ? await prisma.automation.update({ where: { id: existing.id }, data })
    : await prisma.automation.create({ data: { tenantId: tenant.id, ...data } })

  console.log(
    JSON.stringify(
      {
        id: automation.id,
        nazwa: automation.name,
        wyzwalacz: automation.trigger,
        aktywna: automation.isActive,
        utworzona: !existing,
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
