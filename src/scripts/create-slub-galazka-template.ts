/**
 * Szablon zaproszenia slubnego "SLUB_GALAZKA" - format 120 x 170 mm:
 * botaniczna galazka u gory i u dolu (ta sama grafika, dolna obrocona o 180
 * stopni), rozstrzelone wersaliki i imiona pary pisane recznie.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera); lokalnie: pnpm tsx src/scripts/create-slub-galazka-template.ts
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'SLUB_GALAZKA'
const TEMPLATE_NAME = 'Ślub Gałązka'
const TEMPLATE_DESCRIPTION =
  'Zaproszenie ślubne 120 x 170 mm - botaniczna gałązka u góry i u dołu, rozstrzelone wersaliki, imiona pary pisane ręcznie.'

const DPI = 300
const WIDTH_MM = 120
const HEIGHT_MM = 170

const INK = '#1a1a1a'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Kroje z rejestru czcionek serwera (storage/fonts) - tylko te node-canvas
// zarejestruje przy druku. Montserrat jest krojem ZMIENNYM, wiec dostepna
// jest wylacznie instancja domyslna (400).
const SCRIPT_FONT = 'Bonheur Royale'
const SANS_FONT = 'Montserrat'

const FONTS = [
  { family: SCRIPT_FONT, src: 'fonts/BonheurRoyale-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SANS_FONT, src: 'fonts/Montserrat.ttf', weight: 400, style: 'normal' as const },
]

/**
 * Galazka - lisce rozstawione wzdluz krzywej Beziera (kat kazdego wynika ze
 * stycznej, stad naturalny rozklad).
 *
 * `currentColor` zostaje w pliku, zeby klient mogl przebarwic ozdobnik kolorem
 * z palety (renderer podstawia go przez `tint`). `color` na elemencie glownym
 * daje deterministyczna czern, gdy tintu nie ma.
 */
const BRANCH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 120" fill="none" color="${INK}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M24 74 C140 40 264 44 376 60"/>
  <path d="M59 64.9 C62.3 56.4 71.3 48.8 78.8 45.3 C75.2 52.8 67.6 61.7 59 64.9"/>
  <path d="M85.4 59.5 C92.4 66.8 104.7 70.6 113.9 70.9 C107 64.8 95.4 59.1 85.4 59.5"/>
  <path d="M111.9 55.3 C116.7 45.3 128.2 37.2 137.5 33.7 C132.5 42.4 122.5 52.3 111.9 55.3"/>
  <path d="M138.5 52 C146.1 61.3 160.3 66.9 171.1 68.1 C163.6 60.3 150.4 52.5 138.5 52"/>
  <path d="M165.1 49.8 C171.6 38.7 185.7 30.1 196.9 26.9 C190.3 36.5 177.7 47.2 165.1 49.8"/>
  <path d="M191.8 48.5 C199 58.7 213.5 65.6 224.6 67.6 C217.4 58.9 204.2 49.8 191.8 48.5"/>
  <path d="M218.4 48.1 C224.8 38.4 237.9 31.6 248.2 29.4 C241.7 37.6 229.8 46.5 218.4 48.1"/>
  <path d="M244.9 48.4 C250.5 57.4 262.5 64 271.8 66.3 C266.1 58.5 255.4 50.1 244.9 48.4"/>
  <path d="M271.2 49.5 C277 41.7 288.4 36.6 297 35.2 C291.3 41.8 280.9 48.7 271.2 49.5"/>
  <path d="M297.4 51.2 C301.7 58.9 311.2 64.8 318.8 67.1 C314.4 60.5 305.9 53.1 297.4 51.2"/>
  <path d="M323.3 53.5 C328.3 47.5 337.6 43.8 344.7 43 C339.7 48.1 331.1 53.3 323.3 53.5"/>
  <path d="M348.9 56.4 C352 62.6 359.3 67.6 365.2 69.6 C362 64.3 355.6 58.2 348.9 56.4"/>
  <path d="M44 90 C35.1 90 26 84 21 77.8 C29 78.4 39.1 82.6 44 90"/>
  <path d="M70 97 C63.2 97.9 55.7 94 51.5 89.5 C57.6 89.2 65.7 91.6 70 97"/>
