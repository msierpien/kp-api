/**
 * Upraszcza formularz szablonu ZAPROSZENIE_12X17: napisy, ktorych klient
 * i tak nie zmienia, znikaja z formularza i zostaja na karcie jako TEKST
 * STALY, a prosba o potwierdzenie dostaje wzor do uzupelnienia.
 *
 * Ktore napisy: zwrot wprowadzajacy („SERDECZNIE ZAPRASZAM"), okazja
 * („NA PRZYJECIE Z OKAZJI MOICH") i podpis pod godzina („godzina"). Warstwy
 * zostaja w ukladzie - tracą tylko `fieldKey`, a ich biezaca tresc jest
 * wpisywana na stale. Zmiana idzie po WSZYSTKICH wariantach ukladu.
 *
 * Pozostale pola TRACA `defaultValue` na rzecz `placeholder`: przykladowa
 * tresc ma zyc w SZABLONIE (tekst warstwy - to on idzie na podglad w edytorze
 * i na zdjecia produktu), a nie w odpowiedziach zamowienia. Inaczej klient,
 * ktory pola nie poprawil, wydrukowalby cudze imie albo przykladowa date.
 *
 * Skrypt DOSZYWA zmiane do istniejacego layoutu (czyta go z bazy), wiec nie
 * kasuje poprawek naniesionych recznie w edytorze.
 *
 * Idempotentny - po pierwszym uruchomieniu kolejne nic nie zmieniaja.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/zaproszenie-12x17-simplify-form.js
 *   DRY_RUN=1 - tylko raport, bez zapisu
 */
import { PrismaClient } from '@prisma/client'
import { getTemplateVariants, type TemplateLayoutJson, type TemplatePage } from '@msierpien/kp-template-core'

const prisma = new PrismaClient()

const TEMPLATE_CODE = 'ZAPROSZENIE_12X17'

/** Pola do usuniecia z formularza - ich tresc zostaje na karcie na stale. */
const FROZEN_FIELDS = ['intro_text', 'occasion_text', 'time_label']

const RSVP_KEY = 'rsvp_text'
const RSVP_PLACEHOLDER = 'Prosimy o potwierdzenie przybycia do dnia 05.08.2028\nMama: 500-500-500'

/**
 * Tresc startowa pola - FORMULKA z miejscami do uzupelnienia, nie przyklad.
 *
 * Klient dostaje gotowy szkielet zdania i podmienia same iksy. Przykladowa
 * data i numer telefonu wygladalyby na prawdziwe i wydrukowalyby sie
 * u kogos, kto pola nie poprawil; "xx.xx.xxxx" widac na pierwszy rzut oka.
 */
const RSVP_DEFAULT = 'Prosimy o potwierdzenie przybycia do dnia xx.xx.xxxx\nMama: xxx-xxx-xxx'

/**
 * Pola, przy ktorych podpowiedz nie ma sensu: przy liscie wyboru i kalendarzu
 * `placeholder` sie nie pokazuje, wiec zostaje samo wyczyszczenie wartosci.
 */
const NO_PLACEHOLDER_TYPES = ['select', 'date', 'checkbox', 'radio']

/**
 * Zamraza warstwy: zdejmuje `fieldKey` i wpisuje tresc na stale.
 *
 * Tresc bierzemy z odpowiedniego pola formularza (jego `defaultValue`), a nie
 * z warstwy - w warstwie moze siedziec tekst z czasu budowania szablonu.
 */
function freezeLayers(pages: TemplatePage[], texts: Record<string, string>) {
  let frozen = 0

  const next = pages.map((page) => ({
    ...page,
    layers: page.layers.map((layer: any) => {
      const key = layer.properties?.fieldKey
      if (!key || !FROZEN_FIELDS.includes(key)) return layer

      frozen += 1
      const { fieldKey, ...rest } = layer.properties
      return {
        ...layer,
        properties: { ...rest, text: texts[key] ?? layer.properties.text, editable: false },
      }
    }),
  })) as TemplatePage[]

  return { pages: next, frozen }
}

