/**
 * Szablon zaproszenia na roczek "ROCZEK" - kwadratowa karta skladana
 * 140 x 140 mm, trzy zaprojektowane strony:
 *   1. Okladka - "mam juz Roczek" + ZAPROSZENIE
 *   2. Wnetrze lewe - "Ale szok, mam juz ROK!"
 *   3. Wnetrze prawe - naglowek "zaproszenie" i formularz z kropkowanymi
 *      liniami do wypelnienia recznie
 *
 * GRAFIKI NIE MA - miejsce na nia zostaje puste, dokladamy ja recznie
 * w edytorze.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera); lokalnie: pnpm tsx src/scripts/create-roczek-template.ts
 */
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'ROCZEK'
const TEMPLATE_NAME = 'Roczek'
const TEMPLATE_DESCRIPTION =
  'Zaproszenie na roczek - kwadratowa karta składana 140 x 140 mm, trzy strony: okładka, wnętrze lewe i formularz z liniami do wypełnienia.'

const DPI = 300
const PAGE_MM = 140

/** Ciemny braz - tak jak na wzorcu, nie czern. */
const INK = '#3d3630'
/** Cieplejszy, jasniejszy braz pod pismo odreczne. */
const INK_SCRIPT = '#a08b73'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Kroje z rejestru czcionek serwera (storage/fonts) - tylko te node-canvas
// zarejestruje przy druku.
const SCRIPT_FONT = 'Birthstone'
const SERIF_FONT = 'Cormorant Infant'

const FONTS = [
  { family: SCRIPT_FONT, src: 'fonts/Birthstone-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Light.ttf', weight: 300, style: 'normal' as const },
]

type FieldInput = {
  key: string
  label: string
  type: string
  scope: 'SHARED' | 'INDIVIDUAL'
  required: boolean
  sortOrder: number
  placeholder?: string
  helpText?: string
  defaultValue?: string
  maxLength?: number
}

/**
 * Formularz jest krotki celowo.
 *
 * Karta jest wypelniana RECZNIE (kropkowane linie), wiec per zamowienie nie ma
 * czego podstawiac. Edytowalne zostaja tylko trzy napisy pisane recznie - dzieki
 * nim ten sam uklad obsluzy "2 latka" czy "3 latka" bez ruszania warstw.
 */
const FIELDS: FieldInput[] = [
  {
    key: 'cover_script',
    label: 'Okładka - napis odręczny',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 1,
    defaultValue: 'mam już Roczek',
    maxLength: 30,
  },
  {
    key: 'inside_script',
    label: 'Wnętrze lewe - napis odręczny',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 2,
    defaultValue: 'Ale szok, mam już\nROK!',
    helpText: 'Dwa wiersze - drugi jest okrzykiem, dlatego stoi osobno.',
    maxLength: 60,
  },
  {
    key: 'occasion_line',
    label: 'Okazja (wiersz z urodzinami)',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 3,
    defaultValue: 'NA PRZYJĘCIE Z OKAZJI PIERWSZYCH URODZIN',
    helpText: 'Wersaliki - krój nie zamienia liter automatycznie.',
    maxLength: 60,
  },
]

type TextboxInput = {
  id: string
  name: string
  text: string
  fieldKey?: string
  leftMm: number
  topMm: number
  widthMm: number
  heightMm: number
  zIndex: number
  fontFamily: string
  fontSize: number
  fill?: string
  lineHeight?: number
  letterSpacing?: number
  textAlign: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'middle' | 'bottom'
}

/**
 * Ramka tekstowa.
 *
 * `x`/`y` w formacie to SRODEK ramki - taka kotwice ma edytor i renderer.
 * Uklad opisujemy krawedziami w mm (tak sie go projektuje), srodek liczymy tu.
 */
function textbox(input: TextboxInput) {
  return {
    id: input.id,
    name: input.name,
    type: 'textbox' as const,
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: input.zIndex,
    x: mm(input.leftMm + input.widthMm / 2),
    y: mm(input.topMm + input.heightMm / 2),
    width: mm(input.widthMm),
    height: mm(input.heightMm),
    rotation: 0,
    properties: {
      type: 'textbox' as const,
      text: input.text,
      ...(input.fieldKey ? { fieldKey: input.fieldKey } : {}),
      fontSize: input.fontSize,
      fontUnit: 'pt' as const,
      fontFamily: input.fontFamily,
      fontWeight: 400,
      fontStyle: 'normal' as const,
      fill: input.fill ?? INK,
      textAlign: input.textAlign,
      verticalAlign: input.verticalAlign ?? 'middle',
      lineHeight: input.lineHeight ?? 1.2,
      letterSpacing: input.letterSpacing ?? 0,
      padding: 0,
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      borderWidth: 0,
      editable: Boolean(input.fieldKey),
      clientDraggable: false,
      clientResizable: false,
      clientRotatable: false,
    },
  }
}

