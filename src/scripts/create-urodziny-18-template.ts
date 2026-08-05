/**
 * Szablon zaproszenia urodzinowego "URODZINY_18" - format 120 x 170 mm:
 * pionowa kreska po lewej PRZERWANA duza liczba lat, motto kursywa u gory
 * i prawy blok tresci wyrownany do prawej, podpisany recznie.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera); lokalnie: pnpm tsx src/scripts/create-urodziny-18-template.ts
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'
import { createCanvas } from 'canvas'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'URODZINY_18'
const TEMPLATE_NAME = 'Urodziny 18'
const TEMPLATE_DESCRIPTION =
  'Zaproszenie urodzinowe 120 x 170 mm - pionowa kreska przerwana liczbą lat, motto kursywą, prawy blok treści z odręcznym podpisem.'

const DPI = 300
const WIDTH_MM = 120
const HEIGHT_MM = 170

const INK = '#1a1a1a'
/** Rozstrzelone wersaliki sa jasniejsze od liczb i nazwisk - tak jak na wzorcu. */
const INK_SOFT = '#4a4a4a'
const INK_FAINT = '#6a6a6a'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Kroje z rejestru czcionek serwera (storage/fonts) - tylko te node-canvas
// zarejestruje przy druku. Bodoni Moda jest krojem ZMIENNYM, wiec dostepna
// jest wylacznie instancja domyslna (400).
const DISPLAY_FONT = 'Bodoni Moda'
const SERIF_FONT = 'Cormorant Infant'
const SCRIPT_FONT = 'Bonheur Royale'

const FONTS = [
  { family: DISPLAY_FONT, src: 'fonts/BodoniModa-VariableFont_opsz_wght.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Italic.ttf', weight: 400, style: 'italic' as const },
  { family: SCRIPT_FONT, src: 'fonts/BonheurRoyale-Regular.ttf', weight: 400, style: 'normal' as const },
]

