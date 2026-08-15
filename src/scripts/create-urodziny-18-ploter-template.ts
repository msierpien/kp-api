/**
 * Zaproszenie na 18. urodziny, 90 x 130 mm, z kokarda u gory - drukowane po
 * DWIE SZTUKI na arkuszu A4 i wycinane na ploterze Silhouette.
 *
 * Ten sam produkt fizyczny co `create-zaproszenie-90x130-ploter-template.ts`
 * (ten sam podklad, te same gniazda i pasery), inna tresc: zamiast formuly
 * slubnej mamy imie solenizantki, liczebnik pisany kaligrafia i zaproszenie
 * na przyjecie.
 *
 * Naglowek i liczebnik sa POLAMI, nie stalym napisem: dzieki temu ten sam
 * szablon obsluzy 18, 30 i 40 urodziny bez dotykania layoutu.
 *
 * Wszystkie pola sa SHARED - zaproszenie urodzinowe jest jedno dla calego
 * naboru gosci. Gdyby mialo byc imienne, `guest_name` trzeba dolozyc jako
 * INDIVIDUAL i znalezc dla niego miejsce w skladzie.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera):
 *   node dist/scripts/create-urodziny-18-ploter-template.js
 *   SHEET_BG_SOURCE=/tmp/czarne.png node dist/scripts/...
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'URODZINY_18_PLOTER'
const TEMPLATE_NAME = 'Urodziny 18 - kokarda (ploter)'
const TEMPLATE_DESCRIPTION =
  'Zaproszenie urodzinowe 90 x 130 mm z kokardą u góry, drukowane po dwie sztuki na arkuszu A4 z paserami Print & Cut, wycinane na ploterze Silhouette.'

const DPI = 300
const WIDTH_MM = 90
const HEIGHT_MM = 130

/**
 * Margines boczny projektu.
 *
 * Kartka lezy w drukowanym owalu, a nie na czystym prostokacie. Przy 10 mm
 * marginesu (ramka tekstu 70 mm) czyste wnetrze owalu siega w ukladzie kartki
 * od 8,0 do 123,5 mm - zmierzone na podkladzie, juz po uwzglednieniu obrotu
 * gniazda. Pierwsze 8 mm zajmuje kokarda.
 */
const MARGIN_MM = 10
const TEXT_WIDTH_MM = WIDTH_MM - MARGIN_MM * 2

/** Grafitowy atrament - czern na papierze ozdobnym wyglada twardo. */
const INK = '#2f3437'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Kroje z rejestru czcionek na serwerze (storage/fonts) - tylko takie
// node-canvas zarejestruje przy druku. Krój spoza rejestru wygladalby dobrze
// w podgladzie i cicho spadl na systemowy fallback na wydruku.
//
// Bodoni Moda SC jest kapitalikowy z natury, wiec naglowek nie potrzebuje
// zadnego `textTransform` - i ma komplet polskich znakow (sprawdzone
// renderem: Ś Ż Ę Ń Ó Ł roznia sie od odpowiednikow bez ogonkow).
const DISPLAY_FONT = 'Bodoni Moda SC'
const SCRIPT_FONT = 'Great Vibes'
const SERIF_FONT = 'Cormorant Garamond'

