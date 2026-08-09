/**
 * Zaproszenie "ZAPROSZENIE_12X17" - jednostronna karta 120 x 170 mm,
 * uklad wysrodkowany: grafika u gory, pod nia kolumna tresci od zwrotu
 * wprowadzajacego po odreczny podpis.
 *
 * GRAFIKI NIE MA - gorne 72 mm strony zostaje CELOWO PUSTE. Ilustracje
 * (mis, balony, kwiaty) dokladamy recznie w edytorze jako warstwe `image`
 * z assetem DECORATION; pierwsza warstwa tekstowa zaczyna sie dopiero na
 * 75 mm, wiec grafika ma caly ten pas dla siebie.
 *
 * Wszystkie warstwy tekstowe maja `fieldKey`, wiec KAZDA jest edytowalna
 * przez klienta w portalu - tresci "stale" (SERDECZNIE ZAPRASZAM, okazja,
 * podpis) siedza w `defaultValue` pol formularza i klient moze je nadpisac.
 *
 * Pole `guest_names` jest jedynym w zakresie INDIVIDUAL: portal wystawi tyle
 * wpisow, ile zaproszen jest w zamowieniu - to jest lista gosci.
 *
 * Dol karty to PAS TRZECH KOLUMN rozdzielonych kropkowanymi kreskami:
 * data | miejsce | godzina. Data i godzina sa OSOBNYMI polami, bo renderer
 * podstawia cala odpowiedz w jedno miejsce - jedno pole nie zasililoby dwoch
 * kolumn. Data to pole `date` z regula `pl-slash`: klient wybiera ja
 * z kalendarza, a w odpowiedzi laduje gotowy zapis "07/09" + rok w drugim
 * wierszu (renderer drukuje wartosci pol doslownie i nie zna regul
 * jezykowych). Rok dostaje mniejszy stopien pisma przez `styleRanges`.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie. UWAGA: nadpisze
 * tez recznie naniesione poprawki z edytora - do doszywania zmian sluza
 * skrypty doszywajace (wzor: `roczek-add-rsvp.ts`).
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera); lokalnie: pnpm tsx src/scripts/create-zaproszenie-roczek-template.ts
 */
import fs from 'fs'
import path from 'path'
import { Prisma, PrismaClient } from '@prisma/client'
import { createCanvas } from 'canvas'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'ZAPROSZENIE_12X17'
const TEMPLATE_NAME = 'Zaproszenie 12 x 17'
const TEMPLATE_DESCRIPTION =
  'Zaproszenie 120 x 170 mm - miejsce na grafikę w górnej części (72 mm), pod nią kolumna treści i pas trzech kolumn: data z kalendarza, miejsce przyjęcia i godzina, rozdzielone kropkowanymi kreskami.'

const DPI = 300
const WIDTH_MM = 120
const HEIGHT_MM = 170

/** Ciemny braz zamiast czerni - przy akwareli czarny tusz wyglada twardo. */
const INK = '#3d3630'
/** Rozstrzelone wersaliki sa jasniejsze od nazwisk i daty. */
const INK_SOFT = '#6b625a'
/** Pismo odreczne - cieplejsze i jasniejsze od reszty. */
const INK_SCRIPT = '#4a423a'

/** Milimetry na piksele projektu. Format zyje w mm, renderer w px. */
const mm = (value: number) => Math.round((value / 25.4) * DPI)

// Kroje z rejestru czcionek serwera (storage/fonts) - tylko te node-canvas
// zarejestruje przy druku. Krój spoza rejestru daje ladny podglad w panelu
// i systemowy fallback na wydruku.
const SERIF_FONT = 'Cormorant Infant'
const SCRIPT_FONT = 'Bonheur Royale'

const FONTS = [
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Regular.ttf', weight: 400, style: 'normal' as const },
  { family: SERIF_FONT, src: 'fonts/CormorantInfant-Light.ttf', weight: 300, style: 'normal' as const },
  { family: SCRIPT_FONT, src: 'fonts/BonheurRoyale-Regular.ttf', weight: 400, style: 'normal' as const },
]

// --- Uklad -------------------------------------------------------------
// Grafika dostaje gorne 72 mm, kolumna tekstu biegnie od 75 mm do 165 mm
// (5 mm strefy bezpiecznej przy dolnej krawedzi).
const GRAPHIC_AREA_BOTTOM_MM = 72
const COLUMN_LEFT_MM = 12
const COLUMN_WIDTH_MM = WIDTH_MM - 2 * COLUMN_LEFT_MM