async function main() {
  const template = await prisma.personalizationTemplate.findFirst({
    where: { code: TEMPLATE_CODE },
    include: { forms: { include: { fields: true }, orderBy: { sortOrder: 'asc' } } },
  })
  if (!template) throw new Error(`Brak szablonu ${TEMPLATE_CODE}`)

  const form = template.forms[0]
  if (!form) throw new Error('Szablon nie ma formularza')

  const texts = Object.fromEntries(form.fields.map((field) => [field.key, field.defaultValue ?? '']))
  const layout = template.layoutJson as unknown as TemplateLayoutJson

  const variants = getTemplateVariants(layout)
  let frozenTotal = 0

  const nextVariants = variants.map((variant) => {
    const result = freezeLayers(variant.pages, texts)
    frozenTotal += result.frozen
    return { ...variant, pages: result.pages }
  })

  // Lustro (`pages`/`layers`) idzie z pierwszego wariantu - tak trzyma je
  // `withTemplateVariants`, wiec nie przeliczamy go osobno.
  const first = nextVariants[0]
  const nextLayout: any = {
    ...layout,
    pages: first.pages,
    canvas: first.pages[0]?.canvas ?? layout.canvas,
    layers: first.pages[0]?.layers ?? layout.layers,
    ...(layout.variants ? { variants: nextVariants } : {}),
  }

  const toRemove = form.fields.filter((field) => FROZEN_FIELDS.includes(field.key))
  const rsvp = form.fields.find((field) => field.key === RSVP_KEY)

  if (process.env.DRY_RUN === '1') {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          zamrozoneWarstwy: frozenTotal,
          usunietePola: toRemove.map((field) => `${field.key} („${field.defaultValue}”)`),
          warianty: nextVariants.length,
        },
        null,
        2
      )
    )
    return
  }

  if (toRemove.length > 0) {
    await prisma.formField.deleteMany({ where: { id: { in: toRemove.map((field) => field.id) } } })
  }

  // Przykladowe tresci z pol -> podpowiedzi. Wartosc startowa w formularzu
  // trafialaby do odpowiedzi zamowienia, a tam maja byc wylacznie dane klienta.
  const withDefaults = form.fields.filter(
    (field) => !FROZEN_FIELDS.includes(field.key) && field.key !== RSVP_KEY && field.defaultValue
  )
  for (const field of withDefaults) {
    await prisma.formField.update({
      where: { id: field.id },
      data: {
        defaultValue: null,
        placeholder: NO_PLACEHOLDER_TYPES.includes(field.type)
          ? field.placeholder
          : field.placeholder || `np. ${field.defaultValue!.replace(/\n/g, ' ')}`,
      },
    })
  }

  if (rsvp) {
    await prisma.formField.update({
      where: { id: rsvp.id },
      data: {
        defaultValue: RSVP_DEFAULT,
        placeholder: RSVP_PLACEHOLDER,
        helpText: 'Dwa wiersze: termin potwierdzenia i telefon. Puste pole zostawia ten pas karty pusty.',
      },
    })
  }

  await prisma.personalizationTemplate.update({
    where: { id: template.id },
    data: { layoutJson: nextLayout },
  })

  const left = await prisma.formField.findMany({
    where: { formId: form.id },
    orderBy: { sortOrder: 'asc' },
    select: { key: true, label: true, type: true, scope: true },
  })

  console.log(
    JSON.stringify(
      {
        templateId: template.id,
        zamrozoneWarstwy: frozenTotal,
        usunietePola: toRemove.map((field) => field.key),
        trescNaPodpowiedz: withDefaults.map((field) => field.key),
        formulkaStartowa: rsvp ? RSVP_DEFAULT.replace(/\n/g, ' / ') : null,
        poleFormularza: left.map((field) => `${field.key} (${field.type}, ${field.scope})`),
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
