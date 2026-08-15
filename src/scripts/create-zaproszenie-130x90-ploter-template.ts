/**
 * Zaproszenie 130 x 90 mm drukowane po DWIE SZTUKI na arkuszu A4 i wycinane
 * na ploterze Silhouette.
 *
 * Roznica wobec pozostalych szablonow jest w skladzie, nie w projekcie: blok
 * `imposition` sprawia, ze paczka do druku ma jeden plik na ARKUSZ, nie na
 * sztuke, i dokleja pasery Print & Cut. Bez paserow ploter nie ma czego
 * szukac i tnie obok grafiki.
 *
 * `guest_name` jest w zakresie INDIVIDUAL, wiec panel poprosi o osobny wpis
 * dla kazdego zamowionego zaproszenia - to jest lista gosci. Reszta pol jest
 * wspolna dla calego zamowienia.
 *
 * Podklad arkusza (ozdobna ramka drukowana pod uzytkami) jest OPCJONALNY:
 * bez niego arkusz ma same pasery i uzytki. Renderer nie czyta PDF - podklad
 * musi byc PNG albo JPG o proporcji arkusza.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera):
 *   node dist/scripts/create-zaproszenie-130x90-ploter-template.js
 *   SHEET_BG_SOURCE=/app/tmp/podklad-a4.png node dist/scripts/...
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'ZAPROSZENIE_130X90_PLOTER'
const TEMPLATE_NAME = 'Zaproszenie 130 x 90 (ploter)'
const TEMPLATE_DESCRIPTION =
  'Zaproszenie 130 x 90 mm drukowane po dwie sztuki na arkuszu A4 z paserami Print & Cut, wycinane na ploterze Silhouette.'

const DPI = 300
const WIDTH_MM = 130
const HEIGHT_MM = 90

/**
 * Margines boczny projektu.
 *
 * Kartka lezy w drukowanym owalu z podkladu, a nie na czystym prostokacie.
 * Przy 20 mm marginesu (ramka tekstu 90 mm) czyste wnetrze owalu siega
 * pionowo od 2,8 do 87,0 mm kartki - zmierzone na podkladzie. Wezsza ramka
 * nic juz nie zyskuje, szersza (100 mm) traci 2,5 mm na dole.
 */
const MARGIN_MM = 20
const TEXT_WIDTH_MM = WIDTH_MM - MARGIN_MM * 2

/** Grafitowy atrament - czern na papierze ozdobnym wyglada twardo. */
const INK = '#2f3437'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Kroje z rejestru czcionek na serwerze (storage/fonts) - tylko takie
// node-canvas zarejestruje przy druku. Krój spoza rejestru wygladalby dobrze
// w podgladzie i cicho spadl na systemowy fallback na wydruku.
const SCRIPT_FONT = 'Great Vibes'
const SERIF_FONT = 'Cormorant Garamond'

const FONTS = [
  { family: SCRIPT_FONT, src: 'fonts/GreatVibes-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantGaramond-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantGaramond-Medium.ttf', weight: 500, style: 'normal' as const },
]

const GUEST_FIELD_KEY = 'guest_name'

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
    key: 'couple_names',
    label: 'Para młoda',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 0,
    placeholder: 'Aleksandra i Krzysztof',
    helpText: 'Imiona pary młodej — kaligrafia u góry zaproszenia.',
    maxLength: 40,
  },
  {
    key: GUEST_FIELD_KEY,
    label: 'Imiona gości',
    type: 'text',
    // Jedyne pole per sztuka: panel wystawi tyle wpisow, ile zaproszen jest
    // w zamowieniu - to jest wlasnie lista gosci.
    scope: 'INDIVIDUAL',
    required: true,
    sortOrder: 1,
    placeholder: 'Państwo Anna i Jan Nowakowscy',
    helpText: 'Osobny wpis dla każdego zaproszenia.',
    maxLength: 60,
  },
  {
    key: 'event_date',
    label: 'Data i godzina',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 2,
    placeholder: '15 sierpnia 2026, godzina 16:00',
    maxLength: 60,
  },
  {
    key: 'event_place',
    label: 'Miejsce uroczystości',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 3,
    placeholder: 'Kościół pw. Świętego Krzyża w Warszawie',
    maxLength: 90,
  },
  {
    key: 'rsvp_info',
    label: 'Potwierdzenie obecności',
    type: 'text',
    scope: 'SHARED',
    required: false,
    sortOrder: 4,
    placeholder: 'Prosimy o potwierdzenie do 1 lipca',
    maxLength: 80,
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
  textTransformUpper?: boolean
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
      // Bez `fieldKey` warstwa jest napisem stalym - klient jej nie rusza.
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
  // Przezroczyste, bo kartka laduje na WYDRUKOWANYM podkladzie z ozdobna
  // ramka. Biale tlo zamalowaloby ja na calej powierzchni uzytku.
  backgroundColor: 'transparent',
}

const PAGE_ID = 'page-1'