const defaults = Object.fromEntries(FIELDS.map((field) => [field.key, field.defaultValue ?? '']))

const canvasConfig = {
  width: mm(PAGE_MM),
  height: mm(PAGE_MM),
  unit: 'mm' as const,
  widthMm: PAGE_MM,
  heightMm: PAGE_MM,
  formatPreset: 'CUSTOM' as const,
  dpi: DPI,
  bleed: 0,
  safeArea: mm(5),
  bleedMm: 0,
  safeAreaMm: 5,
  backgroundColor: '#ffffff',
}

// ============================================
// Strona 1 - okladka
// ============================================
// Gorne dwie trzecie zostaja PUSTE - tam wchodzi grafika dokladana recznie.

function coverLayers() {
  return [
    textbox({
      id: 'cover_script',
      name: 'Napis odręczny',
      fieldKey: 'cover_script',
      text: defaults.cover_script,
      leftMm: 20,
      topMm: 106,
      widthMm: 100,
      heightMm: 16,
      zIndex: 0,
      fontFamily: SCRIPT_FONT,
      fontSize: 30,
      fill: INK_SCRIPT,
      lineHeight: 1,
      textAlign: 'center',
    }),
    textbox({
      id: 'cover_label',
      name: 'ZAPROSZENIE',
      text: 'ZAPROSZENIE',
      leftMm: 30,
      topMm: 122,
      widthMm: 80,
      heightMm: 7,
      zIndex: 1,
      fontFamily: SERIF_FONT,
      fontSize: 9,
      letterSpacing: 200,
      textAlign: 'center',
    }),
  ]
}

// ============================================
// Strona 2 - wnetrze lewe
// ============================================

function insideLeftLayers() {
  return [
    textbox({
      id: 'inside_script',
      name: 'Napis odręczny',
      fieldKey: 'inside_script',
      text: defaults.inside_script,
      leftMm: 15,
      topMm: 108,
      widthMm: 110,
      heightMm: 24,
      zIndex: 0,
      fontFamily: SCRIPT_FONT,
      fontSize: 26,
      fill: INK_SCRIPT,
      lineHeight: 1.25,
      textAlign: 'center',
    }),
  ]
}

// ============================================
// Strona 3 - wnetrze prawe (formularz)
// ============================================

/**
 * Kropkowana linia jako TEKST, nie grafika.
 *
 * Dzieki temu linia trzyma sie wiersza przy kazdej zmianie tresci i skladu,
 * a grafik moze ja skrocic zwyklym kasowaniem kropek - bez podmiany assetu.
 * Liczba kropek dobrana tak, zeby wiersz siegal prawej krawedzi bloku.
 */
const dots = (count: number) => '.'.repeat(count)

const FORM_LEFT_MM = 14
const FORM_WIDTH_MM = 112
const FORM_FIRST_LINE_MM = 36
const FORM_LINE_STEP_MM = 11

type FormLine = { id: string; name: string; text: string; align: 'left' | 'right'; fieldKey?: string }

const FORM_LINES: FormLine[] = [
  { id: 'form_intro', name: 'Niniejszym...', text: 'NINIEJSZYM MAMY ZASZCZYT ZAPROSIĆ', align: 'right' },
  { id: 'form_guest', name: 'Sz.P. + linia', text: `SZ.P. ${dots(97)}`, align: 'left' },
  {
    id: 'form_occasion',
    name: 'Okazja',
    text: defaults.occasion_line,
    align: 'right',
    fieldKey: 'occasion_line',
  },
  { id: 'form_occasion_line', name: 'Linia pod okazją', text: dots(107), align: 'left' },
  { id: 'form_when', name: 'Które odbędzie się', text: 'KTÓRE ODBĘDZIE SIĘ', align: 'right' },
  { id: 'form_date', name: 'W dniu / o godzinie', text: `W DNIU ${dots(36)} O GODZINIE ${dots(36)}`, align: 'left' },
  { id: 'form_place', name: 'W... + linia', text: `W ${dots(102)}`, align: 'left' },
  { id: 'form_rsvp', name: 'Prosimy o potwierdzenie', text: 'PROSIMY O POTWIERDZENIE PRZYBYCIA', align: 'right' },
  { id: 'form_rsvp_line', name: 'Linia pod potwierdzeniem', text: dots(107), align: 'left' },
]

function insideRightLayers() {
  const header = textbox({
    id: 'form_header',
    name: 'Nagłówek „zaproszenie”',
    text: 'zaproszenie',
    leftMm: 20,
    topMm: 12,
    widthMm: 100,
    heightMm: 16,
    zIndex: 0,
    fontFamily: SCRIPT_FONT,
    fontSize: 34,
    fill: INK_SCRIPT,
    lineHeight: 1,
    textAlign: 'center',
  })

  const lines = FORM_LINES.map((line, index) =>
    textbox({
      id: line.id,
      name: line.name,
      ...(line.fieldKey ? { fieldKey: line.fieldKey } : {}),
      text: line.text,
      leftMm: FORM_LEFT_MM,
      topMm: FORM_FIRST_LINE_MM + index * FORM_LINE_STEP_MM,
      widthMm: FORM_WIDTH_MM,
      heightMm: 7,
      zIndex: index + 1,
      fontFamily: SERIF_FONT,
      fontSize: 8,
      letterSpacing: 120,
      textAlign: line.align,
    })
  )

  return [header, ...lines]
}

