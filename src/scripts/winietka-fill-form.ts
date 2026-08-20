/**
 * Buduje formularz szablonu WINIETKA - do tej pory nie mial ANI JEDNEGO pola,
 * a uklad odwolywal sie do trzech kluczy, ktorych nie bylo gdzie wypelnic:
 *
 *   - warstwa `layer_1784917577245` z `properties.fieldKey = "data"` (audyt
 *     zglaszal ja jako OSIEROCONY fieldKey - patrz audit-template-form-defaults),
 *   - warstwa z tekstem `{{ imie }} {{ nazwisko }}`. Ta boli bardziej, bo
 *     renderer podmienia `{{ klucz }}` tylko przy istniejacej odpowiedzi,
 *     a bez niej ZOSTAWIA DOSLOWNY NAPIS (fabric-renderer.service, gałąź
 *     textbox) - na winietke poszloby literalne "{{ imie }} {{ nazwisko }}".
 *
 * Winietka stoi na stole przy nakryciu goscia, wiec imie i nazwisko sa w
 * zakresie INDIVIDUAL: panel poprosi o osobny wpis dla kazdej zamowionej
 * sztuki (lista gosci). Data slubu jest jedna dla calego zamowienia - SHARED.
 *
 * Zadne pole nie dostaje `default_value`: tresc startowa z prawdziwymi faktami
 * otwiera formularz WYGLADAJACY NA WYPELNIONY i drukuje sie u kogos, kto jej
 * nie poprawil. Przyklad zyje w `placeholder` i w tekscie warstwy - to on idzie
 * na podglad w edytorze i na zdjecia produktu.
 *
 * Przy okazji: `layout.layers` (lustro pierwszej strony dla starych konsumentow)
 * rozjechalo sie z `pages[0].layers` - brakowalo w nim wlasnie warstwy `data`.
 * Skrypt przepisuje lustro przez `withTemplatePages`, tak jak robi to edytor.
 *
 * Skrypt DOSZYWA zmiane do istniejacego layoutu (czyta go z bazy), wiec nie
 * kasuje poprawek naniesionych recznie w edytorze. Idempotentny - po pierwszym
 * uruchomieniu kolejne nic nie zmieniaja.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/winietka-fill-form.js
 *   DRY_RUN=1 - tylko raport, bez zapisu
 *
 * Na produkcji: kompilacja lokalna i `docker cp` do /app/dist/scripts
 * (w kontenerze nie ma tsx) - patrz docs/dodawanie-szablonow.md, sekcja 5.
 */
import { Prisma, PrismaClient } from '@prisma/client'
import {
  getTemplatePages,
  withTemplatePages,
  type TemplateLayoutJson,
  type TemplatePage,
} from '@msierpien/kp-template-core'

const prisma = new PrismaClient()

const TEMPLATE_CODE = 'WINIETKA'

/** Formularz szablonu nazywal sie "Nowy formularz" - zostal tak z edytora. */
const FORM_NAME = 'Lista gości'

/** Warstwa z osieroconym `fieldKey` - ta, ktora zglasza audyt. */
const DATE_LAYER_ID = 'layer_1784917577245'

/**
 * Przykladowa data w warstwie. Tekst warstwy idzie na podglad w edytorze
 * i na zdjecia produktu, a na wydruk trafia tylko wtedy, gdy klient pola nie
 * wypelnil - czemu zapobiega `required` (render.worker konczy taki PDF
 * statusem FAILED_RENDER, patrz validateAnswers).
 */
const DATE_LAYER_SAMPLE = '15.06.2027'

type FieldInput = {
  key: string
  label: string
  type: string
  scope: 'SHARED' | 'INDIVIDUAL'
  required: boolean
  sortOrder: number
  placeholder?: string
  helpText?: string
  maxLength?: number
}

const FIELDS: FieldInput[] = [
  {
    key: 'imie',
    label: 'Imię gościa',
    type: 'text',
    // Winietka lezy przy nakryciu, wiec tresc jest inna na kazdej sztuce:
    // panel wystawi tyle wpisow, ile winietek jest w zamowieniu.
    scope: 'INDIVIDUAL',
    required: true,
    sortOrder: 1,
    placeholder: 'np. Anna',
    helpText: 'Osobny wpis dla każdej zamówionej winietki.',
    maxLength: 30,
  },
  {
    key: 'nazwisko',
    label: 'Nazwisko gościa',
    type: 'text',
    scope: 'INDIVIDUAL',
    required: true,
    sortOrder: 2,
    placeholder: 'np. Kowalska',
    maxLength: 30,
  },
  {
    key: 'data',
    label: 'Data ślubu',
    type: 'text',
    // Jedna dla calego zamowienia - w odroznieniu od imienia goscia.
    scope: 'SHARED',
    required: true,
    sortOrder: 3,
    // Typ `text`, nie `date`: renderer nie formatuje dat, wiec wartosc
    // z kalendarza poszlaby na druk w zapisie ISO. Klient wpisuje date
    // dokladnie w tej postaci, w jakiej ma ja zobaczyc na winietce.
    placeholder: 'np. 15.06.2027',
    helpText: 'Zapis dowolny - na winietce wydrukuje się dokładnie tak, jak tutaj.',
    maxLength: 20,
  },
]