const FONTS = [
  { family: DISPLAY_FONT, src: 'fonts/BodoniModaSC-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SCRIPT_FONT, src: 'fonts/GreatVibes-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantGaramond-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantGaramond-Medium.ttf', weight: 500, style: 'normal' as const },
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
  maxLength?: number
}

const FIELDS: FieldInput[] = [
  {
    key: 'headline',
    label: 'Nagłówek',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 0,
    placeholder: 'OLA KOŃCZY',
    helpText: 'Wersaliki u góry. Krój jest kapitalikowy, więc małe litery i tak wyjdą jak wersaliki.',
    maxLength: 24,
  },
  {
    key: 'age_word',
    label: 'Liczebnik',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 1,
    placeholder: 'Osiemnaście',
    helpText: 'Kaligrafia pod nagłówkiem — słownie, np. Osiemnaście, Trzydzieści.',
    maxLength: 20,
  },
  {
    key: 'invite_text',
    label: 'Zaproszenie',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 2,
    placeholder: 'ZAPRASZAM NA PRZYJĘCIE URODZINOWE',
    maxLength: 60,
  },
  {
    key: 'event_date',
    label: 'Data i godzina',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 3,
    placeholder: 'Sobota, 5 października, o 14:00',
    maxLength: 60,
  },
  {
    key: 'event_place',
    label: 'Miejsce',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 4,
    placeholder: 'ul. Kwiatowa 12, Warszawa',
    maxLength: 80,
  },
  {
    key: 'rsvp_info',
    label: 'Potwierdzenie obecności',
    type: 'text',
    scope: 'SHARED',
    required: false,
    sortOrder: 5,
    placeholder: 'POTWIERDŹ: +48 123 456 789',
    maxLength: 60,
  },
]

type TextBoxInput = {
  id: string
  name: string
  text: string
  fieldKey?: string
  topMm: number
  heightMm: number
  zIndex: number
  fontFamily: string
  fontSize: number
  fontWeight?: number
  lineHeight?: number
  letterSpacing?: number
}

/** Ramka tekstu na pelna szerokosc kolumny; `x`/`y` to SRODEK ramki. */
function textbox(input: TextBoxInput) {
  return {
    id: input.id,
    name: input.name,
    type: 'textbox' as const,
    visible: true,
    locked: false,
    opacity: 1,
    zIndex: input.zIndex,
    x: mm(WIDTH_MM / 2),
    y: mm(input.topMm + input.heightMm / 2),
    width: mm(TEXT_WIDTH_MM),
    height: mm(input.heightMm),
    rotation: 0,
    properties: {
      type: 'textbox' as const,
      ...(input.fieldKey ? { fieldKey: input.fieldKey } : {}),
      text: input.text,
      fontFamily: input.fontFamily,
      fontSize: input.fontSize,
      fontUnit: 'pt' as const,
      fontWeight: input.fontWeight ?? 400,
      fontStyle: 'normal' as const,
      fill: INK,
      textAlign: 'center' as const,
      verticalAlign: 'middle' as const,
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

const canvasConfig = {
  width: mm(WIDTH_MM),
  height: mm(HEIGHT_MM),
  unit: 'mm' as const,
  widthMm: WIDTH_MM,
  heightMm: HEIGHT_MM,
  formatPreset: 'CUSTOM' as const,
  dpi: DPI,
  // Ploter tnie po paserach, nie po znakach ciecia, wiec spad nie ma tu kogo
  // ratowac - a wychodzilby na sasiedni uzytek na arkuszu.
  bleed: 0,
  safeArea: mm(4),
  bleedMm: 0,
  safeAreaMm: 4,
  // Przezroczyste, bo kartka laduje na WYDRUKOWANYM podkladzie z kokarda.
  // Biale tlo zamalowaloby go na calej powierzchni uzytku.
  backgroundColor: 'transparent',
}

const PAGE_ID = 'page-1'

/**
 * Rozmiary pisma pochodza z pomiaru (registerFont + measureText na plikach
 * z rejestru), nie z oka. Fabric lamie tekst tylko po SPACJACH, wiec liczy
 * sie najdluzsze pojedyncze SLOWO w ramce 70 mm:
 *   - "ALEKSANDRA" w 22 pt Bodoni ze swiatlem 60 = 58,6 mm (16% zapasu),
 *   - "Osiemnaście" w 42 pt Great Vibes = 53,8 mm (23% zapasu),
 *   - "URODZINOWE" w 11 pt Bodoni ze swiatlem 40 = 28,7 mm.
 * Renderer nie ma auto-dopasowania - wpis dluzszy niz ramka zostanie odrzucony
 * przez walidacje odpowiedzi ("Linia jest za długa"), nie zmniejszony.
 *
 * Pionowo tekst trzyma sie miedzy 20 a 110 mm kartki. Dolna granica czystego
 * wnetrza owalu to 123,5 mm, a gorne 8 mm zajmuje kokarda.
 */
function buildLayers() {
  return [
    textbox({
      id: 'headline',
      name: 'Nagłówek',
      fieldKey: 'headline',
      text: '{{ headline }}',
      topMm: 19,
      heightMm: 15,
      zIndex: 0,
      fontFamily: DISPLAY_FONT,
      fontSize: 22,
      // Wersaliki bez swiatla zlewaja sie w blok - 60 tysiecznych firetu
      // rozstrzela je na tyle, zeby napis oddychal, i nie wiecej: przy 90
      // dwuczlonowy naglowek nie miescilby sie juz w ramce.
      letterSpacing: 60,
    }),
    textbox({
      id: 'age_word',
      name: 'Liczebnik',
      fieldKey: 'age_word',
      text: '{{ age_word }}',
      topMm: 35,
      heightMm: 21,
      zIndex: 1,
      fontFamily: SCRIPT_FONT,
      fontSize: 42,
    }),
    textbox({
      id: 'invite_text',
      name: 'Zaproszenie',
      fieldKey: 'invite_text',
      text: '{{ invite_text }}',
      topMm: 60,
      heightMm: 13,
      zIndex: 2,
      fontFamily: DISPLAY_FONT,
      fontSize: 11,
      // Dwa wiersze wersalikow przy 1,35 nie sklejaja sie w pasek.
      lineHeight: 1.35,
      letterSpacing: 40,
    }),
    textbox({
      id: 'event_date',
      name: 'Data i godzina',
      fieldKey: 'event_date',
      text: '{{ event_date }}',
      topMm: 75,
      heightMm: 9,
      zIndex: 3,
      fontFamily: SERIF_FONT,
      fontSize: 12,
      fontWeight: 500,
    }),
    textbox({
      id: 'event_place',
      name: 'Miejsce',
      fieldKey: 'event_place',
      text: '{{ event_place }}',
      topMm: 86,
      heightMm: 12,
      zIndex: 4,
      fontFamily: DISPLAY_FONT,
      fontSize: 10,
      lineHeight: 1.35,
      letterSpacing: 30,
    }),
    textbox({
      id: 'rsvp_info',
      name: 'Potwierdzenie obecności',
      fieldKey: 'rsvp_info',
      text: '{{ rsvp_info }}',
      topMm: 101,
      heightMm: 9,
      zIndex: 5,
      fontFamily: DISPLAY_FONT,
      fontSize: 9,
      letterSpacing: 30,
    }),
  ]
}

/**
 * Gniazda na arkuszu A4 - srodki owali wydrukowanych na podkladzie.
 *
 * Owale zmierzone na podkladzie: 159,13 x 104,48 mm kazdy, srodki na
 * (100,86 / 75,01) i (100,86 / 195,03) mm. Uzytek wysrodkowany w owalu daje
 * wspolrzedne ponizej i miesci sie w polu wolnym od paserow (17,38-192,62 mm
 * w poziomie, 17,38-279,62 w pionie).
 */
const SLOT_X_MM = 35.86
const SLOT_Y_TOP_MM = 30.01
const SLOT_Y_BOTTOM_MM = 150.03

/**
 * Obrot uzytku w gniezdzie.
 *
 * Projekt jest pionowy (90 x 130), ramka na podkladzie lezy poziomo, wiec
 * uzytek wchodzi obrocony. 90 stopni, nie 270: przy tym kierunku gora kartki
 * trafia na PRAWA strone ramki, czyli tam, gdzie narysowana jest kokarda.
 */
const SLOT_ROTATION = 90 as const

export function buildLayout(sheetBackgroundUrl?: string) {
  const layers = buildLayers()

  return {
    version: 2 as const,
    // `canvas`/`layers` to lustro pierwszej strony - wymaga tego format
    // (withTemplatePages) i tego szuka kazdy starszy konsument.
    canvas: canvasConfig,
    fonts: FONTS,
    layers,
    pages: [{ id: PAGE_ID, name: 'Zaproszenie', canvas: canvasConfig, layers }],
    imposition: {
      enabled: true,
      sheet: { widthMm: 210, heightMm: 297 },
      slots: [
        { id: 'slot-1', xMm: SLOT_X_MM, yMm: SLOT_Y_TOP_MM, rotation: SLOT_ROTATION },
        { id: 'slot-2', xMm: SLOT_X_MM, yMm: SLOT_Y_BOTTOM_MM, rotation: SLOT_ROTATION },
      ],
      // Wartosci zmierzone na pliku ze Silhouette Studio (Print & Cut,
      // ustawienia domyslne). Nie zmieniac bez ponownego testu ciecia.
      marks: {
        preset: 'silhouette' as const,
        insetTopMm: 15.88,
        insetRightMm: 15.88,
        insetBottomMm: 15.88,
        insetLeftMm: 15.88,
        armLengthMm: 10,
        armLengthRightMm: 5,
        thicknessMm: 0.5,
        color: '#000000',
      },
      ...(sheetBackgroundUrl ? { backgroundUrl: sheetBackgroundUrl } : {}),
    },
    // Mockup dodaje sie recznie w panelu - stad brak sekcji `mockups`.
    palette: ['#2f3437', '#6b7280', '#a8a29e', '#d6d3d1', '#f5f5f4'],
  }
}

/**
 * Podklad arkusza w storage i rekord assetu - tylko gdy wskazano plik.
 *
 * Rozdziela pliki po typie assetu, wiec ponowne uruchomienie skryptu nie mnozy
 * kopii tego samego rysunku w katalogu szablonu.
 */
async function ensureSheetBackground(templateId: string) {
  const source = process.env.SHEET_BG_SOURCE
  const existing = await prisma.templateAsset.findFirst({
    where: { templateId, assetType: 'SHEET_BACKGROUND' },
  })
  if (existing) return existing
  if (!source) return null

  if (!fs.existsSync(source)) {
    throw new Error(`Brak pliku podkładu: ${source} (SHEET_BG_SOURCE)`)
  }
  const extension = path.extname(source).toLowerCase()
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) {
    throw new Error(`Podkład musi być PNG lub JPG - renderer nie czyta ${extension}`)
  }

  const buffer = fs.readFileSync(source)
  const fileName = `podklad-arkusza_${Date.now()}${extension}`
  const dirRelative = path.join('templates', TEMPLATE_CODE, 'sheet_background')
  const dir = path.join(process.cwd(), 'storage', dirRelative)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), buffer)

  return prisma.templateAsset.create({
    data: {
      templateId,
      assetType: 'SHEET_BACKGROUND',
      fileName,
      filePath: path.join(dirRelative, fileName),
      fileSize: buffer.length,
      mimeType: extension === '.png' ? 'image/png' : 'image/jpeg',
      metadata: { originalName: path.basename(source) },
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
      data: { templateId: template.id, name: 'Dane zaproszenia', sortOrder: 0, isActive: true },
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
      await prisma.formField.create({ data: { formId: form.id, key: field.key, ...data } })
    }
  }

  const wantedKeys = new Set(FIELDS.map((field) => field.key))
  const obsolete = existingFields.filter((field) => !wantedKeys.has(field.key))
  if (obsolete.length > 0) {
    await prisma.formField.deleteMany({ where: { id: { in: obsolete.map((field) => field.id) } } })
  }

  const sheetBackground = await ensureSheetBackground(template.id)
  const layout = buildLayout(sheetBackground?.filePath)

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
        sheetBackground: sheetBackground?.filePath ?? 'brak (same pasery)',
        arkusz: `${layout.imposition.sheet.widthMm} x ${layout.imposition.sheet.heightMm} mm`,
        gniazda: layout.imposition.slots.map((slot) => `${slot.id}: ${slot.xMm}, ${slot.yMm} mm, obrót ${slot.rotation}`),
        profilDruku: 'zaproszenia-a4-ploter',
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