// --- Pas data | miejsce | godzina --------------------------------------
// Trzy kolumny symetryczne wzgledem srodka karty (60 mm), rozdzielone
// kropkowanymi kreskami. Kolumny boczne sa rowne, srodkowa dostaje adres.
const BAND_TOP_MM = 119
const BAND_HEIGHT_MM = 19
const BAND_LEFT_COL_MM = 6
const BAND_SIDE_WIDTH_MM = 32
const BAND_RULE_1_MM = 42
const BAND_MIDDLE_COL_MM = 46
const BAND_MIDDLE_WIDTH_MM = 28
const BAND_RULE_2_MM = 78
const BAND_RIGHT_COL_MM = 82

/** Kreska: szerokosc w pikselach projektu i wysokosc w milimetrach. */
const RULE_WIDTH_PX = 6
const RULE_HEIGHT_MM = 17

/**
 * Rok w odpowiedzi daty - zakres znakow w zapisie "07/09\n2028".
 *
 * Format ma STALA dlugosc (5 znakow, znak nowej linii, 4 cyfry), wiec zakres
 * nie rozjedzie sie z trescia. `resolveCharStyles` i tak przycina zakresy do
 * dlugosci tekstu, wiec krotsza odpowiedz niczego nie wywroci.
 */
const DATE_YEAR_FROM = 6
const DATE_YEAR_TO = 10

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
  /** Lista wyboru - trafia do `optionsJson`. */
  options?: string[]
  /** Reguly pola - dla `date` decyduja o kalendarzu i formacie odpowiedzi. */
  validationRules?: Prisma.InputJsonObject
}

const FIELDS: FieldInput[] = [
  {
    key: 'intro_text',
    label: 'Zwrot wprowadzający',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 1,
    defaultValue: 'SERDECZNIE ZAPRASZAM',
    helpText: 'Wersaliki - krój nie zamienia liter automatycznie.',
    maxLength: 30,
  },
  {
    key: 'guest_names',
    label: 'Zapraszani goście',
    type: 'text',
    // Jedyne pole per sztuka: portal wystawi tyle wpisow, ile zaproszen jest
    // w zamowieniu - to jest lista gosci.
    scope: 'INDIVIDUAL',
    required: true,
    sortOrder: 2,
    defaultValue: 'Babcię Zosię i Dziadka Tadeusza',
    placeholder: 'np. Babcię Zosię i Dziadka Tadeusza',
    // Zdanie brzmi "zapraszam KOGO", wiec biernik - system nie odmieni.
    helpText:
      'Biernik („Babcię Zosię i Dziadka Tadeusza”, „Państwa Kowalskich”). Osobna treść dla każdego zaproszenia w zamówieniu.',
    maxLength: 60,
  },
  {
    key: 'occasion_text',
    label: 'Okazja',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 3,
    defaultValue: 'NA PRZYJĘCIE Z OKAZJI MOICH',
    helpText: 'Wersaliki. Zdanie kończy napis odręczny poniżej.',
    maxLength: 40,
  },
  {
    key: 'celebration_script',
    label: 'Napis odręczny (okazja)',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 4,
    defaultValue: 'Pierwszych Urodzin',
    helpText: 'Jeden wiersz pismem odręcznym - dopełnienie zdania z okazją.',
    maxLength: 28,
  },
  {
    key: 'party_date',
    label: 'Data przyjęcia',
    type: 'date',
    scope: 'SHARED',
    required: true,
    sortOrder: 5,
    // Zapis dwuwierszowy, a nie ISO ani zdanie: w waskiej kolumnie stoi
    // "07/09" nad "2028". Dlugosc pierwszego wiersza jest stala, wiec rok
    // dostaje mniejszy stopien pisma zakresem znakow (patrz DATE_YEAR_RANGE).
    defaultValue: '07/09\n2028',
    helpText: 'Kalendarz - na zaproszeniu pojawi się dzień z miesiącem, a pod spodem rok.',
    validationRules: { dateFormat: 'pl-slash', withTime: false },
  },
  {
    key: 'party_time',
    label: 'Godzina przyjęcia',
    type: 'select',
    scope: 'SHARED',
    required: true,
    sortOrder: 6,
    defaultValue: '12:00',
    // Lista pelnych i polowkowych godzin z furtka na wlasny wpis - godzina
    // stoi w OSOBNEJ kolumnie karty, wiec nie moze przyjsc z kalendarza daty.
    options: [
      '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
      '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30',
      '18:00', '18:30', '19:00', '19:30', '20:00',
    ],
    validationRules: { allowCustom: true },
    helpText: 'Wybierz z listy albo wpisz własną godzinę.',
    maxLength: 10,
  },
  {
    key: 'time_label',
    label: 'Podpis pod godziną',
    type: 'text',
    scope: 'SHARED',
    required: false,
    sortOrder: 7,
    defaultValue: 'godzina',
    helpText: 'Drobny wiersz pod godziną. Puste pole zostawia samą godzinę.',
    maxLength: 20,
  },
  {
    key: 'party_place',
    label: 'Miejsce przyjęcia',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 8,
    defaultValue: 'Restauracja\n„Żółty Parasol”\nul. Książęca 15,\nSzczytno',
    helpText: 'Środkowa kolumna jest wąska - rozbij adres na 3-4 krótkie wiersze.',
    maxLength: 90,
  },
  {
    key: 'rsvp_text',
    label: 'Potwierdzenie przybycia',
    type: 'textarea',
    scope: 'SHARED',
    // Nieobowiazkowe: nie kazde przyjecie prosi o potwierdzenie, a puste pole
    // ma po prostu zostawic ten pas karty pusty.
    required: false,
    sortOrder: 9,
    defaultValue: 'Prosimy o potwierdzenie przybycia do 05.08.2028\nMama: +48 500 500 500',
    helpText: 'Dwa wiersze. Puste pole zostawia ten pas karty pusty.',
    maxLength: 120,
  },
  {
    key: 'signature_name',
    label: 'Podpis - imię',
    type: 'text',
    scope: 'SHARED',
    required: true,
    sortOrder: 10,
    defaultValue: 'Hania',
    helpText: 'Jedno imię - pismem odręcznym, największy napis w stopce.',
    maxLength: 20,
  },
  {
    key: 'signature_suffix',
    label: 'Podpis - dopisek',
    type: 'text',
    scope: 'SHARED',
    required: false,
    sortOrder: 11,
    defaultValue: 'wraz z Rodzicami',
    helpText: 'Drobniejszy wiersz pod imieniem. Puste pole zostawia sam podpis.',
    maxLength: 30,
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
  /** Style fragmentow - zakresy liczone na SUROWYM tekscie warstwy. */
  styleRanges?: Array<{ start: number; end: number; fontSize?: number; fill?: string }>
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
      ...(input.styleRanges ? { styleRanges: input.styleRanges } : {}),
      editable: Boolean(input.fieldKey),
      clientDraggable: false,
      clientResizable: false,
      clientRotatable: false,
    },
  }
}

