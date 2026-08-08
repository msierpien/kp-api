/**
 * Winietka "MIS" - skladana karta 105 x 50 mm z akwarelowym misiem po lewej
 * stronie i jednym polem na imie i nazwisko goscia.
 *
 * Pole `guest_name` jest w zakresie INDIVIDUAL, wiec panel poprosi o osobna
 * tresc dla kazdej zamowionej winietki (lista gosci = tyle wpisow, ile sztuk).
 *
 * Sklad do druku jak w istniejacym szablonie WINIETKA: arkusz 105 x 100 mm,
 * przod obrocony o 180 stopni na gorze, tyl pod spodem - po zlozeniu wzdluz
 * srodka karta stoi napisem do goscia.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera). Grafiki bierze ze sciezek podanych w zmiennych
 * srodowiskowych:
 *   MIS_SOURCE=/app/tmp/mis.png MOCKUP_SOURCE=/app/tmp/mockup-mis.png \
 *     node dist/scripts/create-winietka-mis-template.js
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'MIS'
const TEMPLATE_NAME = 'Miś'
const TEMPLATE_DESCRIPTION =
  'Winietka 105 x 50 mm - akwarelowy miś z balonikami po lewej stronie, imię i nazwisko gościa po prawej.'

const DPI = 300
const WIDTH_MM = 105
const HEIGHT_MM = 50

/** Brąz z rysunku - czarny tusz przy akwareli wyglada twardo. */
const INK = '#5b4232'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Krój z rejestru czcionek na serwerze (storage/fonts) - tylko takie
// node-canvas zarejestruje przy druku. Krój spoza rejestru wygladalby dobrze
// w podgladzie i cicho spadl na systemowy fallback na wydruku.
const SERIF_FONT = 'Cormorant Infant'

const FONTS = [
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Medium.ttf', weight: 500, style: 'normal' as const },
]

const GUEST_FIELD_KEY = 'guest_name'
const GUEST_PLACEHOLDER = 'Anna Kowalska'

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
    key: GUEST_FIELD_KEY,
    label: 'Imię i nazwisko gościa',
    type: 'text',
    // Jedyne pole szablonu i jedyne per sztuka: panel wystawi tyle wpisow,
    // ile winietek jest w zamowieniu - to jest wlasnie lista gosci.
    scope: 'INDIVIDUAL',
    required: true,
    sortOrder: 1,
    placeholder: `np. ${GUEST_PLACEHOLDER}`,
    helpText: 'Osobny wpis dla każdej zamówionej winietki.',
    maxLength: 40,
  },
]

// --- Grafika misia -----------------------------------------------------
// Rysunek jest przyciety do samej tresci, wiec ramka warstwy = ramka rysunku.
// Proporcje trzymamy recznie: renderer skaluje obraz DOKLADNIE do width/height
// warstwy (`fit` nie ratuje proporcji), wiec zla ramka splaszcza misia.
const MIS_SOURCE_WIDTH = 1028
const MIS_SOURCE_HEIGHT = 1400

const MIS_HEIGHT_MM = 40
const MIS_LEFT_MM = 5
const MIS_TOP_MM = (HEIGHT_MM - MIS_HEIGHT_MM) / 2

const MIS_HEIGHT_PX = mm(MIS_HEIGHT_MM)
const MIS_WIDTH_PX = Math.round((MIS_HEIGHT_PX * MIS_SOURCE_WIDTH) / MIS_SOURCE_HEIGHT)
const MIS_WIDTH_MM = (MIS_WIDTH_PX * 25.4) / DPI

// Kolumna tekstu: od rysunku (z 2 mm oddechu) do 5,5 mm przed prawa krawedzia.
const TEXT_LEFT_MM = Math.round((MIS_LEFT_MM + MIS_WIDTH_MM + 2) * 10) / 10
const TEXT_WIDTH_MM = Math.round((WIDTH_MM - 5.5 - TEXT_LEFT_MM) * 10) / 10

