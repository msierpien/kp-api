/**
 * Zaproszenie dziecięce "STRAZAK" - karta A6 105 x 148 mm, akwarelowa grafika
 * strażacka, trzy strony:
 *   1. Przód  - arkusz z rekwizytami (hydrant, gaśnica, wóz, płomienie);
 *               SRODEK ZOSTAJE PUSTY, bo tam wchodzi doklejany krążek.
 *   2. Tył    - cała treść zaproszenia na czystym papierze, pas grafiki
 *               wchodzi dopiero od 112 mm.
 *   3. Krążek - OSOBNA strona 70 x 70 mm z danymi solenizanta, wycinana
 *               w koło i doklejana na środku przodu.
 *
 * Krążek jest osobną stroną, a nie kształtem na przodzie, bo drukuje się go
 * na innym podłożu i wycina osobno. Strony róznią się wymiarem, więc sklad
 * idzie w trybie `separate` - kazda strona na wlasnym arkuszu.
 *
 * Krążek nie ma TLA - sama typografia na bieli, jak na wzorcu od Michala.
 * Kolo powstaje przy wycinaniu, nie na wydruku: format nie zna masek ani
 * przycinania do kształtu, a `shape` renderer druku ignoruje. Jedyna grafika
 * na tej stronie to cienka kreska rozdzielajaca, rysowana tutaj do PNG -
 * warstwy `shape` nie byloby widac na papierze.
 *
 * Skrypt jest idempotentny: ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast zakladac drugi szablon o tym samym kodzie. UWAGA - nadpisze
 * takze poprawki naniesione recznie w edytorze.
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera). Grafiki bierze ze sciezek podanych w zmiennych
 * srodowiskowych:
 *   FRONT_SOURCE=/app/tmp/strazak-przod.png BACK_SOURCE=/app/tmp/strazak-tyl.png \
 *     node dist/scripts/create-strazak-template.js
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'STRAZAK'
const TEMPLATE_NAME = 'Strażak'
const TEMPLATE_DESCRIPTION =
  'Zaproszenie dziecięce 105 x 148 mm - akwarelowa grafika strażacka, przód i tył plus osobny krążek 70 x 70 mm z imieniem dziecka do doklejenia na środku.'

const DPI = 300
const WIDTH_MM = 105
const HEIGHT_MM = 148

/** Bok krążka; kolo jest wpisane w ten kwadrat, reszta strony zostaje biala. */
const BADGE_MM = 70

/** Ciemna szarosc z konturow rysunku - czern przy akwareli wyglada twardo. */
const INK = '#3f3a38'
/** Czerwien wozu i helmu - podpisy pomocnicze na karcie. */
const RED = '#e0392e'
/** Ciemniejsza, ceglana czerwien - cala typografia krążka. */
const BADGE_INK = '#8f2b22'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Krój z rejestru czcionek serwera (storage/fonts) - tylko takie node-canvas
// zarejestruje przy druku. Poppins ma tam komplet plikow STATYCZNYCH, wiec
// grubsze warianty naprawde sie drukuja; przy kroju zmiennym (Montserrat.ttf)
// node-canvas widzi wylacznie wage domyslna i kazdy naglowek wyszedlby cienki.
const SANS_FONT = 'Poppins'
/** Kaligrafia na imie solenizanta (krążek). */
const SCRIPT_FONT = 'Great Vibes'
/** Szeryf o duzym kontrascie - liczebnik i data na krążku. */
const SERIF_FONT = 'Playfair Display'

