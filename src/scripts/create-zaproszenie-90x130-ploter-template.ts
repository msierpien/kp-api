/**
 * Zaproszenie urodzinowe 90 x 130 mm, DWUSTRONNE, wycinane na ploterze
 * Silhouette.
 *
 * Kazda strona jedzie na WLASNY arkusz A4, po dwie sztuki na arkuszu:
 *   - arkusz przodow laduje na wydrukowanym podkladzie z falowana ramka
 *     i kokarda,
 *   - arkusz tylow jest czysty - sama tresc na bialym papierze.
 * Rozroznia je `imposition.pageBackgrounds`: strona tylu ma tam pusty wpis,
 * czyli swiadome "ten arkusz bez podkladu".
 *
 * Gniazda i pasery sa wspolne dla obu arkuszy, wiec ploter tnie oba tak samo.
 *
 * `guest_name` jest w zakresie INDIVIDUAL - to jedyne pole rozne dla kazdego
 * zaproszenia (imie gościa na tyle). Reszta jest wspolna dla calego naboru.
 *
 * Naglowki z liczba i imieniem sa POLAMI, wiec ten sam szablon obsluzy 18, 20
 * i 30 urodziny bez dotykania layoutu.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie. UWAGA: nadpisuje
 * rowniez zmiany zrobione recznie w panelu.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera):
 *   node dist/scripts/create-zaproszenie-90x130-ploter-template.js
 *   SHEET_BG_SOURCE=/tmp/czarne.png node dist/scripts/...
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'ZAPROSZENIE_90X130_PLOTER'
const TEMPLATE_NAME = 'Zaproszenie urodzinowe 90 x 130, dwustronne (ploter)'
const TEMPLATE_DESCRIPTION =
  'Dwustronne zaproszenie urodzinowe 90 x 130 mm. Przód na podkładzie z falowaną ramką i kokardą, tył na czystej kartce. Dwa arkusze A4 z paserami Print & Cut, wycinane na ploterze Silhouette.'

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
 *
 * Tyl trzyma sie tych samych granic mimo braku podkladu: ploter tnie go po
 * tym samym ksztalcie, wiec tekst poza owalem zostalby odciety.
 */
const MARGIN_MM = 10
const TEXT_WIDTH_MM = WIDTH_MM - MARGIN_MM * 2

/** Grafitowy atrament - czern na papierze ozdobnym wyglada twardo. */
const INK = '#2f3437'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Kroje z rejestru czcionek na serwerze (storage/fonts) - tylko takie
// node-canvas zarejestruje przy druku.
//
// Bodoni Moda SC jest kapitalikowy z natury, wiec wersaliki nie potrzebuja
// zadnego `textTransform`. Alex Brush to kaligrafia ze wzoru. Oba maja
// komplet polskich znakow (sprawdzone renderem glif po glifie).
const DISPLAY_FONT = 'Bodoni Moda SC'
const SCRIPT_FONT = 'Alex Brush'