export function buildLayout() {
  const pages = [
    { id: 'page-1', name: 'Okładka', canvas: canvasConfig, layers: coverLayers() },
    { id: 'page-2', name: 'Wnętrze lewe', canvas: canvasConfig, layers: insideLeftLayers() },
    { id: 'page-3', name: 'Wnętrze prawe', canvas: canvasConfig, layers: insideRightLayers() },
  ]

  return {
    version: 2 as const,
    // `canvas`/`layers` to lustro pierwszej strony - wymaga tego format.
    canvas: canvasConfig,
    fonts: FONTS,
    layers: pages[0].layers,
    pages,
    print: {
      sheet: { widthMm: PAGE_MM, heightMm: PAGE_MM },
      placements: pages.map((page) => ({ pageId: page.id, xMm: 0, yMm: 0, rotation: 0 as const })),
      // Kazda strona na wlasnym arkuszu: to trzy LICA skladanej karty, a nie
      // przod i tyl jednej kartki - impozycja pod zaginanie jest decyzja druku.
      mode: 'separate' as const,
    },
    palette: ['#3d3630', '#a08b73', '#c2a98f', '#8a9a7b', '#b5838d'],
  }
}

/**
 * Tenant docelowy - wskazywany JAWNIE po slugu, bo baza niesie tez tenanta
 * seedowego i testowe, a szablon wpiety do niewlasciwego nie pojawi sie
 * na liscie w panelu.
 */
async function resolveTenantId() {
  const slug = process.env.TENANT_SLUG || TENANT_SLUG
  const tenant = await prisma.tenant.findFirst({ where: { slug }, select: { id: true } })
  if (!tenant) throw new Error(`Brak tenanta o slugu "${slug}"`)
  return tenant.id
}

async function main() {
  const tenantId = await resolveTenantId()

  const found =
    (await prisma.personalizationTemplate.findFirst({ where: { tenantId, code: TEMPLATE_CODE } })) ??
    (await prisma.personalizationTemplate.findFirst({ where: { code: TEMPLATE_CODE } }))

  const template = found
    ? await prisma.personalizationTemplate.update({
        where: { id: found.id },
        data: {
          tenantId,
          name: TEMPLATE_NAME,
          description: TEMPLATE_DESCRIPTION,
          editorType: 'ADVANCED',
          isActive: true,
        },
      })
    : await prisma.personalizationTemplate.create({
        data: {
          tenantId,
          code: TEMPLATE_CODE,
          name: TEMPLATE_NAME,
          description: TEMPLATE_DESCRIPTION,
          editorType: 'ADVANCED',
          isActive: true,
        },
      })

  const form =
    (await prisma.form.findFirst({ where: { templateId: template.id }, orderBy: { sortOrder: 'asc' } })) ??
    (await prisma.form.create({
      data: { templateId: template.id, name: 'Zaproszenie na roczek', sortOrder: 0, isActive: true },
    }))

  const existingFields = await prisma.formField.findMany({ where: { formId: form.id } })
  const existingByKey = new Map(existingFields.map((field) => [field.key, field]))

  for (const field of FIELDS) {
    const data = {
      label: field.label,
      type: field.type,
      scope: field.scope,
      required: field.required,
      sortOrder: field.sortOrder,
      placeholder: field.placeholder ?? null,
      helpText: field.helpText ?? null,
      defaultValue: field.defaultValue ?? null,
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
      await prisma.formField.create({ data: { formId: form.id, key: field.key, ...data } })
    }
  }

  const wantedKeys = new Set(FIELDS.map((field) => field.key))
  const obsolete = existingFields.filter((field) => !wantedKeys.has(field.key))
  if (obsolete.length > 0) {
    await prisma.formField.deleteMany({ where: { id: { in: obsolete.map((field) => field.id) } } })
  }

  const layout = buildLayout()

  await prisma.personalizationTemplate.update({
    where: { id: template.id },
    data: { layoutJson: layout as any },
  })

  console.log(
    JSON.stringify(
      {
        templateId: template.id,
        code: template.code,
        name: template.name,
        pageMm: [PAGE_MM, PAGE_MM],
        fields: FIELDS.map((field) => `${field.key} (${field.scope})`),
        pages: layout.pages.map((page) => ({ name: page.name, layers: page.layers.length })),
      },
      null,
      2
    )
  )
}

// Guard, zeby `buildLayout` dalo sie zaimportowac (np. do sprawdzenia layoutu
// schematem Zod) bez odpalania zapisu do bazy.
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
