/**
 * Szablon zaproszenia slubnego "SLUB_ROZA" - format 120 x 170 mm:
 * rysowana jedna linia roza z inicjalami po bokach, para w didone
 * (Bodoni Moda) i rozstrzelony blok tresci.
 *
 * Ramki wokol tresci NIE MA - dokladamy ja recznie w edytorze.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera); lokalnie: pnpm tsx src/scripts/create-slub-roza-template.ts
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'SLUB_ROZA'
const TEMPLATE_NAME = 'Ślub Róża'
const TEMPLATE_DESCRIPTION =
  'Zaproszenie ślubne 120 x 170 mm - róża rysowana jedną linią, inicjały pary, didone i rozstrzelony tekst.'

const DPI = 300
const WIDTH_MM = 120
const HEIGHT_MM = 170

const INK = '#1a1a1a'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Kroje z rejestru czcionek serwera (storage/fonts) - tylko te node-canvas
// zarejestruje przy druku. Bodoni Moda jest krojem ZMIENNYM, wiec dostepna
// jest wylacznie instancja domyslna (400) - stad brak wag posrednich.
const DISPLAY_FONT = 'Bodoni Moda'
const SERIF_FONT = 'Cormorant Infant'

const FONTS = [
  { family: DISPLAY_FONT, src: 'fonts/BodoniModa-VariableFont_opsz_wght.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Light.ttf', weight: 300, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Regular.ttf', weight: 400, style: 'normal' as const },
]

/**
 * Roza rysowana jedna linia.
 *
 * `currentColor` zostaje w pliku, zeby klient mogl przebarwic ozdobnik kolorem
 * z palety (renderer podstawia go przez `tint`). `color` na elemencie glownym
 * daje deterministyczna czern, gdy tintu nie ma.
 */
const ROSE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 400" fill="none" color="${INK}" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M88 108 C82 88, 90 74, 96 62 C101 51, 92 42, 86 50 C80 58, 92 66, 99 56 C107 44, 98 28, 90 18"/>
  <path d="M76 206 C52 198, 36 170, 40 142 C43 120, 60 106, 78 108"/>
  <path d="M78 108 C98 110, 112 130, 112 154 C112 180, 98 200, 76 206"/>
  <path d="M76 206 C60 198, 52 178, 56 158 C60 138, 76 128, 90 136"/>
  <path d="M90 136 C99 145, 101 160, 94 170 C87 180, 73 178, 70 167 C67 156, 77 148, 84 154"/>
  <path d="M80 206 C83 250, 79 300, 81 388"/>
  <path d="M80 306 C60 302, 46 286, 42 266 C64 266, 78 284, 80 306"/>
  <path d="M81 254 C95 250, 105 238, 105 224 C91 226, 81 238, 81 254"/>
