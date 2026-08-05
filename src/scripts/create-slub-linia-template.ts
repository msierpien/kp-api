/**
 * Szablon zaproszenia slubnego "SLUB_LINIA" - minimalistyczny uklad A6:
 * pionowa kreska po lewej, data ulozona w slupku pod nia, kaligrafowane imiona
 * pary i prawy blok tresci w wersalikach.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera):
 *   docker cp dist/scripts/... albo `node create-slub-linia-template.cjs`
 *   lokalnie: pnpm tsx src/scripts/create-slub-linia-template.ts
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'
import { createCanvas } from 'canvas'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'SLUB_LINIA'
const TEMPLATE_NAME = 'Ślub Linia'
const TEMPLATE_DESCRIPTION =
  'Minimalistyczne zaproszenie ślubne A6 - pionowa kreska, data w słupku, kaligrafowane imiona pary.'

const DPI = 300
const WIDTH_MM = 105
const HEIGHT_MM = 148

const INK = '#1a1a1a'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Kroje wybrane z rejestru czcionek na serwerze (storage/fonts) - tylko te
// node-canvas zarejestruje przy druku. Krój spoza rejestru wygladalby dobrze
// w podgladzie i cicho spadl na systemowy fallback na wydruku.
const SCRIPT_FONT = 'MonteCarlo'
const SERIF_FONT = 'Cormorant Infant'
const SANS_FONT = 'Montserrat'

const FONTS = [
  { family: SCRIPT_FONT, src: 'fonts/MonteCarlo-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Light.ttf', weight: 300, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Medium.ttf', weight: 500, style: 'normal' as const },
  { family: SANS_FONT, src: 'fonts/Montserrat.ttf', weight: 400, style: 'normal' as const },
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

const FIELDS: FieldInput[] = [
  {
    key: 'bride_name',
    label: 'Imię Panny Młodej',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 1,
    defaultValue: 'Marlena',
    maxLength: 20,
  },
  {
    key: 'groom_name',
    label: 'Imię Pana Młodego',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 2,
    defaultValue: 'Sebastian',
    maxLength: 20,
  },
  {
    key: 'date_stamp',
    label: 'Data w słupku',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 3,
    defaultValue: '28\n09\n26',
    helpText: 'Trzy wiersze: dzień, miesiąc, dwie ostatnie cyfry roku.',
    maxLength: 12,
  },
  {
    key: 'invitation_intro',
    label: 'Zwrot wprowadzający',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 4,
    defaultValue: 'SERDECZNIE ZAPRASZAMY',
    helpText: 'Wersaliki - krój nie zamienia liter automatycznie.',
    maxLength: 30,
  },
  {
    key: 'guest_names',
    label: 'Zapraszani goście',
    type: 'text',
    // Jedyne pole per sztuka: na kazdym zaproszeniu stoi inny gosc, reszta
    // tresci jest wspolna dla calego zamowienia.
    scope: 'INDIVIDUAL',
    required: true,
    sortOrder: 5,
    placeholder: 'np. EWELINĘ I KAROLA OPOLSKICH',
    helpText: 'Wersaliki. Osobna treść dla każdego zaproszenia w zamówieniu.',
    maxLength: 60,
  },
  {
    key: 'ceremony_intro',
    label: 'Formuła uroczystości',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 6,
    defaultValue: 'NA UROCZYSTOŚĆ ZAŚLUBIN,\nKTÓRA ODBĘDZIE SIĘ',
    maxLength: 80,
  },
  {
    key: 'ceremony_datetime',
    label: 'Data i godzina ślubu',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 7,
    defaultValue: '28 WRZEŚNIA 2026 ROKU O GODZ. 16:00',
    maxLength: 60,
  },
  {
    key: 'ceremony_place',
    label: 'Miejsce ślubu',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 8,
    defaultValue: 'w Katedrze Chrystusa Króla w Krakowie',
    maxLength: 60,
  },
  {
    key: 'reception_text',
    label: 'Zaproszenie na przyjęcie',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 9,
    defaultValue:
      'PO ŚLUBIE SERDECZNIE ZAPRASZAMY DO WSPÓLNEJ ZABAWY NA PRZYJĘCIU WESELNYM, KTÓRE ODBĘDZIE SIĘ W RESTAURACJI GRESTO KINS PRZY ULICY PARKOWEJ 12 W KRAKOWIE',
    maxLength: 260,
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
  fontWeight?: number
  lineHeight?: number
  letterSpacing?: number
  textAlign: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'middle' | 'bottom'
}

/**
 * Ramka tekstowa.
 *
 * `x`/`y` w formacie to SRODEK ramki - taka kotwice ma edytor i renderer.
 * Uklad opisujemy krawedziami w mm (tak sie go projektuje), srodek liczymy tu,
 * zeby nigdzie indziej nie trzeba bylo tego przeliczac w pamieci.
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
      fontWeight: input.fontWeight ?? 400,
      fontStyle: 'normal' as const,
      fill: INK,
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

const LINE_LEFT_MM = 20
const LINE_TOP_MM = 10
const LINE_HEIGHT_MM = 64
const LINE_WIDTH_PX = 5

/**
 * Pionowa kreska jako grafika, nie warstwa `shape`.
 *
 * Renderer druku (fabric-renderer.service) obsluguje tylko tlo, obrazy i
 * teksty - `shape` widac w edytorze, a na wydruku znika bez slowa.
 */