const FONTS = [
  { family: DISPLAY_FONT, src: 'fonts/BodoniModaSC-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: DISPLAY_FONT, src: 'fonts/BodoniModaSC-Bold.ttf', weight: 700, style: 'normal' as const },
  { family: SCRIPT_FONT, src: 'fonts/AlexBrush-Regular.ttf', weight: 400, style: 'normal' as const },
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
    key: 'age_number',
    label: 'Liczba (przód)',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 0,
    placeholder: '20',
    helpText: 'Duża kaligrafia u góry przodu.',
    maxLength: 3,
  },
  {
    key: 'celebrant_genitive',
    label: 'Imię solenizantki (dopełniacz)',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 1,
    placeholder: 'Kasi',
    helpText: 'Wpisz w dopełniaczu — czyta się „urodziny Kasi”, nie „urodziny Kasia”.',
    maxLength: 24,
  },
  {
    key: 'front_date',
    label: 'Data na przodzie',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 2,
    placeholder: 'SOBOTA · 20 LISTOPADA · 17:00',
    helpText: 'Krótki wiersz u dołu przodu. Separator wstaw ręcznie, np. znakiem ·',
    maxLength: 44,
  },
  {
    key: GUEST_FIELD_KEY,
    label: 'Imię gościa (biernik)',
    type: 'text',
    // Jedyne pole per sztuka: panel wystawi tyle wpisow, ile zaproszen jest
    // w zamowieniu - to jest wlasnie lista gosci.
    scope: 'INDIVIDUAL',
    required: true,
    sortOrder: 3,
    placeholder: 'Annę Kowalską',
    helpText: 'Wpisz w bierniku — czyta się „zapraszam Annę Kowalską”.',
    maxLength: 30,
  },
  {
    key: 'invite_body',
    label: 'Treść zaproszenia',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 4,
    placeholder: 'na przyjęcie z okazji moich dwudziestych urodzin, które odbędzie się dnia',
    maxLength: 120,
  },
  {
    key: 'event_datetime',
    label: 'Data i godzina (tył)',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 5,
    placeholder: '20 LISTOPADA 2025 ROKU O GODZINIE 17:00',
    maxLength: 60,
  },
  {
    key: 'event_place',
    label: 'Miejsce',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 6,
    placeholder: 'w Restauracji Primma Vera w Warszawie.',
    maxLength: 80,
  },
  {
    key: 'signature',
    label: 'Podpis',
    type: 'text',
    scope: 'SHARED',
    required: false,
    sortOrder: 7,
    placeholder: 'Kasia',
    maxLength: 24,
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
  // Przezroczyste, bo przod laduje na WYDRUKOWANYM podkladzie z kokarda.
  // Biale tlo zamalowaloby go na calej powierzchni uzytku.
  backgroundColor: 'transparent',
}

const FRONT_PAGE_ID = 'page-1'
const BACK_PAGE_ID = 'page-2'

/**
 * PRZOD: liczba kaligrafia, slowo URODZINY, imie i wiersz z data.
 *
 * Rozmiary z pomiaru (registerFont + measureText), ramka 70 mm:
 *   - "20" w 60 pt Alex Brush = 25,9 mm,
 *   - "URODZINY" w 18 pt Bodoni ze swiatlem 80 = 37,8 mm,
 *   - "Aleksandry" (dlugie imie) w 38 pt Alex Brush = 57,9 mm,
 *   - wiersz z data w 9 pt ze swiatlem 30 = 50,4 mm.
 *
 * Pionowo blok trzyma sie miedzy 40 a 105 mm - wyzej jest kokarda z podkladu,
 * nizej falowana krawedz owalu.
 */
function buildFrontLayers() {
  return [
    textbox({
      id: 'age_number',
      name: 'Liczba',
      fieldKey: 'age_number',
      text: '{{ age_number }}',
      topMm: 40,
      heightMm: 18,
      zIndex: 0,
      fontFamily: SCRIPT_FONT,
      fontSize: 60,
    }),
    textbox({
      id: 'urodziny_slowo',
      name: 'Słowo „URODZINY”',
      text: 'URODZINY',
      topMm: 59,
      heightMm: 10,
      zIndex: 1,
      fontFamily: DISPLAY_FONT,
      fontSize: 18,
      // Wersaliki bez swiatla zlewaja sie w blok; 80 tysiecznych firetu daje
      // rozstrzelenie ze wzoru i nadal miesci sie w ramce.
      letterSpacing: 80,
    }),
    textbox({
      id: 'celebrant_genitive',
      name: 'Imię solenizantki',
      fieldKey: 'celebrant_genitive',
      text: '{{ celebrant_genitive }}',
      topMm: 69,
      heightMm: 17,
      zIndex: 2,
      fontFamily: SCRIPT_FONT,
      fontSize: 38,
    }),
    textbox({
      id: 'front_date',
      name: 'Data na przodzie',
      fieldKey: 'front_date',
      text: '{{ front_date }}',
      topMm: 95,
      heightMm: 9,
      zIndex: 3,
      fontFamily: DISPLAY_FONT,
      fontSize: 9,
      letterSpacing: 30,
    }),
  ]
}

/**
 * TYL: zaproszenie imienne, szczegoly i podpis.
 *
 * Rozmiary z pomiaru, ramka 70 mm:
 *   - "SERDECZNIE ZAPRASZAM" w 11 pt Bodoni bold ze swiatlem 40 = 55,3 mm,
 *   - "Annę Kowalską" w 26 pt Alex Brush = 52,9 mm,
 *   - wiersz z data w 8 pt bold ze swiatlem 20 = 66,7 mm.
 *
 * Ostatni jest na granicy, dlatego jego ramka ma wysokosc na DWA wiersze -
 * dluzsza data zawinie sie, zamiast zostac odrzucona przez walidacje.
 */
function buildBackLayers() {
  return [
    textbox({
      id: 'serdecznie_zapraszam',
      name: 'Nagłówek',
      text: 'SERDECZNIE ZAPRASZAM',
      topMm: 20,
      heightMm: 9,
      zIndex: 0,
      fontFamily: DISPLAY_FONT,
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: 40,
    }),
    textbox({
      id: GUEST_FIELD_KEY,
      name: 'Imię gościa',
      fieldKey: GUEST_FIELD_KEY,
      text: `{{ ${GUEST_FIELD_KEY} }}`,
      topMm: 31,
      heightMm: 16,
      zIndex: 1,
      fontFamily: SCRIPT_FONT,
      fontSize: 26,
    }),
    textbox({
      id: 'invite_body',
      name: 'Treść zaproszenia',
      fieldKey: 'invite_body',
      text: '{{ invite_body }}',
      topMm: 49,
      heightMm: 14,
      zIndex: 2,
      fontFamily: DISPLAY_FONT,
      fontSize: 8,
      lineHeight: 1.45,
      letterSpacing: 20,
    }),
    textbox({
      id: 'event_datetime',
      name: 'Data i godzina',
      fieldKey: 'event_datetime',
      text: '{{ event_datetime }}',
      topMm: 65,
      heightMm: 11,
      zIndex: 3,
      fontFamily: DISPLAY_FONT,
      fontSize: 8,
      fontWeight: 700,
      lineHeight: 1.45,
      letterSpacing: 20,
    }),
    textbox({
      id: 'event_place',
      name: 'Miejsce',
      fieldKey: 'event_place',
      text: '{{ event_place }}',
      topMm: 78,
      heightMm: 12,
      zIndex: 4,
      fontFamily: DISPLAY_FONT,
      fontSize: 8,
      lineHeight: 1.45,
      letterSpacing: 20,
    }),
    textbox({
      id: 'signature',
      name: 'Podpis',
      fieldKey: 'signature',
      text: '{{ signature }}',
      topMm: 96,
      heightMm: 15,
      zIndex: 5,
      fontFamily: SCRIPT_FONT,
      fontSize: 30,
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
 *
 * Te same gniazda obsluguja arkusz przodow i arkusz tylow - dzieki temu ploter
 * tnie oba tak samo.
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
  const frontLayers = buildFrontLayers()
  const backLayers = buildBackLayers()

  return {
    version: 2 as const,
    // `canvas`/`layers` to lustro pierwszej strony - wymaga tego format
    // (withTemplatePages) i tego szuka kazdy starszy konsument.
    canvas: canvasConfig,
    fonts: FONTS,
    layers: frontLayers,
    pages: [
      { id: FRONT_PAGE_ID, name: 'Przód', canvas: canvasConfig, layers: frontLayers },
      { id: BACK_PAGE_ID, name: 'Tył', canvas: canvasConfig, layers: backLayers },
    ],
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
      // Arkusz tylow jedzie na czystym papierze. Pusty wpis to swiadome
      // "bez podkladu", nie brak konfiguracji.
      pageBackgrounds: { [BACK_PAGE_ID]: '' },
    },
    // Mockup dodaje sie recznie w panelu - stad brak sekcji `mockups`.
    palette: ['#2f3437', '#6b7280', '#a8a29e', '#d6d3d1', '#f5f5f4'],
  }
}

/**
 * Podklad arkusza w storage i rekord assetu - tylko gdy wskazano plik.
 *
 * Istniejacy asset ma pierwszenstwo, wiec ponowne uruchomienie skryptu nie
 * mnozy kopii tego samego rysunku w katalogu szablonu.
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
        strony: layout.pages.map((page) => `${page.id} (${page.name}, ${page.layers.length} warstw)`),
        sheetBackground: sheetBackground?.filePath ?? 'brak (same pasery)',
        arkuszeNaSztuke: layout.pages.length,
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