/**
 * Uzupelnia warstwe daty: przykladowa tresc do podgladu i `editable` zgodne
 * z reszta szablonow (warstwa z `fieldKey` jest edytowalna). Tekstu wpisanego
 * recznie w edytorze NIE nadpisuje.
 */
function fillDateLayer(pages: TemplatePage[]) {
  let touched = 0

  const next = pages.map((page) => ({
    ...page,
    layers: page.layers.map((layer: any) => {
      if (layer.id !== DATE_LAYER_ID) return layer

      const text = String(layer.properties?.text ?? '')
      if (text.trim() && layer.properties?.editable === true) return layer

      touched += 1
      return {
        ...layer,
        properties: {
          ...layer.properties,
          text: text.trim() ? text : DATE_LAYER_SAMPLE,
          editable: true,
        },
      }
    }),
  })) as TemplatePage[]

  return { pages: next, touched }
}

async function main() {
  const template = await prisma.personalizationTemplate.findFirst({
    where: { code: TEMPLATE_CODE },
    include: { forms: { include: { fields: true }, orderBy: { sortOrder: 'asc' } } },
  })
  if (!template) throw new Error(`Brak szablonu ${TEMPLATE_CODE}`)

  const layout = template.layoutJson as unknown as TemplateLayoutJson
  const { pages, touched } = fillDateLayer(getTemplatePages(layout))
  const nextLayout = withTemplatePages(layout, pages)

  const form = template.forms[0]
  const existingByKey = new Map((form?.fields ?? []).map((field) => [field.key, field]))

  const plan = FIELDS.map((field) => ({
    key: field.key,
    scope: field.scope,
    action: existingByKey.has(field.key) ? 'aktualizacja' : 'nowe pole',
  }))

  if (process.env.DRY_RUN === '1') {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          szablon: `${template.code} (${template.id})`,
          formularz: form ? `${form.name} (${form.id})` : 'BRAK - zostanie zalozony',
          pola: plan,
          warstwaDaty: touched > 0 ? 'uzupelniona' : 'bez zmian',
          lustroLayers: {
            przed: (layout as any).layers?.length ?? 0,
            po: (nextLayout as any).layers?.length ?? 0,
          },
        },
        null,
        2
      )
    )
    return
  }

  const targetForm =
    form ??
    (await prisma.form.create({
      data: { templateId: template.id, name: FORM_NAME, sortOrder: 0, isActive: true },
    }))

  if (targetForm.name === 'Nowy formularz') {
    await prisma.form.update({ where: { id: targetForm.id }, data: { name: FORM_NAME } })
  }

  for (const field of FIELDS) {
    const data = {
      label: field.label,
      type: field.type,
      scope: field.scope,
      required: field.required,
      sortOrder: field.sortOrder,
      placeholder: field.placeholder ?? null,
      helpText: field.helpText ?? null,
      // Bez tresci startowej - przyklad zyje w podpowiedzi i w warstwie.
      defaultValue: null,
      maxLength: field.maxLength ?? null,
      minLength: null,
      pattern: null,
      optionsJson: Prisma.JsonNull,
      repeaterGroupKey: null,
      validationRulesJson: Prisma.JsonNull,
    }

    const existing = existingByKey.get(field.key)
    if (existing) {
      await prisma.formField.update({ where: { id: existing.id }, data })
    } else {
      await prisma.formField.create({ data: { formId: targetForm.id, key: field.key, ...data } })
    }
  }

  await prisma.personalizationTemplate.update({
    where: { id: template.id },
    data: { layoutJson: nextLayout as any },
  })

  const saved = await prisma.formField.findMany({
    where: { formId: targetForm.id },
    orderBy: { sortOrder: 'asc' },
    select: { key: true, label: true, type: true, scope: true, required: true, placeholder: true },
  })

  console.log(
    JSON.stringify(
      {
        szablon: `${template.code} (${template.id})`,
        formularz: targetForm.id,
        pola: saved,
        warstwaDaty: touched > 0 ? 'uzupelniona' : 'bez zmian',
        lustroLayers: (nextLayout as any).layers?.length ?? 0,
        strony: pages.length,
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
  .finally(() => prisma.$disconnect())