// --- Mockup ------------------------------------------------------------
// Rogi przedniej scianki winietki na zdjeciu, znormalizowane do rozmiaru
// zdjecia: lewy-gorny, prawy-gorny, prawy-dolny, lewy-dolny.
const MOCKUP_CORNERS = [
  { x: 0.253, y: 0.444 },
  { x: 0.775, y: 0.399 },
  { x: 0.787, y: 0.602 },
  { x: 0.284, y: 0.65 },
] as const

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

/** Miś jako zwykla warstwa obrazu - `shape` nie istnieje na wydruku. */
function misLayer(imageUrl: string) {
  return {
    id: 'mis_grafika',
    name: 'Miś z balonikami',
    type: 'image' as const,
    visible: true,
    locked: true,
    opacity: 1,
    zIndex: 0,
    x: mm(MIS_LEFT_MM) + Math.round(MIS_WIDTH_PX / 2),
    y: mm(MIS_TOP_MM) + Math.round(MIS_HEIGHT_PX / 2),
    width: MIS_WIDTH_PX,
    height: MIS_HEIGHT_PX,
    rotation: 0,
    properties: {
      type: 'image' as const,
      imageUrl,
      fit: 'contain' as const,
      lockAspectRatio: true,
      clientDraggable: false,
      clientResizable: false,
      clientRotatable: false,
    },
  }
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
  safeArea: mm(3),
  bleedMm: 0,
  safeAreaMm: 3,
  backgroundColor: '#ffffff',
}

const FRONT_PAGE_ID = 'page-1'
const BACK_PAGE_ID = 'page-2'

function buildFrontLayers(misImageUrl: string) {
  return [
    misLayer(misImageUrl),

    // Kolumna z imieniem zaczyna sie za rysunkiem i konczy 5,5 mm przed prawa
    // krawedzia; dwa wiersze zapasu na dlugie nazwiska.
    //
    // 18 pt to nie ozdoba, tylko wynik pomiaru: fabric lamie tekst po
    // SPACJACH, wiec dwuczlonowe nazwisko ("Wiśniewska-Kowalczyk", 20 znakow)
    // jest jednym slowem i przy wiekszym kroju wychodzi poza krawedz karty -
    // renderer nie ma auto-dopasowania rozmiaru.
    textbox({
      id: GUEST_FIELD_KEY,
      name: 'Imię i nazwisko gościa',
      fieldKey: GUEST_FIELD_KEY,
      text: GUEST_PLACEHOLDER,
      leftMm: TEXT_LEFT_MM,
      topMm: 14,
      widthMm: TEXT_WIDTH_MM,
      heightMm: 22,
      zIndex: 1,
      fontFamily: SERIF_FONT,
      fontSize: 18,
      fontWeight: 500,
      lineHeight: 1.3,
      letterSpacing: 15,
      textAlign: 'center',
      verticalAlign: 'middle',
    }),
  ]
}

export function buildLayout(misImageUrl: string, mockupImageUrl: string) {
  const frontLayers = buildFrontLayers(misImageUrl)

  return {
    version: 2 as const,
    // `canvas`/`layers` to lustro pierwszej strony - wymaga tego format
    // (withTemplatePages) i tego szuka kazdy starszy konsument.
    canvas: canvasConfig,
    fonts: FONTS,
    layers: frontLayers,
    pages: [
      { id: FRONT_PAGE_ID, name: 'Przód', canvas: canvasConfig, layers: frontLayers },
      // Tyl zostaje pusty - miejsce na menu albo podziekowanie, jesli klient
      // o nie poprosi. Strona musi istniec, bo bez niej nie ma czego zlozyc.
      { id: BACK_PAGE_ID, name: 'Tył', canvas: canvasConfig, layers: [] },
    ],
    print: {
      // Arkusz to dwie karty jedna nad druga; zagiecie idzie przez srodek.
      // Przod obrocony o 180 stopni, zeby po zlozeniu stal napisem do gory.
      sheet: { widthMm: WIDTH_MM, heightMm: HEIGHT_MM * 2 },
      placements: [
        { pageId: FRONT_PAGE_ID, xMm: 0, yMm: 0, rotation: 180 as const },
        { pageId: BACK_PAGE_ID, xMm: 0, yMm: HEIGHT_MM, rotation: 0 as const },
      ],
      mode: 'sheet' as const,
    },
    mockups: [
      {
        id: 'mockup_mis',
        name: 'Winietka na talerzu',
        imageUrl: mockupImageUrl,
        surfaces: [
          {
            id: 'surface_front',
            pageId: FRONT_PAGE_ID,
            corners: MOCKUP_CORNERS.map((corner) => ({ ...corner })) as any,
            // multiply = nadruk na papierze: biel projektu przepuszcza
            // fakture kartonu ze zdjecia.
            blendMode: 'multiply' as const,
            opacity: 1,
          },
        ],
      },
    ],
    palette: ['#5b4232', '#8a6b4f', '#b89a7a', '#d8c6b0', '#1a1a1a'],
  }
}