const FONTS = [
  { family: SANS_FONT, src: 'fonts/Poppins-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SANS_FONT, src: 'fonts/Poppins-Medium.ttf', weight: 500, style: 'normal' as const },
  { family: SANS_FONT, src: 'fonts/Poppins-SemiBold.ttf', weight: 600, style: 'normal' as const },
  { family: SANS_FONT, src: 'fonts/Poppins-Bold.ttf', weight: 700, style: 'normal' as const },
  { family: SCRIPT_FONT, src: 'fonts/GreatVibes-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/PlayfairDisplay-Bold.ttf', weight: 700, style: 'normal' as const },
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
 * Cala tresc idzie z odpowiedzi - na karcie nie zostaje nic do dopisania reka.
 *
 * `guest_name` jest jedynym polem PER SZTUKA: kazdy egzemplarz w zamowieniu
 * dostaje innego goscia, reszta zaproszenia jest wspolna.
 */
const FIELDS: FieldInput[] = [
  {
    key: 'guest_name',
    label: 'Kogo zapraszasz',
    type: 'text',
    scope: 'INDIVIDUAL',
    required: true,
    sortOrder: 1,
    defaultValue: 'Zosiu',
    // Zdanie brzmi "Zosiu, zapraszam Cie", wiec wolacz - system nie odmieni.
    helpText: 'Wołacz („Zosiu”, „Kubusiu”). Osobna treść dla każdego zaproszenia.',
    maxLength: 30,
  },
  {
    key: 'invite_line',
    label: 'Wiersz wstępny',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 2,
    defaultValue: 'zapraszam Cię na moją',
    maxLength: 40,
  },
  {
    key: 'occasion_line',
    label: 'Okazja',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 3,
    defaultValue: 'URODZINOWĄ AKCJĘ',
    helpText: 'Wersaliki - to najwiekszy napis na karcie.',
    maxLength: 24,
  },
  {
    key: 'age_line',
    label: 'Z jakiej okazji',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 4,
    defaultValue: 'z okazji 5. urodzin',
    maxLength: 40,
  },
  {
    key: 'party_datetime',
    label: 'Data i godzina',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 5,
    defaultValue: '12 września 2026, godz. 15:00',
    maxLength: 50,
  },
  {
    key: 'party_place',
    label: 'Miejsce',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 6,
    defaultValue: 'Sala zabaw „Iskierka”\nul. Wesoła 3, Kraków',
    helpText: 'Do dwóch wierszy - nazwa lokalu i adres.',
    maxLength: 70,
  },
  {
    key: 'rsvp_line',
    label: 'Potwierdzenie przybycia',
    type: 'text',
    scope: 'SHARED',
    required: false,
    sortOrder: 7,
    defaultValue: 'Potwierdź przybycie: Mama Ania 600 100 200',
    maxLength: 60,
  },
  {
    key: 'child_name',
    label: 'Krążek - imię dziecka',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 8,
    defaultValue: 'Oliwiera',
    // Napis czyta sie "Oliwiera PIEC latek", wiec dopelniacz - system nie odmieni.
    helpText: 'Dopełniacz, jak w zdaniu „Oliwiera pięć latek”: „Oliwiera”, „Zosi”, „Antka”.',
    maxLength: 16,
  },
  {
    key: 'badge_age_word',
    label: 'Krążek - wiek słownie',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 9,
    defaultValue: 'PIĘĆ',
    helpText: 'Wersaliki - to najwiekszy napis na krążku.',
    maxLength: 12,
  },
  {
    key: 'badge_age_unit',
    label: 'Krążek - odmiana „latek”',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 10,
    defaultValue: 'latek',
    helpText: 'Osobno, bo odmiana zalezy od liczby: „latek”, „lata”, „roczek”.',
    maxLength: 12,
  },
  {
    key: 'badge_occasion',
    label: 'Krążek - okazja',
    type: 'text',
    scope: 'SHARED',
    required: false,
    sortOrder: 11,
    defaultValue: 'Piąte urodziny',
    maxLength: 26,
  },
  {
    key: 'badge_date',
    label: 'Krążek - data',
    type: 'text',
    scope: 'SHARED',
    required: false,
    sortOrder: 12,
    defaultValue: '16 lipca 2027',
    maxLength: 22,
  },
  {
    key: 'badge_time',
    label: 'Krążek - godzina',
    type: 'text',
    scope: 'SHARED',
    required: false,
    sortOrder: 13,
    defaultValue: 'godzina 14:00',
    maxLength: 22,
  },
]

const defaults = Object.fromEntries(FIELDS.map((field) => [field.key, field.defaultValue ?? '']))

// ============================================
// Kanwy
// ============================================

/**
 * Spad 3 mm: strony roznia sie wymiarem, wiec druk idzie sciezka "kazda strona
 * na wlasnym arkuszu" - a ta spad honoruje (dokleja rozciagniete krawedzie).
 */
const cardCanvas = {
  width: mm(WIDTH_MM),
  height: mm(HEIGHT_MM),
  unit: 'mm' as const,
  widthMm: WIDTH_MM,
  heightMm: HEIGHT_MM,
  formatPreset: 'A6_105X148' as const,
  dpi: DPI,
  bleed: mm(3),
  safeArea: mm(5),
  bleedMm: 3,
  safeAreaMm: 5,
  backgroundColor: '#ffffff',
}

/**
 * Krążek bez spadu: kolo jest wpisane w kwadrat z bialym marginesem, wiec
 * przy wycinaniu nie ma czego doklejac za linia ciecia.
 */
const badgeCanvas = {
  width: mm(BADGE_MM),
  height: mm(BADGE_MM),
  unit: 'mm' as const,
  widthMm: BADGE_MM,
  heightMm: BADGE_MM,
  formatPreset: 'CUSTOM' as const,
  dpi: DPI,
  bleed: 0,
  safeArea: mm(4),
  bleedMm: 0,
  safeAreaMm: 4,
  backgroundColor: '#ffffff',
}

// ============================================
// Warstwy - pomocnicze konstruktory
// ============================================

/** Tlo na cala strone. `cover` przycina boki, bo rysunek jest szerszy niz A6. */
function backgroundLayer(id: string, name: string, imageUrl: string, widthMm: number, heightMm: number) {
  return {
    id,
    name,
    type: 'background' as const,
    visible: true,
    // Zablokowane: tlo ma jedna poprawna pozycje, a przypadkowe przeciagniecie
    // w edytorze widac dopiero na wydruku.
    locked: true,
    opacity: 1,
    zIndex: 0,
    x: mm(widthMm / 2),
    y: mm(heightMm / 2),
    width: mm(widthMm),
    height: mm(heightMm),
    rotation: 0,
    properties: {
      type: 'background' as const,
      imageUrl,
      fit: 'cover' as const,
    },
  }
}

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
  fontSize: number
  /** Krój; brak = Poppins. Musi byc w FONTS, inaczej druk podstawi systemowy. */
  fontFamily?: string
  /** Waga MUSI miec swoj plik w rejestrze - patrz FONTS. */
  fontWeight?: 400 | 500 | 600 | 700
  fill?: string
  lineHeight?: number
  letterSpacing?: number
  textAlign?: 'left' | 'center' | 'right'
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
      fontFamily: input.fontFamily ?? SANS_FONT,
      fontWeight: input.fontWeight ?? 400,
      fontStyle: 'normal' as const,
      fill: input.fill ?? INK,
      textAlign: input.textAlign ?? 'center',
      verticalAlign: input.verticalAlign ?? 'middle',
      lineHeight: input.lineHeight ?? 1.25,
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

// ============================================
// Strona 1 - przod
// ============================================
// Tylko rysunek. Srodek karty zostaje pusty CELOWO: tam trafia doklejany
// krążek ze strony 3 (fi 70 mm, czyli od 39 do 109 mm w pionie).

function frontLayers(backgroundUrl: string) {
  return [backgroundLayer('front_bg', 'Tło - przód', backgroundUrl, WIDTH_MM, HEIGHT_MM)]
}

// ============================================
// Strona 2 - tyl (tresc)
// ============================================
// Pas grafiki na tym rysunku zaczyna sie dopiero na 112 mm, wiec tekst ma
// czysty papier od gory do 105 mm.

const COLUMN_LEFT_MM = 12
const COLUMN_WIDTH_MM = WIDTH_MM - COLUMN_LEFT_MM * 2

function backLayers(backgroundUrl: string) {
  return [
    backgroundLayer('back_bg', 'Tło - tył', backgroundUrl, WIDTH_MM, HEIGHT_MM),

    textbox({
      id: 'guest_name',
      name: 'Gość',
      fieldKey: 'guest_name',
      text: defaults.guest_name,
      leftMm: COLUMN_LEFT_MM,
      topMm: 20,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 12,
      zIndex: 1,
      fontSize: 17,
      fontWeight: 600,
    }),

    textbox({
      id: 'invite_line',
      name: 'Wiersz wstępny',
      fieldKey: 'invite_line',
      text: defaults.invite_line,
      leftMm: COLUMN_LEFT_MM,
      topMm: 33,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 6,
      zIndex: 2,
      fontSize: 9,
    }),

    textbox({
      id: 'occasion_line',
      name: 'Okazja',
      fieldKey: 'occasion_line',
      text: defaults.occasion_line,
      leftMm: COLUMN_LEFT_MM,
      topMm: 40,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 11,
      zIndex: 3,
      fontSize: 12.5,
      fontWeight: 700,
      letterSpacing: 20,
      fill: RED,
    }),

    textbox({
      id: 'age_line',
      name: 'Z jakiej okazji',
      fieldKey: 'age_line',
      text: defaults.age_line,
      leftMm: COLUMN_LEFT_MM,
      topMm: 52,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 6,
      zIndex: 4,
      fontSize: 9,
    }),

    textbox({
      id: 'label_when',
      name: 'Podpis: ZBIÓRKA',
      text: 'ZBIÓRKA',
      leftMm: COLUMN_LEFT_MM,
      topMm: 63,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 5,
      zIndex: 5,
      fontSize: 7,
      fontWeight: 600,
      letterSpacing: 250,
      fill: RED,
    }),

    textbox({
      id: 'party_datetime',
      name: 'Data i godzina',
      fieldKey: 'party_datetime',
      text: defaults.party_datetime,
      leftMm: COLUMN_LEFT_MM,
      topMm: 68,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 8,
      zIndex: 6,
      fontSize: 10,
      fontWeight: 500,
    }),

    textbox({
      id: 'label_where',
      name: 'Podpis: MIEJSCE AKCJI',
      text: 'MIEJSCE AKCJI',
      leftMm: COLUMN_LEFT_MM,
      topMm: 79,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 5,
      zIndex: 7,
      fontSize: 7,
      fontWeight: 600,
      letterSpacing: 250,
      fill: RED,
    }),

    textbox({
      id: 'party_place',
      name: 'Miejsce',
      fieldKey: 'party_place',
      text: defaults.party_place,
      leftMm: COLUMN_LEFT_MM,
      topMm: 84,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 13,
      zIndex: 8,
      fontSize: 9.5,
      lineHeight: 1.35,
    }),

    textbox({
      id: 'rsvp_line',
      name: 'Potwierdzenie przybycia',
      fieldKey: 'rsvp_line',
      text: defaults.rsvp_line,
      leftMm: COLUMN_LEFT_MM,
      topMm: 99,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 6,
      zIndex: 9,
      fontSize: 8,
    }),
  ]
}

// ============================================
// Strona 3 - krążek z danymi solenizanta
// ============================================
// Bez tla i bez obreczy - sama typografia na bieli, jak na wzorcu. Kolo
// powstaje przy wycinaniu, wiec tresc trzymamy w kole o srednicy 56 mm:
// przy 70 mm strony zostaje 7 mm marginesu na niedokladnosc wykrojnika.
//
// Kolumna zwezа sie ku dolowi, bo ciecie idzie po luku - napis, ktory na
// wysokosci srodka miescilby sie swobodnie, przy dolnej krawedzi wyszedlby
// poza kolo.

const BADGE_COLUMN_LEFT_MM = 8
const BADGE_COLUMN_WIDTH_MM = BADGE_MM - BADGE_COLUMN_LEFT_MM * 2

function badgeText(input: {
  id: string
  name: string
  fieldKey: string
  topMm: number
  heightMm: number
  zIndex: number
  fontSize: number
  fontFamily?: string
  fontWeight?: 400 | 500 | 600 | 700
  letterSpacing?: number
  insetMm?: number
}) {
  const inset = input.insetMm ?? 0
  return textbox({
    id: input.id,
    name: input.name,
    fieldKey: input.fieldKey,
    text: defaults[input.fieldKey],
    leftMm: BADGE_COLUMN_LEFT_MM + inset,
    topMm: input.topMm,
    widthMm: BADGE_COLUMN_WIDTH_MM - inset * 2,
    heightMm: input.heightMm,
    zIndex: input.zIndex,
    fontSize: input.fontSize,
    fontFamily: input.fontFamily,
    fontWeight: input.fontWeight,
    letterSpacing: input.letterSpacing,
    fill: BADGE_INK,
  })
}

/** Kreska rozdzielajaca - szerokosc i wysokosc jak w wygenerowanym PNG. */
const BADGE_RULE_WIDTH_MM = 24
const BADGE_RULE_HEIGHT_MM = 0.6
const BADGE_RULE_TOP_MM = 41

function badgeLayers(ruleUrl: string) {
  return [
    badgeText({
      id: 'child_name',
      name: 'Imię dziecka',
      fieldKey: 'child_name',
      topMm: 6.5,
      heightMm: 14,
      zIndex: 0,
      fontSize: 30,
      fontFamily: SCRIPT_FONT,
    }),

    badgeText({
      id: 'badge_age_word',
      name: 'Wiek słownie',
      fieldKey: 'badge_age_word',
      topMm: 20,
      heightMm: 13,
      zIndex: 1,
      fontSize: 29,
      fontFamily: SERIF_FONT,
      fontWeight: 700,
      letterSpacing: 20,
    }),

    badgeText({
      id: 'badge_age_unit',
      name: 'Odmiana „latek”',
      fieldKey: 'badge_age_unit',
      topMm: 33,
      heightMm: 7,
      zIndex: 2,
      fontSize: 12,
      insetMm: 4,
    }),

    {
      id: 'badge_rule',
      name: 'Kreska rozdzielająca',
      type: 'image' as const,
      visible: true,
      locked: true,
      opacity: 1,
      zIndex: 3,
      x: mm(BADGE_MM / 2),
      y: mm(BADGE_RULE_TOP_MM + BADGE_RULE_HEIGHT_MM / 2),
      width: mm(BADGE_RULE_WIDTH_MM),
      height: mm(BADGE_RULE_HEIGHT_MM),
      rotation: 0,
      properties: {
        type: 'image' as const,
        imageUrl: ruleUrl,
        fit: 'fill' as const,
        lockAspectRatio: false,
      },
    },

    badgeText({
      id: 'badge_occasion',
      name: 'Okazja',
      fieldKey: 'badge_occasion',
      topMm: 43,
      heightMm: 7,
      zIndex: 4,
      fontSize: 10.5,
      insetMm: 4,
    }),

    badgeText({
      id: 'badge_date',
      name: 'Data',
      fieldKey: 'badge_date',
      topMm: 49.5,
      heightMm: 8,
      zIndex: 5,
      fontSize: 14,
      fontFamily: SERIF_FONT,
      fontWeight: 700,
      insetMm: 4,
    }),

    badgeText({
      id: 'badge_time',
      name: 'Godzina',
      fieldKey: 'badge_time',
      topMm: 57,
      heightMm: 7,
      zIndex: 6,
      fontSize: 10.5,
      insetMm: 8,
    }),
  ]
}

// ============================================
// Layout
// ============================================

export function buildLayout(frontUrl: string, backUrl: string, ruleUrl: string) {
  const pages = [
    { id: 'page-1', name: 'Przód', canvas: cardCanvas, layers: frontLayers(frontUrl) },
    { id: 'page-2', name: 'Tył - treść', canvas: cardCanvas, layers: backLayers(backUrl) },
    { id: 'page-3', name: 'Krążek z imieniem', canvas: badgeCanvas, layers: badgeLayers(ruleUrl) },
  ]

  return {
    version: 2 as const,
    // `canvas`/`layers` to lustro pierwszej strony - wymaga tego format.
    canvas: cardCanvas,
    fonts: FONTS,
    layers: pages[0].layers,
    pages,
    print: {
      sheet: { widthMm: WIDTH_MM, heightMm: HEIGHT_MM },
      placements: pages.map((page) => ({ pageId: page.id, xMm: 0, yMm: 0, rotation: 0 as const })),
      // Krążek ma inny wymiar niz karta, wiec skladanie stron na jeden arkusz
      // nie ma sensu - kazda strona idzie na wlasny arkusz.
      mode: 'separate' as const,
    },
    palette: [INK, RED, '#f6a03c', '#fbd17b', '#7fc8d8'],
  }
}

// ============================================
// Grafiki
// ============================================

const STORAGE_ROOT = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage')

function assetDir(assetType: string) {
  return path.join('templates', TEMPLATE_CODE, assetType.toLowerCase())
}

/** Zapisuje plik w storage i zaklada rekord assetu. */
async function saveAsset(options: {
  templateId: string
  assetType: 'DECORATION' | 'BACKGROUND'
  baseName: string
  buffer: Buffer
  width: number
  height: number
}) {
  const fileName = `${options.baseName}_${Date.now()}.png`
  const dirRelative = assetDir(options.assetType)
  const dir = path.join(STORAGE_ROOT, dirRelative)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, fileName), options.buffer)

  return prisma.templateAsset.create({
    data: {
      templateId: options.templateId,
      assetType: options.assetType,
      fileName,
      filePath: path.join(dirRelative, fileName),
      fileSize: options.buffer.length,
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
 * Asset po `fileName` - dzieki temu ponowne uruchomienie skryptu nie mnozy
 * kopii tego samego rysunku w katalogu szablonu.
 */
async function findAsset(templateId: string, assetType: 'DECORATION' | 'BACKGROUND', baseName: string) {
  return prisma.templateAsset.findFirst({
    where: { templateId, assetType, fileName: { startsWith: `${baseName}_` } },
  })
}

/** Kopiuje gotowa grafike tla do storage. */
async function ensureBackgroundAsset(options: {
  templateId: string
  baseName: string
  sourceEnv: string
  defaultSource: string
}) {
  const existing = await findAsset(options.templateId, 'BACKGROUND', options.baseName)
  if (existing) return existing

  const source = process.env[options.sourceEnv] || options.defaultSource
  if (!fs.existsSync(source)) {
    throw new Error(`Brak pliku grafiki: ${source} (ustaw ${options.sourceEnv})`)
  }

  const { loadImage } = await import('canvas')
  const buffer = fs.readFileSync(source)
  const image = await loadImage(buffer)

  return saveAsset({
    templateId: options.templateId,
    assetType: 'BACKGROUND',
    baseName: options.baseName,
    buffer,
    width: image.width,
    height: image.height,
  })
}

/**
 * Kreska rozdzielajaca na krążku, jako PNG w rozmiarze docelowym.
 *
 * Wlos w formacie mozna opisac tylko `shape`, a tego renderer druku nie rysuje -
 * na papierze zostalaby dziura miedzy blokami tekstu. Stad piksele.
 */
export async function drawBadgeRulePng(): Promise<{ buffer: Buffer; width: number; height: number }> {
  const { createCanvas } = await import('canvas')

  const width = mm(BADGE_RULE_WIDTH_MM)
  const height = mm(BADGE_RULE_HEIGHT_MM)
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  // Krycie zamiast jasniejszego koloru: kreska ma byc tym samym atramentem
  // co napisy, tylko cichszym.
  ctx.globalAlpha = 0.45
  ctx.fillStyle = BADGE_INK
  ctx.fillRect(0, 0, width, height)

  return { buffer: canvas.toBuffer('image/png'), width, height }
}

async function ensureRuleAsset(templateId: string) {
  const baseName = 'strazak-kreska'
  const existing = await findAsset(templateId, 'DECORATION', baseName)
  if (existing) return existing

  const { buffer, width, height } = await drawBadgeRulePng()

  return saveAsset({ templateId, assetType: 'DECORATION', baseName, buffer, width, height })
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
      data: { templateId: template.id, name: 'Zaproszenie strażackie', sortOrder: 0, isActive: true },
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

  const frontAsset = await ensureBackgroundAsset({
    templateId: template.id,
    baseName: 'strazak-przod',
    sourceEnv: 'FRONT_SOURCE',
    defaultSource: '/app/tmp/strazak-przod.png',
  })

  const backAsset = await ensureBackgroundAsset({
    templateId: template.id,
    baseName: 'strazak-tyl',
    sourceEnv: 'BACK_SOURCE',
    defaultSource: '/app/tmp/strazak-tyl.png',
  })

  const ruleAsset = await ensureRuleAsset(template.id)

  const layout = buildLayout(frontAsset.filePath, backAsset.filePath, ruleAsset.filePath)

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
        assets: {
          front: frontAsset.filePath,
          back: backAsset.filePath,
          kreska: ruleAsset.filePath,
        },
        pages: layout.pages.map((page) => ({
          id: page.id,
          name: page.name,
          mm: [page.canvas.widthMm, page.canvas.heightMm],
          layers: page.layers.length,
        })),
        printMode: layout.print.mode,
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