</svg>
`

const BRANCH_WIDTH_MM = 46
const BRANCH_HEIGHT_MM = (BRANCH_WIDTH_MM * 120) / 400

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
    key: 'invitation_intro',
    label: 'Zwrot wprowadzający',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 1,
    defaultValue:
      'Z OGROMNĄ RADOŚCIĄ I MIŁOŚCIĄ W SERCACH\nZAPRASZAMY WAS DO WSPÓLNEGO CELEBROWANIA\nNAJPIĘKNIEJSZEGO DNIA NASZEGO ŻYCIA.',
    helpText: 'Wersaliki - krój nie zamienia liter automatycznie. Trzy wiersze mieszczą się bez zawijania.',
    maxLength: 150,
  },
  {
    key: 'bride_name',
    label: 'Panna Młoda - imię i nazwisko',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 2,
    defaultValue: 'Julia Romanowska',
    maxLength: 30,
  },
  {
    key: 'groom_name',
    label: 'Pan Młody - imię i nazwisko',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 3,
    defaultValue: 'Mateusz Kawalec',
    maxLength: 30,
  },
  {
    key: 'ceremony_details',
    label: 'Uroczystość - data i miejsce',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 4,
    defaultValue:
      'PRZYSIĘGNĄ SOBIE MIŁOŚĆ I WIERNOŚĆ\n12 CZERWCA 2025 ROKU O GODZINIE 16:00\nW KOŚCIELE ŚW. ANNY W KRAKOWIE.',
    maxLength: 150,
  },
  {
    key: 'reception_text',
    label: 'Przyjęcie weselne',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 5,
    defaultValue: 'PO CEREMONII ZAPRASZAMY NA PRZYJĘCIE WESELNE\nDO PAŁACU W PASZKÓWCE.',
    maxLength: 120,
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

/** Ta sama grafika u gory i u dolu - dolna obrocona o 180 stopni. */
function branchLayer(input: { id: string; name: string; imageUrl: string; centerYMm: number; rotation: 0 | 180; zIndex: number }) {
  return {
    id: input.id,
    name: input.name,
    type: 'image' as const,
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: input.zIndex,
    x: mm(WIDTH_MM / 2),
    y: mm(input.centerYMm),
    width: mm(BRANCH_WIDTH_MM),
    height: mm(BRANCH_HEIGHT_MM),
    rotation: input.rotation,
    properties: {
      type: 'image' as const,
      imageUrl: input.imageUrl,
      fit: 'contain' as const,
      lockAspectRatio: true,
      // Jawny tint zamiast liczenia na domyslny kolor rasteryzatora.
      tint: INK,
      clientDraggable: false,
      clientResizable: false,
      clientRotatable: false,
    },
  }
}

const defaults = Object.fromEntries(FIELDS.map((field) => [field.key, field.defaultValue ?? '']))

function buildLayers(branchImageUrl: string) {
  return [
    branchLayer({ id: 'branch_top', name: 'Gałązka górna', imageUrl: branchImageUrl, centerYMm: 23, rotation: 0, zIndex: 0 }),

    textbox({
      id: 'invitation_intro',
      name: 'Zwrot wprowadzający',
      fieldKey: 'invitation_intro',
      text: defaults.invitation_intro,
      leftMm: 14,
      topMm: 42,
      widthMm: 92,
      heightMm: 15,
      zIndex: 1,
      fontFamily: SANS_FONT,
      fontSize: 7,
      letterSpacing: 80,
      lineHeight: 1.9,
      textAlign: 'center',
    }),

    textbox({
      id: 'bride_name',
      name: 'Panna Młoda',
      fieldKey: 'bride_name',
      text: defaults.bride_name,
      leftMm: 15,
      topMm: 64,
      widthMm: 90,
      heightMm: 16,
      zIndex: 2,
      fontFamily: SCRIPT_FONT,
      fontSize: 30,
      lineHeight: 1,
      textAlign: 'center',
    }),

    textbox({
      id: 'groom_name',
      name: 'Pan Młody',
      fieldKey: 'groom_name',
      text: defaults.groom_name,
      leftMm: 15,
      topMm: 80,
      widthMm: 90,
      heightMm: 16,
      zIndex: 3,
      fontFamily: SCRIPT_FONT,
      fontSize: 30,
      lineHeight: 1,
      textAlign: 'center',
    }),

    textbox({
      id: 'ceremony_details',
      name: 'Uroczystość - data i miejsce',
      fieldKey: 'ceremony_details',
      text: defaults.ceremony_details,
      leftMm: 14,
      topMm: 102,
      widthMm: 92,
      heightMm: 15,
      zIndex: 4,
      fontFamily: SANS_FONT,
      fontSize: 7,
      letterSpacing: 80,
      lineHeight: 1.9,
      textAlign: 'center',
    }),

    textbox({
      id: 'reception_text',
      name: 'Przyjęcie weselne',
      fieldKey: 'reception_text',
      text: defaults.reception_text,
      leftMm: 14,
      topMm: 120,
      widthMm: 92,
      heightMm: 11,
      zIndex: 5,
      fontFamily: SANS_FONT,
      fontSize: 7,
      letterSpacing: 80,
      lineHeight: 1.9,
      textAlign: 'center',
    }),

    branchLayer({ id: 'branch_bottom', name: 'Gałązka dolna', imageUrl: branchImageUrl, centerYMm: 146, rotation: 180, zIndex: 6 }),
  ]
}

const canvasConfig = {
  width: mm(WIDTH_MM),
  height: mm(HEIGHT_MM),
  unit: 'mm' as const,
  widthMm: WIDTH_MM,
  heightMm: HEIGHT_MM,
  formatPreset: 'CUSTOM' as const,
  dpi: DPI,
  bleed: 0,
  safeArea: mm(5),
  bleedMm: 0,
  safeAreaMm: 5,
  backgroundColor: '#ffffff',
}

export function buildLayout(branchImageUrl: string) {
  const layers = buildLayers(branchImageUrl)

  return {
    version: 2 as const,
    // `canvas`/`layers` to lustro pierwszej strony - wymaga tego format.
    canvas: canvasConfig,
    fonts: FONTS,
    layers,
    pages: [{ id: 'page-1', name: 'Zaproszenie', canvas: canvasConfig, layers }],
    print: {
      sheet: { widthMm: WIDTH_MM, heightMm: HEIGHT_MM },
      placements: [{ pageId: 'page-1', xMm: 0, yMm: 0, rotation: 0 as const }],
      mode: 'sheet' as const,
    },
    palette: ['#1a1a1a', '#4f4f4f', '#6b7a63', '#8a7355', '#2c3e50'],
  }
}

/** Galazka w storage jako SVG - renderer rasteryzuje ja w rozmiarze docelowym. */
async function ensureBranchAsset(templateId: string) {
  const existing = await prisma.templateAsset.findFirst({
    where: { templateId, assetType: 'DECORATION', fileName: { startsWith: 'galazka' } },
  })
  if (existing) return existing

  const fileName = `galazka_${Date.now()}.svg`
  const dir = path.join(process.cwd(), 'storage', 'templates', TEMPLATE_CODE, 'decoration')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), BRANCH_SVG, 'utf-8')

  return prisma.templateAsset.create({
    data: {
      templateId,
      assetType: 'DECORATION',
      fileName,
      filePath: path.join('templates', TEMPLATE_CODE, 'decoration', fileName),
      fileSize: Buffer.byteLength(BRANCH_SVG),
      mimeType: 'image/svg+xml',
      metadata: { width: 400, height: 120, originalName: 'galazka.svg' },
      sortOrder: 0,
    },
  })
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

  const branchAsset = await ensureBranchAsset(template.id)
  const layout = buildLayout(branchAsset.filePath)

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
        formatMm: [WIDTH_MM, HEIGHT_MM],
        fields: FIELDS.map((field) => `${field.key} (${field.scope})`),
        branchAsset: branchAsset.filePath,
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