function lineLayer(imageUrl: string) {
  return {
    id: 'rule_vertical',
    name: 'Pionowa kreska',
    type: 'image' as const,
    visible: true,
    locked: true,
    opacity: 1,
    zIndex: 0,
    x: mm(LINE_LEFT_MM),
    y: mm(LINE_TOP_MM + LINE_HEIGHT_MM / 2),
    width: LINE_WIDTH_PX,
    height: mm(LINE_HEIGHT_MM),
    rotation: 0,
    properties: {
      type: 'image' as const,
      imageUrl,
      fit: 'fill' as const,
      lockAspectRatio: false,
      clientDraggable: false,
      clientResizable: false,
      clientRotatable: false,
    },
  }
}

const defaults = Object.fromEntries(FIELDS.map((field) => [field.key, field.defaultValue ?? '']))

function buildLayers(lineImageUrl: string) {
  return [
    lineLayer(lineImageUrl),

    textbox({
      id: 'date_stamp',
      name: 'Data w słupku',
      fieldKey: 'date_stamp',
      text: defaults.date_stamp,
      leftMm: 19.5,
      topMm: 79,
      widthMm: 20,
      heightMm: 26,
      zIndex: 1,
      fontFamily: SANS_FONT,
      fontSize: 18,
      letterSpacing: 30,
      lineHeight: 1.25,
      textAlign: 'left',
      verticalAlign: 'top',
    }),

    textbox({
      id: 'bride_name',
      name: 'Imię Panny Młodej',
      fieldKey: 'bride_name',
      text: defaults.bride_name,
      leftMm: 37,
      topMm: 48.5,
      widthMm: 54,
      heightMm: 15,
      zIndex: 2,
      fontFamily: SCRIPT_FONT,
      fontSize: 33,
      lineHeight: 1,
      textAlign: 'center',
    }),

    textbox({
      id: 'names_connector',
      name: 'Łącznik „oraz”',
      text: 'oraz',
      leftMm: 52,
      topMm: 63.5,
      widthMm: 30,
      heightMm: 5,
      zIndex: 3,
      fontFamily: SCRIPT_FONT,
      fontSize: 12,
      lineHeight: 1,
      textAlign: 'center',
    }),

    // Imie Pana Mlodego celowo przesuniete w prawo wzgledem Panny Mlodej -
    // to ta sama skosna os, co na wzorcu.
    textbox({
      id: 'groom_name',
      name: 'Imię Pana Młodego',
      fieldKey: 'groom_name',
      text: defaults.groom_name,
      leftMm: 43,
      topMm: 68,
      widthMm: 54,
      heightMm: 15,
      zIndex: 4,
      fontFamily: SCRIPT_FONT,
      fontSize: 33,
      lineHeight: 1,
      textAlign: 'center',
    }),

    textbox({
      id: 'invitation_intro',
      name: 'Zwrot wprowadzający',
      fieldKey: 'invitation_intro',
      text: defaults.invitation_intro,
      leftMm: 40,
      topMm: 84,
      widthMm: 56,
      heightMm: 6,
      zIndex: 5,
      fontFamily: SERIF_FONT,
      fontSize: 7,
      letterSpacing: 150,
      textAlign: 'right',
    }),

    textbox({
      id: 'guest_names',
      name: 'Zapraszani goście',
      fieldKey: 'guest_names',
      text: 'EWELINĘ I KAROLA OPOLSKICH',
      leftMm: 40,
      topMm: 89,
      widthMm: 56,
      // Dwa wiersze zapasu: dluzsze zwroty ("PAŃSTWA ANNĘ I KRZYSZTOFA
      // KOWALSKICH") nie zmieszcza sie w jednej linii tej kolumny.
      heightMm: 12,
      zIndex: 6,
      fontFamily: SERIF_FONT,
      fontSize: 9.5,
      fontWeight: 500,
      letterSpacing: 50,
      lineHeight: 1.4,
      textAlign: 'right',
    }),

    textbox({
      id: 'ceremony_intro',
      name: 'Formuła uroczystości',
      fieldKey: 'ceremony_intro',
      text: defaults.ceremony_intro,
      leftMm: 40,
      topMm: 100.5,
      widthMm: 56,
      heightMm: 9,
      zIndex: 7,
      fontFamily: SERIF_FONT,
      fontSize: 6.5,
      letterSpacing: 150,
      lineHeight: 1.6,
      textAlign: 'right',
    }),

    // Data i miejsce lamia rytm bloku wyrownanego do prawej - na wzorcu ta
    // para jest wysrodkowana wzgledem siebie.
    textbox({
      id: 'ceremony_datetime',
      name: 'Data i godzina ślubu',
      fieldKey: 'ceremony_datetime',
      text: defaults.ceremony_datetime,
      leftMm: 34,
      topMm: 110,
      widthMm: 62,
      heightMm: 8,
      zIndex: 8,
      fontFamily: SERIF_FONT,
      fontSize: 7,
      fontWeight: 500,
      letterSpacing: 25,
      lineHeight: 1.4,
      textAlign: 'center',
    }),

    textbox({
      id: 'ceremony_place',
      name: 'Miejsce ślubu',
      fieldKey: 'ceremony_place',
      text: defaults.ceremony_place,
      leftMm: 34,
      topMm: 116.5,
      widthMm: 62,
      heightMm: 7,
      zIndex: 9,
      fontFamily: SERIF_FONT,
      fontSize: 9,
      fontWeight: 500,
      lineHeight: 1.3,
      textAlign: 'center',
    }),

    textbox({
      id: 'reception_text',
      name: 'Zaproszenie na przyjęcie',
      fieldKey: 'reception_text',
      text: defaults.reception_text,
      leftMm: 32,
      topMm: 126,
      widthMm: 62,
      heightMm: 15,
      zIndex: 10,
      fontFamily: SERIF_FONT,
      fontSize: 6,
      letterSpacing: 100,
      lineHeight: 1.7,
      textAlign: 'center',
    }),
  ]
}

