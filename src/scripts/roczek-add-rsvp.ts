/**
 * Dokłada do szablonu ROCZEK wiersz z prośbą o potwierdzenie przybycia.
 *
 * Skrypt DOSZYWA warstwę do istniejącego layoutu zamiast budować go od nowa -
 * szablon był po utworzeniu poprawiany ręcznie w edytorze (przesunięte ramki,
 * zmienione treści) i `create-roczek-template.ts` skasowałby te zmiany.
 * Każda kolejna poprawka istniejącego szablonu powinna iść tą samą drogą.
 *
 * Idempotentny: warstwa i pole są aktualizowane, a nie dublowane.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera); lokalnie: pnpm tsx src/scripts/roczek-add-rsvp.ts
 */
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const TEMPLATE_CODE = 'ROCZEK'
const PAGE_ID = 'page-3'
const LAYER_ID = 'rsvp_text'
const FIELD_KEY = 'rsvp_text'

const DPI = 300
const INK = '#3d3630'

const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Ostatnia warstwa strony konczy sie na 122 mm, a strona ma 140 - wiersz
// wchodzi w pas przy dolnej krawedzi, tuz nad strefa bezpieczna (5 mm).
const LEFT_MM = 12.2
const WIDTH_MM = 117.6
const TOP_MM = 123.5
const HEIGHT_MM = 11

const DEFAULT_TEXT = 'Prosimy o potwierdzenie przybycia\ndo 1 czerwca — tel. 600 100 200'

function rsvpLayer(zIndex: number) {
  return {
    id: LAYER_ID,
    name: 'Potwierdzenie przybycia',
    type: 'textbox' as const,
    visible: true,
    locked: false,
    opacity: 1,
    zIndex,
    x: mm(LEFT_MM + WIDTH_MM / 2),
    y: mm(TOP_MM + HEIGHT_MM / 2),
    width: mm(WIDTH_MM),
    height: mm(HEIGHT_MM),
    rotation: 0,
    properties: {
      type: 'textbox' as const,
      fieldKey: FIELD_KEY,
      text: DEFAULT_TEXT,
      fontSize: 7.5,
      fontUnit: 'pt' as const,
      fontFamily: 'Cormorant Infant',
      fontWeight: 400,
      fontStyle: 'normal' as const,
      fill: INK,
      textAlign: 'center' as const,
      verticalAlign: 'middle' as const,
      lineHeight: 1.6,
      letterSpacing: 120,
      padding: 0,
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      borderWidth: 0,
      editable: true,
      clientDraggable: false,
      clientResizable: false,
      clientRotatable: false,
    },
  }
}

async function main() {
  const template = await prisma.personalizationTemplate.findFirst({
    where: { code: TEMPLATE_CODE },
    include: { forms: { include: { fields: true }, orderBy: { sortOrder: 'asc' } } },
  })
  if (!template) throw new Error(`Brak szablonu ${TEMPLATE_CODE}`)

  const form = template.forms[0]
  if (!form) throw new Error(`Szablon ${TEMPLATE_CODE} nie ma formularza`)

  const existingField = form.fields.find((field) => field.key === FIELD_KEY)
  const maxSortOrder = form.fields.reduce((max, field) => Math.max(max, field.sortOrder), 0)

  const fieldData = {
    label: 'Potwierdzenie przybycia',
    type: 'textarea',
    scope: 'SHARED' as const,
    // Nieobowiazkowe: nie kazde przyjecie prosi o potwierdzenie, a puste pole
    // ma po prostu zostawic ten pas karty pusty.
    required: false,
    placeholder: 'np. Prosimy o potwierdzenie przybycia do 1 czerwca',
    helpText: 'Dwa wiersze. Puste pole zostawia dolny pas karty pusty.',
    defaultValue: DEFAULT_TEXT,
    maxLength: 120,
  }

  if (existingField) {
    await prisma.formField.update({ where: { id: existingField.id }, data: fieldData })
  } else {
    await prisma.formField.create({
      data: { formId: form.id, key: FIELD_KEY, sortOrder: maxSortOrder + 1, ...fieldData },
    })
  }

  const layout = template.layoutJson as any
  const page = layout?.pages?.find((candidate: any) => candidate.id === PAGE_ID)
  if (!page) throw new Error(`Layout nie ma strony ${PAGE_ID}`)

  const nextZIndex = page.layers.reduce((max: number, layer: any) => Math.max(max, layer.zIndex ?? 0), 0) + 1
  const index = page.layers.findIndex((layer: any) => layer.id === LAYER_ID)

  if (index >= 0) {
    // Zachowujemy zIndex i geometrie z edytora - grafik mogl juz przesunac
    // wiersz, a skrypt ma tylko odswiezyc typografie i tresc.
    const current = page.layers[index]
    page.layers[index] = {
      ...rsvpLayer(current.zIndex ?? nextZIndex),
      x: current.x,
      y: current.y,
      width: current.width,
      height: current.height,
    }
  } else {
    page.layers.push(rsvpLayer(nextZIndex))
  }

  await prisma.personalizationTemplate.update({
    where: { id: template.id },
    data: { layoutJson: layout },
  })

  console.log(
    JSON.stringify(
      {
        templateId: template.id,
        akcja: index >= 0 ? 'zaktualizowano warstwę' : 'dodano warstwę',
        pole: FIELD_KEY,
        warstwyStrony3: page.layers.map((layer: any) => layer.name),
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