/**
 * Pionowa kreska rozdzielajaca kolumny pasa.
 *
 * Warstwa `shape` odpada - renderer druku jej nie rysuje. Kropki sa wypalone
 * w PNG, ktory obie kreski wspoldziela.
 */
function separatorLayer(input: { id: string; name: string; imageUrl: string; leftMm: number; zIndex: number }) {
  return {
    id: input.id,
    name: input.name,
    type: 'image' as const,
    visible: true,
    locked: true,
    opacity: 1,
    zIndex: input.zIndex,
    x: mm(input.leftMm),
    y: mm(BAND_TOP_MM + BAND_HEIGHT_MM / 2),
    width: RULE_WIDTH_PX,
    height: mm(RULE_HEIGHT_MM),
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

/**
 * Kolumna tresci pod grafika.
 *
 * Wszystko jest wysrodkowane i trzyma te sama szerokosc - kolejnosc pionowa
 * odczytuje sie jak zdanie: kto zaprasza kogo, na co, kiedy, gdzie.
 * Wysokosci ramek maja zapas na drugi (a przy miejscu - trzeci) wiersz;
 * tekst jest w ramce wysrodkowany pionowo, wiec zapas rozklada sie rowno.
 */
function buildLayers(separatorImageUrl: string) {
  return [
    textbox({
      id: 'intro_text',
      name: 'Zwrot wprowadzający',
      fieldKey: 'intro_text',
      text: defaults.intro_text,
      leftMm: COLUMN_LEFT_MM,
      topMm: 75,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 6,
      zIndex: 0,
      fontFamily: SERIF_FONT,
      fontSize: 7.5,
      fill: INK_SOFT,
      letterSpacing: 150,
      textAlign: 'center',
    }),

    textbox({
      id: 'guest_names',
      name: 'Zapraszani goście',
      fieldKey: 'guest_names',
      text: defaults.guest_names,
      leftMm: COLUMN_LEFT_MM,
      topMm: 83,
      widthMm: COLUMN_WIDTH_MM,
      // Dwa wiersze zapasu - "Ciocię Anię z Rodziną i Babcię Halinkę" nie
      // zmiesci sie w jednej linii.
      heightMm: 12,
      zIndex: 1,
      fontFamily: SERIF_FONT,
      fontSize: 12.5,
      letterSpacing: 40,
      lineHeight: 1.4,
      textAlign: 'center',
    }),

    textbox({
      id: 'occasion_text',
      name: 'Okazja',
      fieldKey: 'occasion_text',
      text: defaults.occasion_text,
      leftMm: COLUMN_LEFT_MM,
      topMm: 96,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 6,
      zIndex: 2,
      fontFamily: SERIF_FONT,
      fontSize: 7.5,
      fill: INK_SOFT,
      letterSpacing: 150,
      textAlign: 'center',
    }),

    textbox({
      id: 'celebration_script',
      name: 'Napis odręczny (okazja)',
      fieldKey: 'celebration_script',
      text: defaults.celebration_script,
      leftMm: COLUMN_LEFT_MM,
      topMm: 100.5,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 15,
      zIndex: 3,
      fontFamily: SCRIPT_FONT,
      fontSize: 30,
      fill: INK_SCRIPT,
      lineHeight: 1,
      textAlign: 'center',
    }),

    // --- Pas: data | miejsce | godzina -------------------------------
    // Trzy kolumny rozdzielone kropkowanymi kreskami, jak na wzorcu. Data
    // i godzina to osobne pola formularza, bo renderer podstawia CALA
    // odpowiedz w jedno miejsce - jedno pole nie zasili dwoch kolumn.

    separatorLayer({ id: 'band_rule_left', name: 'Kreska lewa', imageUrl: separatorImageUrl, leftMm: BAND_RULE_1_MM, zIndex: 4 }),
    separatorLayer({ id: 'band_rule_right', name: 'Kreska prawa', imageUrl: separatorImageUrl, leftMm: BAND_RULE_2_MM, zIndex: 5 }),

    // "07/09" duze, rok pod spodem drobniej - jeden zapis, dwa stopnie pisma.
    // Zakres znakow jest staly, bo format daty ma stala dlugosc.
    textbox({
      id: 'party_date',
      name: 'Data przyjęcia',
      fieldKey: 'party_date',
      text: defaults.party_date,
      leftMm: BAND_LEFT_COL_MM,
      topMm: BAND_TOP_MM,
      widthMm: BAND_SIDE_WIDTH_MM,
      heightMm: BAND_HEIGHT_MM,
      zIndex: 6,
      fontFamily: SERIF_FONT,
      fontSize: 19,
      lineHeight: 1.25,
      letterSpacing: 20,
      textAlign: 'center',
      styleRanges: [{ start: DATE_YEAR_FROM, end: DATE_YEAR_TO, fontSize: 10, fill: INK_SOFT }],
    }),

    textbox({
      id: 'party_place',
      name: 'Miejsce przyjęcia',
      fieldKey: 'party_place',
      text: defaults.party_place,
      leftMm: BAND_MIDDLE_COL_MM,
      topMm: BAND_TOP_MM,
      widthMm: BAND_MIDDLE_WIDTH_MM,
      heightMm: BAND_HEIGHT_MM,
      zIndex: 7,
      fontFamily: SERIF_FONT,
      fontSize: 7.5,
      fill: INK_SOFT,
      letterSpacing: 80,
      lineHeight: 1.6,
      textAlign: 'center',
    }),

    // Godzina i jej podpis to dwie warstwy, a nie jeden dwuwierszowy napis:
    // stopnie pisma sa rozne, a podpis ma zostac, gdy klient zmieni godzine.
    textbox({
      id: 'party_time',
      name: 'Godzina przyjęcia',
      fieldKey: 'party_time',
      text: defaults.party_time,
      leftMm: BAND_RIGHT_COL_MM,
      topMm: BAND_TOP_MM,
      widthMm: BAND_SIDE_WIDTH_MM,
      heightMm: 9,
      zIndex: 8,
      fontFamily: SERIF_FONT,
      fontSize: 19,
      lineHeight: 1,
      letterSpacing: 20,
      textAlign: 'center',
    }),

    textbox({
      id: 'time_label',
      name: 'Podpis pod godziną',
      fieldKey: 'time_label',
      text: defaults.time_label,
      leftMm: BAND_RIGHT_COL_MM,
      // Rok w kolumnie daty siada nizej niz sam podpis w ramce stykajacej sie
      // z godzina - stad 10,5 mm zamiast wysokosci ramki godziny.
      topMm: BAND_TOP_MM + 10.5,
      widthMm: BAND_SIDE_WIDTH_MM,
      heightMm: 6,
      zIndex: 9,
      fontFamily: SERIF_FONT,
      fontSize: 10,
      fill: INK_SOFT,
      lineHeight: 1,
      textAlign: 'center',
    }),

    textbox({
      id: 'rsvp_text',
      name: 'Potwierdzenie przybycia',
      fieldKey: 'rsvp_text',
      text: defaults.rsvp_text,
      leftMm: COLUMN_LEFT_MM,
      topMm: 144,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 9,
      zIndex: 6,
      fontFamily: SERIF_FONT,
      fontSize: 7,
      fill: INK_SOFT,
      letterSpacing: 120,
      lineHeight: 1.7,
      textAlign: 'center',
    }),

    // Podpis to DWIE warstwy, a nie jeden dwuwierszowy napis: imie ma byc
    // wyraznie wieksze od dopisku, a jedna ramka niesie jeden stopien pisma.
    textbox({
      id: 'signature_name',
      name: 'Podpis - imię',
      fieldKey: 'signature_name',
      text: defaults.signature_name,
      leftMm: COLUMN_LEFT_MM,
      topMm: 150.5,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 11,
      zIndex: 7,
      fontFamily: SCRIPT_FONT,
      fontSize: 24,
      fill: INK_SCRIPT,
      lineHeight: 1,
      textAlign: 'center',
    }),

    textbox({
      id: 'signature_suffix',
      name: 'Podpis - dopisek',
      fieldKey: 'signature_suffix',
      text: defaults.signature_suffix,
      leftMm: COLUMN_LEFT_MM,
      topMm: 159.8,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 6,
      zIndex: 8,
      fontFamily: SCRIPT_FONT,
      fontSize: 12,
      fill: INK_SCRIPT,
      lineHeight: 1,
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

export function buildLayout(separatorImageUrl: string) {
  const layers = buildLayers(separatorImageUrl)

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
    // Pastele ze wzorca - do wyboru w portalu, gdy klient zmienia kolor tekstu.
    palette: ['#3d3630', '#6b625a', '#a08b73', '#9aa892', '#c9a9b3'],
  }
}

/**
 * Kropkowana kreska jako PNG - obie kreski pasa biora ten sam plik.
 *
 * Warstwa `shape` odpada: renderer druku jej nie rysuje, wiec kropki musza
 * byc wypalone w pikselach. Plik ma docelowa wysokosc pasa, zeby skalowanie
 * nie rozmylo kropek.
 */
async function ensureSeparatorAsset(templateId: string) {
  const existing = await prisma.templateAsset.findFirst({
    where: { templateId, assetType: 'DECORATION', fileName: { startsWith: 'kreska-kropki' } },
  })
  if (existing) return existing

  const height = mm(RULE_HEIGHT_MM)
  const canvas = createCanvas(RULE_WIDTH_PX, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = INK_SOFT

  // Kropka co 1,5 mm - tak gesto, zeby z odleglosci czytalo sie jak kreska,
  // ale z bliska widac punkty, jak na wzorcu.
  const step = Math.round(mm(1.5))
  const dot = RULE_WIDTH_PX
  for (let y = 0; y + dot <= height; y += step) {
    ctx.fillRect(0, y, dot, dot)
  }

  const buffer = canvas.toBuffer('image/png')
  const fileName = `kreska-kropki_${Date.now()}.png`
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
      metadata: { width: RULE_WIDTH_PX, height, originalName: 'kreska-kropki.png' },
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
      data: { templateId: template.id, name: 'Zaproszenie 12 x 17', sortOrder: 0, isActive: true },
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
      optionsJson: field.options ?? Prisma.JsonNull,
      repeaterGroupKey: null,
      validationRulesJson: field.validationRules ?? Prisma.JsonNull,
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

  const separator = await ensureSeparatorAsset(template.id)
  const layout = buildLayout(separator.filePath)

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
        pageMm: [WIDTH_MM, HEIGHT_MM],
        miejsceNaGrafikeMm: [0, GRAPHIC_AREA_BOTTOM_MM],
        fields: FIELDS.map((field) => `${field.key} (${field.scope}, ${field.type})`),
        separatorAsset: separator.filePath,
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