</svg>
`

const ROSE_WIDTH_MM = 15
const ROSE_TOP_MM = 12
const ROSE_HEIGHT_MM = 40

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
    key: 'initial_bride',
    label: 'Inicjał Panny Młodej',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 1,
    defaultValue: 'A',
    maxLength: 2,
  },
  {
    key: 'initial_groom',
    label: 'Inicjał Pana Młodego',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 2,
    defaultValue: 'G',
    maxLength: 2,
  },
  {
    key: 'bride_full',
    label: 'Panna Młoda - imię i nazwisko',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 3,
    defaultValue: 'Anna Kornacka',
    maxLength: 40,
  },
  {
    key: 'groom_full',
    label: 'Pan Młody - imię i nazwisko',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 4,
    defaultValue: 'Grzegorz Modrzewiecki',
    maxLength: 40,
  },
  {
    key: 'invitation_intro',
    label: 'Zwrot zapraszający',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 5,
    defaultValue: 'serdecznie zapraszają\nna swój ślub i przyjęcie weselne',
    maxLength: 90,
  },
  {
    key: 'guest_names',
    label: 'Zapraszani goście',
    type: 'text',
    // Jedyne pole per sztuka - na kazdym zaproszeniu stoi inny gosc.
    scope: 'INDIVIDUAL',
    required: true,
    sortOrder: 6,
    placeholder: 'np. Annę i Rafała Baranowskich',
    helpText: 'Osobna treść dla każdego zaproszenia w zamówieniu.',
    maxLength: 60,
  },
  {
    key: 'ceremony_details',
    label: 'Uroczystość - data i miejsce',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 7,
    defaultValue:
      'Uroczystość zaślubin odbędzie się\n10 czerwca 2026 roku o godzinie 16:00\nw Kościele św. Pawła Archanioła w Opolu.',
    maxLength: 160,
  },
  {
    key: 'reception_text',
    label: 'Przyjęcie weselne',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 8,
    defaultValue: 'Po ceremonii zapraszamy na przyjęcie weselne\ndo Restauracji Elegant One.',
    maxLength: 160,
  },
  {
    key: 'date_footer',
    label: 'Data w stopce',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 9,
    defaultValue: '10 | 06 | 2026',
    maxLength: 20,
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

function roseLayer(imageUrl: string) {
  return {
    id: 'rose',
    name: 'Róża',
    type: 'image' as const,
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: 0,
    x: mm(WIDTH_MM / 2),
    y: mm(ROSE_TOP_MM + ROSE_HEIGHT_MM / 2),
    width: mm(ROSE_WIDTH_MM),
    height: mm(ROSE_HEIGHT_MM),
    rotation: 0,
    properties: {
      type: 'image' as const,
      imageUrl,
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

function buildLayers(roseImageUrl: string) {
  return [
    roseLayer(roseImageUrl),

    // Inicjaly siedza po bokach rozy, na wysokosci PAKA (gorna polowa
    // rysunku) - nizej trafialyby obok samej lodygi.
    textbox({
      id: 'initial_bride',
      name: 'Inicjał Panny Młodej',
      fieldKey: 'initial_bride',
      text: defaults.initial_bride,
      leftMm: 39,
      topMm: 18,
      widthMm: 14,
      heightMm: 12,
      zIndex: 1,
      fontFamily: DISPLAY_FONT,
      fontSize: 20,
      lineHeight: 1,
      textAlign: 'center',
    }),

    textbox({
      id: 'initial_groom',
      name: 'Inicjał Pana Młodego',
      fieldKey: 'initial_groom',
      text: defaults.initial_groom,
      leftMm: 67,
      topMm: 18,
      widthMm: 14,
      heightMm: 12,
      zIndex: 2,
      fontFamily: DISPLAY_FONT,
      fontSize: 20,
      lineHeight: 1,
      textAlign: 'center',
    }),

    textbox({
      id: 'bride_full',
      name: 'Panna Młoda',
      fieldKey: 'bride_full',
      text: defaults.bride_full,
      leftMm: 18,
      topMm: 64,
      widthMm: 84,
      heightMm: 12,
      zIndex: 3,
      fontFamily: DISPLAY_FONT,
      fontSize: 18,
      letterSpacing: 20,
      lineHeight: 1.1,
      textAlign: 'center',
    }),

    textbox({
      id: 'groom_full',
      name: 'Pan Młody',
      fieldKey: 'groom_full',
      text: defaults.groom_full,
      leftMm: 18,
      topMm: 76,
      widthMm: 84,
      heightMm: 12,
      zIndex: 4,
      fontFamily: DISPLAY_FONT,
      fontSize: 18,
      letterSpacing: 20,
      lineHeight: 1.1,
      textAlign: 'center',
    }),

    textbox({
      id: 'invitation_intro',
      name: 'Zwrot zapraszający',
      fieldKey: 'invitation_intro',
      text: defaults.invitation_intro,
      leftMm: 18,
      topMm: 93,
      widthMm: 84,
      heightMm: 11,
      zIndex: 5,
      fontFamily: SERIF_FONT,
      fontSize: 9,
      letterSpacing: 100,
      lineHeight: 1.5,
      textAlign: 'center',
    }),

    textbox({
      id: 'guest_names',
      name: 'Zapraszani goście',
      fieldKey: 'guest_names',
      text: 'Annę i Rafała Baranowskich',
      leftMm: 18,
      topMm: 106,
      widthMm: 84,
      heightMm: 7,
      zIndex: 6,
      fontFamily: SERIF_FONT,
      fontSize: 9.5,
      letterSpacing: 100,
      lineHeight: 1.4,
      textAlign: 'center',
    }),

    textbox({
      id: 'ceremony_details',
      name: 'Uroczystość - data i miejsce',
      fieldKey: 'ceremony_details',
      text: defaults.ceremony_details,
      leftMm: 16,
      topMm: 115,
      widthMm: 88,
      heightMm: 15,
      zIndex: 7,
      fontFamily: SERIF_FONT,
      fontSize: 9,
      letterSpacing: 90,
      lineHeight: 1.5,
      textAlign: 'center',
    }),

    textbox({
      id: 'reception_text',
      name: 'Przyjęcie weselne',
      fieldKey: 'reception_text',
      text: defaults.reception_text,
      leftMm: 16,
      topMm: 133,
      widthMm: 88,
      heightMm: 10,
      zIndex: 8,
      fontFamily: SERIF_FONT,
      fontSize: 9,
      letterSpacing: 90,
      lineHeight: 1.5,
      textAlign: 'center',
    }),

    textbox({
      id: 'date_footer',
      name: 'Data w stopce',
      fieldKey: 'date_footer',
      text: defaults.date_footer,
      leftMm: 40,
      topMm: 147,
      widthMm: 40,
      heightMm: 7,
      zIndex: 9,
      fontFamily: SERIF_FONT,
      fontSize: 8,
      letterSpacing: 120,
      lineHeight: 1.3,
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
  formatPreset: 'CUSTOM' as const,
  dpi: DPI,
  bleed: 0,
  safeArea: mm(5),
  bleedMm: 0,
  safeAreaMm: 5,
  backgroundColor: '#ffffff',
}

export function buildLayout(roseImageUrl: string) {
  const layers = buildLayers(roseImageUrl)

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
    palette: ['#1a1a1a', '#4f4f4f', '#7d6b58', '#b08d57', '#5b6d5b'],
  }
}

/** Roza w storage jako SVG - renderer rasteryzuje ja w rozmiarze docelowym. */
async function ensureRoseAsset(templateId: string) {
  const existing = await prisma.templateAsset.findFirst({
    where: { templateId, assetType: 'DECORATION', fileName: { startsWith: 'roza' } },
  })
  if (existing) return existing

  const fileName = `roza_${Date.now()}.svg`
  const dir = path.join(process.cwd(), 'storage', 'templates', TEMPLATE_CODE, 'decoration')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), ROSE_SVG, 'utf-8')

  return prisma.templateAsset.create({
    data: {
      templateId,
      assetType: 'DECORATION',
      fileName,
      filePath: path.join('templates', TEMPLATE_CODE, 'decoration', fileName),
      fileSize: Buffer.byteLength(ROSE_SVG),
      mimeType: 'image/svg+xml',
      metadata: { width: 150, height: 400, originalName: 'roza.svg' },
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

  const roseAsset = await ensureRoseAsset(template.id)
  const layout = buildLayout(roseAsset.filePath)

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
        roseAsset: roseAsset.filePath,
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