const canvasConfig = {
  width: mm(WIDTH_MM),
  height: mm(HEIGHT_MM),
  unit: 'mm' as const,
  widthMm: WIDTH_MM,
  heightMm: HEIGHT_MM,
  formatPreset: 'A6_105X148' as const,
  dpi: DPI,
  bleed: 0,
  safeArea: mm(5),
  bleedMm: 0,
  safeAreaMm: 5,
  backgroundColor: '#ffffff',
}

export function buildLayout(lineImageUrl: string) {
  const layers = buildLayers(lineImageUrl)

  return {
    version: 2 as const,
    // `canvas`/`layers` to lustro pierwszej strony - wymaga tego format
    // (withTemplatePages) i tego szuka kazdy starszy konsument.
    canvas: canvasConfig,
    fonts: FONTS,
    layers,
    pages: [{ id: 'page-1', name: 'Zaproszenie', canvas: canvasConfig, layers }],
    print: {
      sheet: { widthMm: WIDTH_MM, heightMm: HEIGHT_MM },
      placements: [{ pageId: 'page-1', xMm: 0, yMm: 0, rotation: 0 as const }],
      mode: 'sheet' as const,
    },
    palette: ['#1a1a1a', '#4f4f4f', '#8a7355', '#b08d57', '#2c3e50'],
  }
}

/** Kreska jako PNG w docelowym rozmiarze - bez przeskalowania, bez rozmycia. */
async function ensureLineAsset(templateId: string) {
  const existing = await prisma.templateAsset.findFirst({
    where: { templateId, assetType: 'DECORATION', fileName: { startsWith: 'linia_pionowa' } },
  })
  if (existing) return existing

  const height = mm(LINE_HEIGHT_MM)
  const canvas = createCanvas(LINE_WIDTH_PX, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, LINE_WIDTH_PX, height)
  const buffer = canvas.toBuffer('image/png')

  const fileName = `linia_pionowa_${Date.now()}.png`
  const dir = path.join(process.cwd(), 'storage', 'templates', TEMPLATE_CODE, 'decoration')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), buffer)

  return prisma.templateAsset.create({
    data: {
      templateId,
      assetType: 'DECORATION',
      fileName,
      filePath: path.join('templates', TEMPLATE_CODE, 'decoration', fileName),
      fileSize: buffer.length,
      mimeType: 'image/png',
      metadata: { width: LINE_WIDTH_PX, height, originalName: 'linia-pionowa.png' },
      sortOrder: 0,
    },
  })
}

/**
 * Tenant docelowy.
 *
 * `tenantId` normalnie dokłada middleware Prismy z kontekstu zadania - skrypt
 * takiego kontekstu nie ma. Wskazujemy tenanta JAWNIE po slugu, bo baza niesie
 * tez tenanta seedowego i testowe (`default-tenant-id`, `codex-smoke-*`), a
 * szablon wpiety do niewlasciwego nie pojawi sie na liscie w panelu.
 */
async function resolveTenantId() {
  const slug = process.env.TENANT_SLUG || TENANT_SLUG
  const tenant = await prisma.tenant.findFirst({ where: { slug }, select: { id: true, name: true } })
  if (!tenant) throw new Error(`Brak tenanta o slugu "${slug}"`)
  return tenant.id
}

async function main() {
  const tenantId = await resolveTenantId()

  // Szablon moze juz istniec pod innym tenantem (np. po uruchomieniu starszej
  // wersji skryptu) - wtedy go przepinamy, zamiast tworzyc duplikat.
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
      data: { templateId: template.id, name: 'Zaproszenie ślubne', sortOrder: 0, isActive: true },
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

  const lineAsset = await ensureLineAsset(template.id)
  const layout = buildLayout(lineAsset.filePath)

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
        formId: form.id,
        fields: FIELDS.map((field) => `${field.key} (${field.scope})`),
        lineAsset: lineAsset.filePath,
        layers: layout.layers.map((layer) => layer.name),
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