// Kreska biegnie przy lewej krawedzi i jest PRZERWANA liczba lat - gorny
// odcinek konczy sie nad nia, dolny zaczyna pod nia.
const RULE_LEFT_MM = 13
const RULE_WIDTH_PX = 5
const RULE_TOP_FROM_MM = 8
const RULE_TOP_TO_MM = 72
const RULE_BOTTOM_FROM_MM = 95
const RULE_BOTTOM_TO_MM = 162

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
    key: 'quote_text',
    label: 'Motto',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 1,
    defaultValue: 'Osiemnaście lat to początek nowej podróży\n– pełnej marzeń, wyzwań i pięknych chwil',
    maxLength: 110,
  },
  {
    key: 'quote_author',
    label: 'Autor motta',
    type: 'text',
    scope: 'SHARED',
    required: false,
    sortOrder: 2,
    defaultValue: 'autor nieznany',
    maxLength: 30,
  },
  {
    key: 'age_number',
    label: 'Liczba lat',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 3,
    defaultValue: '18',
    helpText: 'Dwie cyfry. Dłuższa liczba nie zmieści się w przerwie w kresce.',
    maxLength: 2,
  },
  {
    key: 'invitation_intro',
    label: 'Zwrot wprowadzający',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 4,
    defaultValue: 'SERDECZNIE ZAPRASZAM',
    helpText: 'Wersaliki - krój nie zamienia liter automatycznie.',
    maxLength: 30,
  },
  {
    key: 'guest_names',
    label: 'Zapraszani goście',
    type: 'text',
    // Jedyne pole per sztuka - na kazdym zaproszeniu stoi inny gosc.
    scope: 'INDIVIDUAL',
    required: true,
    sortOrder: 5,
    placeholder: 'np. SZ. P. ANNĘ I MACIEJA SPOCZYŃSKICH',
    helpText: 'Wersaliki. Osobna treść dla każdego zaproszenia w zamówieniu.',
    maxLength: 60,
  },
  {
    key: 'occasion_text',
    label: 'Okazja',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 6,
    defaultValue: 'NA PRZYJĘCIE Z OKAZJI MOICH\nOSIEMNASTYCH URODZIN',
    maxLength: 90,
  },
  {
    key: 'party_datetime',
    label: 'Data i godzina przyjęcia',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 7,
    defaultValue: '16.08.2029\nO GODZ. 18',
    maxLength: 40,
  },
  {
    key: 'party_place',
    label: 'Miejsce przyjęcia',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 8,
    defaultValue: 'W SALI BANKIETOWEJ „ARENA”\nW BRZOZÓWCE.',
    maxLength: 90,
  },
  {
    key: 'signature',
    label: 'Podpis',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 9,
    defaultValue: 'Dorota',
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
  fontStyle?: 'normal' | 'italic'
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
      fontWeight: input.fontWeight ?? 400,
      fontStyle: input.fontStyle ?? ('normal' as const),
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

/**
 * Odcinek pionowej kreski.
 *
 * Warstwa `shape` odpada - renderer druku jej nie rysuje. Oba odcinki biora
 * ten sam PNG (jednolity prostokat), tylko rozciagniety na inna wysokosc.
 */
function ruleLayer(input: { id: string; name: string; imageUrl: string; fromMm: number; toMm: number; zIndex: number }) {
  const heightMm = input.toMm - input.fromMm
  return {
    id: input.id,
    name: input.name,
    type: 'image' as const,
    visible: true,
    locked: true,
    opacity: 1,
    zIndex: input.zIndex,
    x: mm(RULE_LEFT_MM),
    y: mm(input.fromMm + heightMm / 2),
    width: RULE_WIDTH_PX,
    height: mm(heightMm),
    rotation: 0,
    properties: {
      type: 'image' as const,
      imageUrl: input.imageUrl,
      fit: 'fill' as const,
      lockAspectRatio: false,
      clientDraggable: false,
      clientResizable: false,
      clientRotatable: false,
    },
  }
}

const defaults = Object.fromEntries(FIELDS.map((field) => [field.key, field.defaultValue ?? '']))

// Prawy blok trzyma wspolna krawedz - to ona porzadkuje cala prawa strone.
const RIGHT_EDGE_MM = 108

function buildLayers(ruleImageUrl: string) {
  return [
    ruleLayer({
      id: 'rule_top',
      name: 'Kreska górna',
      imageUrl: ruleImageUrl,
      fromMm: RULE_TOP_FROM_MM,
      toMm: RULE_TOP_TO_MM,
      zIndex: 0,
    }),
    ruleLayer({
      id: 'rule_bottom',
      name: 'Kreska dolna',
      imageUrl: ruleImageUrl,
      fromMm: RULE_BOTTOM_FROM_MM,
      toMm: RULE_BOTTOM_TO_MM,
      zIndex: 1,
    }),

    textbox({
      id: 'quote_text',
      name: 'Motto',
      fieldKey: 'quote_text',
      text: defaults.quote_text,
      leftMm: 44,
      topMm: 6,
      widthMm: RIGHT_EDGE_MM - 44,
      heightMm: 16,
      zIndex: 2,
      fontFamily: SERIF_FONT,
      fontSize: 9,
      fontStyle: 'italic',
      lineHeight: 2.2,
      textAlign: 'right',
    }),

    textbox({
      id: 'quote_author',
      name: 'Autor motta',
      fieldKey: 'quote_author',
      text: defaults.quote_author,
      leftMm: 78,
      topMm: 22,
      widthMm: RIGHT_EDGE_MM - 78,
      heightMm: 5,
      zIndex: 3,
      fontFamily: SERIF_FONT,
      fontSize: 5.5,
      fill: INK_FAINT,
      letterSpacing: 60,
      textAlign: 'right',
    }),

    // Liczba lat siada w przerwie w kresce, przekraczajac ja w obie strony.
    textbox({
      id: 'age_number',
      name: 'Liczba lat',
      fieldKey: 'age_number',
      text: defaults.age_number,
      leftMm: 5.5,
      topMm: 73,
      widthMm: 24,
      heightMm: 20,
      zIndex: 4,
      fontFamily: DISPLAY_FONT,
      fontSize: 60,
      lineHeight: 1,
      textAlign: 'center',
    }),

    textbox({
      id: 'invitation_intro',
      name: 'Zwrot wprowadzający',
      fieldKey: 'invitation_intro',
      text: defaults.invitation_intro,
      leftMm: 48,
      topMm: 88.5,
      widthMm: RIGHT_EDGE_MM - 48,
      heightMm: 6,
      zIndex: 5,
      fontFamily: SERIF_FONT,
      fontSize: 7,
      fill: INK_SOFT,
      letterSpacing: 150,
      textAlign: 'right',
    }),

    textbox({
      id: 'guest_names',
      name: 'Zapraszani goście',
      fieldKey: 'guest_names',
      text: 'SZ. P. ANNĘ I MACIEJA SPOCZYŃSKICH',
      leftMm: 26,
      topMm: 97.5,
      widthMm: RIGHT_EDGE_MM - 26,
      // Dwa wiersze zapasu - dluzsze zwroty grzecznosciowe nie zmieszcza sie
      // w jednej linii.
      heightMm: 10,
      zIndex: 6,
      fontFamily: SERIF_FONT,
      fontSize: 10.5,
      letterSpacing: 40,
      lineHeight: 1.4,
      textAlign: 'right',
    }),

    textbox({
      id: 'occasion_text',
      name: 'Okazja',
      fieldKey: 'occasion_text',
      text: defaults.occasion_text,
      leftMm: 48,
      topMm: 109,
      widthMm: RIGHT_EDGE_MM - 48,
      heightMm: 13,
      zIndex: 7,
      fontFamily: SERIF_FONT,
      fontSize: 7.5,
      fill: INK_SOFT,
      letterSpacing: 150,
      lineHeight: 2,
      textAlign: 'right',
    }),

    textbox({
      id: 'party_datetime',
      name: 'Data i godzina przyjęcia',
      fieldKey: 'party_datetime',
      text: defaults.party_datetime,
      leftMm: 60,
      topMm: 122,
      widthMm: RIGHT_EDGE_MM - 60,
      heightMm: 13,
      zIndex: 8,
      fontFamily: DISPLAY_FONT,
      fontSize: 16,
      letterSpacing: 20,
      lineHeight: 1.35,
      textAlign: 'right',
    }),

    textbox({
      id: 'party_place',
      name: 'Miejsce przyjęcia',
      fieldKey: 'party_place',
      text: defaults.party_place,
      leftMm: 48,
      topMm: 136,
      widthMm: RIGHT_EDGE_MM - 48,
      heightMm: 11,
      zIndex: 9,
      fontFamily: SERIF_FONT,
      fontSize: 7.5,
      fill: INK_SOFT,
      letterSpacing: 150,
      lineHeight: 1.9,
      textAlign: 'right',
    }),

    textbox({
      id: 'signature',
      name: 'Podpis',
      fieldKey: 'signature',
      text: defaults.signature,
      leftMm: 68,
      topMm: 149,
      widthMm: RIGHT_EDGE_MM - 68,
      heightMm: 12,
      zIndex: 10,
      fontFamily: SCRIPT_FONT,
      fontSize: 22,
      lineHeight: 1,
      textAlign: 'right',
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

export function buildLayout(ruleImageUrl: string) {
  const layers = buildLayers(ruleImageUrl)

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
    palette: ['#1a1a1a', '#4a4a4a', '#8a7355', '#b08d57', '#2c3e50'],
  }
}

/** Kreska jako PNG - jednolity prostokat, oba odcinki go rozciagaja. */
async function ensureRuleAsset(templateId: string) {
  const existing = await prisma.templateAsset.findFirst({
    where: { templateId, assetType: 'DECORATION', fileName: { startsWith: 'kreska' } },
  })
  if (existing) return existing

  const height = mm(RULE_BOTTOM_TO_MM - RULE_BOTTOM_FROM_MM)
  const canvas = createCanvas(RULE_WIDTH_PX, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, RULE_WIDTH_PX, height)
  const buffer = canvas.toBuffer('image/png')

  const fileName = `kreska_${Date.now()}.png`
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
      metadata: { width: RULE_WIDTH_PX, height, originalName: 'kreska.png' },
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
      data: { templateId: template.id, name: 'Zaproszenie urodzinowe', sortOrder: 0, isActive: true },
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

  const ruleAsset = await ensureRuleAsset(template.id)
  const layout = buildLayout(ruleAsset.filePath)

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
        ruleAsset: ruleAsset.filePath,
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