/**
 * Kopiuje grafike do storage i zaklada rekord assetu.
 *
 * Rozdziela pliki po `fileName`, wiec ponowne uruchomienie skryptu nie mnozy
 * kopii tego samego rysunku w katalogu szablonu.
 */
async function ensureAsset(options: {
  templateId: string
  assetType: 'DECORATION' | 'BACKGROUND'
  baseName: string
  sourceEnv: string
  defaultSource: string
  width: number
  height: number
}) {
  const existing = await prisma.templateAsset.findFirst({
    where: {
      templateId: options.templateId,
      assetType: options.assetType,
      fileName: { startsWith: options.baseName },
    },
  })
  if (existing) return existing

  const source = process.env[options.sourceEnv] || options.defaultSource
  if (!fs.existsSync(source)) {
    throw new Error(`Brak pliku grafiki: ${source} (ustaw ${options.sourceEnv})`)
  }
  const buffer = fs.readFileSync(source)

  const fileName = `${options.baseName}_${Date.now()}.png`
  const dirRelative = path.join('templates', TEMPLATE_CODE, options.assetType.toLowerCase())
  const dir = path.join(process.cwd(), 'storage', dirRelative)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), buffer)

  return prisma.templateAsset.create({
    data: {
      templateId: options.templateId,
      assetType: options.assetType,
      fileName,
      filePath: path.join(dirRelative, fileName),
      fileSize: buffer.length,
      mimeType: 'image/png',
      metadata: {
        width: options.width,
        height: options.height,
        originalName: `${options.baseName}.png`,
      },
      sortOrder: 0,
    },
  })
}

/**
 * Tenant docelowy.
 *
 * `tenantId` normalnie dokłada middleware Prismy z kontekstu zadania - skrypt
 * takiego kontekstu nie ma. Wskazujemy tenanta JAWNIE po slugu, bo baza niesie
 * tez tenanta seedowego i testowe, a szablon wpiety do niewlasciwego nie
 * pojawi sie na liscie w panelu.
 */
async function resolveTenantId() {
  const slug = process.env.TENANT_SLUG || TENANT_SLUG
  const tenant = await prisma.tenant.findFirst({ where: { slug }, select: { id: true, name: true } })
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
      data: { templateId: template.id, name: 'Lista gości', sortOrder: 0, isActive: true },
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

  const misAsset = await ensureAsset({
    templateId: template.id,
    assetType: 'DECORATION',
    baseName: 'mis',
    sourceEnv: 'MIS_SOURCE',
    defaultSource: '/app/tmp/mis.png',
    width: MIS_SOURCE_WIDTH,
    height: MIS_SOURCE_HEIGHT,
  })

  const mockupAsset = await ensureAsset({
    templateId: template.id,
    assetType: 'BACKGROUND',
    baseName: 'winietka-mis-mockup',
    sourceEnv: 'MOCKUP_SOURCE',
    defaultSource: '/app/tmp/mockup-mis.png',
    width: 1024,
    height: 1536,
  })

  const layout = buildLayout(misAsset.filePath, mockupAsset.filePath)

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
        misAsset: misAsset.filePath,
        mockupAsset: mockupAsset.filePath,
        pages: layout.pages.map((page) => `${page.id} (${page.name})`),
        sheet: layout.print.sheet,
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