/**
 * Rozmiary pisma pochodza z pomiaru (registerFont + measureText na plikach
 * z rejestru), nie z oka. Fabric lamie tekst tylko po SPACJACH, wiec liczy
 * sie najdluzsze pojedyncze SLOWO w ramce 90 mm:
 *   - "Wiśniewska-Kowalczyk" w 20 pt Cormorant = 64,5 mm (28% zapasu),
 *   - "Aleksandra i Krzysztof" w 28 pt Great Vibes = 75,2 mm (16% zapasu).
 * Renderer nie ma auto-dopasowania - wpis dluzszy niz ramka zostanie odrzucony
 * przez walidacje odpowiedzi ("Linia jest za długa"), nie zmniejszony.
 *
 * Pionowo wszystko musi zmiescic sie miedzy 2,8 a 87,0 mm kartki - tyle
 * wynosi czyste wnetrze drukowanego owalu przy ramce 90 mm.
 */
function buildLayers() {
  return [
    textbox({
      id: 'naglowek',
      name: 'Nagłówek',
      text: 'ZAPROSZENIE',
      topMm: 12,
      heightMm: 7,
      zIndex: 0,
      fontFamily: SERIF_FONT,
      fontSize: 11,
      // Wersaliki bez swiatla zlewaja sie w blok - 120 tysiecznych firetu
      // rozstrzela je na tyle, zeby napis oddychal.
      letterSpacing: 120,
    }),
    textbox({
      id: 'couple_names',
      name: 'Para młoda',
      fieldKey: 'couple_names',
      text: '{{ couple_names }}',
      topMm: 20,
      heightMm: 15,
      zIndex: 1,
      fontFamily: SCRIPT_FONT,
      fontSize: 28,
    }),
    textbox({
      id: 'zaproszenie_tresc',
      name: 'Formuła zaproszenia',
      // Formula scalona w jeden wiersz - kartka 90 mm wysokosci nie uniesie
      // dwoch osobnych, a rozbicie ich wpychalo "Nowakowscy" na wiersz nizej.
      text: 'mają zaszczyt zaprosić na uroczystość zaślubin',
      topMm: 36,
      heightMm: 6,
      zIndex: 2,
      fontFamily: SERIF_FONT,
      fontSize: 9,
    }),
    textbox({
      id: GUEST_FIELD_KEY,
      name: 'Imiona gości',
      fieldKey: GUEST_FIELD_KEY,
      text: `{{ ${GUEST_FIELD_KEY} }}`,
      topMm: 43,
      heightMm: 19,
      zIndex: 3,
      fontFamily: SERIF_FONT,
      fontSize: 20,
      fontWeight: 500,
      // 1,15 zamiast typowego 1,2: dwa wiersze dlugiego wpisu ("Państwo Anna
      // i Jan Nowakowscy") mieszcza sie wtedy w 17 mm ramki.
      lineHeight: 1.15,
    }),
    textbox({
      id: 'event_date',
      name: 'Data i godzina',
      fieldKey: 'event_date',
      text: '{{ event_date }}',
      topMm: 64,
      heightMm: 7,
      zIndex: 4,
      fontFamily: SERIF_FONT,
      fontSize: 12,
      fontWeight: 500,
    }),
    textbox({
      id: 'event_place',
      name: 'Miejsce uroczystości',
      fieldKey: 'event_place',
      text: '{{ event_place }}',
      topMm: 71,
      heightMm: 9,
      zIndex: 5,
      fontFamily: SERIF_FONT,
      fontSize: 12,
    }),
    textbox({
      id: 'rsvp_info',
      name: 'Potwierdzenie obecności',
      fieldKey: 'rsvp_info',
      text: '{{ rsvp_info }}',
      topMm: 80,
      heightMm: 6,
      zIndex: 6,
      fontFamily: SERIF_FONT,
      fontSize: 9,
    }),
  ]
}

/**
 * Gniazda na arkuszu A4 - srodki owali wydrukowanych na podkladzie.
 *
 * Owale zmierzone na podkladzie: 159,13 x 104,48 mm kazdy, srodki na
 * (100,86 / 75,01) i (100,86 / 195,03) mm. Kartka 130 x 90 wysrodkowana
 * w owalu daje wspolrzedne ponizej i miesci sie w polu wolnym od paserow
 * (17,38-192,62 mm w poziomie, 17,38-279,62 w pionie).
 *
 * Te wspolrzedne to punkt wyjscia. Ostateczne ustawia sie w panelu, w oknie
 * "Arkusz", po probnym wydruku i probnym cieciu.
 */
const SLOT_X_MM = 35.86
const SLOT_Y_TOP_MM = 30.01
const SLOT_Y_BOTTOM_MM = 150.03

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
        { id: 'slot-1', xMm: SLOT_X_MM, yMm: SLOT_Y_TOP_MM, rotation: 0 as const },
        { id: 'slot-2', xMm: SLOT_X_MM, yMm: SLOT_Y_BOTTOM_MM, rotation: 0 as const },
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
 * Rozdziela pliki po `fileName`, wiec ponowne uruchomienie skryptu nie mnozy
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
        gniazda: layout.imposition.slots.map((slot) => `${slot.id}: ${slot.xMm}, ${slot.yMm} mm`),
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
