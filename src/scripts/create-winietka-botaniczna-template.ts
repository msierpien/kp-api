/**
 * Winietka "Botaniczna Zieleń" - skladana karta 105 x 50 mm z akwarelowym
 * wiencem eukaliptusa u gory i u dolu, imie i nazwisko goscia w bialym pasie
 * posrodku.
 *
 * Pole `guest_name` jest w zakresie INDIVIDUAL, wiec panel poprosi o osobna
 * tresc dla kazdej zamowionej winietki (lista gosci = tyle wpisow, ile sztuk).
 *
 * Sklad do druku jak w pozostalych winietkach: arkusz 105 x 100 mm, przod
 * obrocony o 180 stopni na gorze, tyl pod spodem - po zlozeniu wzdluz srodka
 * karta stoi napisem do goscia.
 *
 * Mockupu skrypt NIE zaklada - zdjecie podklada sie recznie w panelu.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera). Grafike bierze ze sciezki z zmiennej srodowiskowej:
 *   BG_SOURCE=/app/tmp/botaniczna-zielen.png \
 *     node dist/scripts/create-winietka-botaniczna-template.js
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'WINIETKA_BOTANICZNA'
const TEMPLATE_NAME = 'Botaniczna Zieleń'
const TEMPLATE_DESCRIPTION =
  'Winietka 105 x 50 mm - akwarelowy eukaliptus u góry i u dołu, imię i nazwisko gościa w białym pasie pośrodku.'

const DPI = 300
const WIDTH_MM = 105
const HEIGHT_MM = 50

/** Ciemna zielen z liscia - czern przy akwareli wyglada twardo. */
const INK = '#3e5648'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Krój z rejestru czcionek na serwerze (storage/fonts) - tylko takie
// node-canvas zarejestruje przy druku. Krój spoza rejestru wygladalby dobrze
// w podgladzie i cicho spadl na systemowy fallback na wydruku.
const SERIF_FONT = 'Cormorant Garamond'

const FONTS = [
  { family: SERIF_FONT, src: 'fonts/CormorantGaramond-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantGaramond-Medium.ttf', weight: 500, style: 'normal' as const },
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
    maxLength: 34,
  },
]

// --- Tlo ---------------------------------------------------------------
// Grafika ma 1817 x 866 px, czyli proporcje 2,098 - karta 105 x 50 mm ma 2,1.
// Roznica to 0,05 mm, wiec `cover` nie ma czego przyciac i wieniec siedzi
// dokladnie tam, gdzie go narysowano.
const BG_SOURCE_WIDTH = 1817
const BG_SOURCE_HEIGHT = 866

// Bialy pas miedzy wiencami zmierzony na grafice: wiersze 308-609 z 866,
// czyli 17,8-35,2 mm na karcie. Ramka tekstu trzyma sie tych krawedzi.
const TEXT_LEFT_MM = 10
const TEXT_WIDTH_MM = 85
const TEXT_TOP_MM = 18
const TEXT_HEIGHT_MM = 17

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

/** Tlo na cala strone. Zablokowane - ma jedna poprawna pozycje. */
function backgroundLayer(imageUrl: string) {
  return {
    id: 'tlo_botaniczne',
    name: 'Wieniec eukaliptusowy',
    type: 'background' as const,
    visible: true,
    locked: true,
    opacity: 1,
    zIndex: 0,
    x: mm(WIDTH_MM / 2),
    y: mm(HEIGHT_MM / 2),
    width: mm(WIDTH_MM),
    height: mm(HEIGHT_MM),
    rotation: 0,
    properties: {
      type: 'background' as const,
      imageUrl,
      fit: 'cover' as const,
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

function buildFrontLayers(backgroundImageUrl: string) {
  return [
    backgroundLayer(backgroundImageUrl),

    // 22 pt to nie ozdoba, tylko wynik pomiaru (registerFont + measureText na
    // pliku z rejestru): fabric lamie tekst po SPACJACH, wiec dwuczlonowe
    // nazwisko ("Wiśniewska-Kowalczyk", 20 znakow) jest jednym slowem i przy
    // 22 pt zajmuje 77 mm z 85 mm ramki. Przy 24 pt to juz 84 mm, czyli tekst
    // dotyka krawedzi ramki - renderer nie ma auto-dopasowania rozmiaru.
    textbox({
      id: GUEST_FIELD_KEY,
      name: 'Imię i nazwisko gościa',
      fieldKey: GUEST_FIELD_KEY,
      text: GUEST_PLACEHOLDER,
      leftMm: TEXT_LEFT_MM,
      topMm: TEXT_TOP_MM,
      widthMm: TEXT_WIDTH_MM,
      heightMm: TEXT_HEIGHT_MM,
      zIndex: 1,
      fontFamily: SERIF_FONT,
      fontSize: 22,
      fontWeight: 500,
      // 1,1 zamiast typowego 1,2: dwa wiersze (dlugie nazwisko) mieszcza sie
      // wtedy w 17 mm ramki, czyli nie wchodza w listki nad i pod pasem.
      lineHeight: 1.1,
      letterSpacing: 40,
      textAlign: 'center',
      verticalAlign: 'middle',
    }),
  ]
}

export function buildLayout(backgroundImageUrl: string) {
  const frontLayers = buildFrontLayers(backgroundImageUrl)

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
    // Mockup dodaje sie recznie w panelu - stad brak sekcji `mockups`.
    palette: ['#3e5648', '#688878', '#88a878', '#c8d8b8', '#e8e8d8'],
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

  const backgroundAsset = await ensureAsset({
    templateId: template.id,
    assetType: 'BACKGROUND',
    baseName: 'botaniczna-zielen',
    sourceEnv: 'BG_SOURCE',
    defaultSource: '/app/tmp/botaniczna-zielen.png',
    width: BG_SOURCE_WIDTH,
    height: BG_SOURCE_HEIGHT,
  })

  const layout = buildLayout(backgroundAsset.filePath)

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
        backgroundAsset: backgroundAsset.filePath,
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
