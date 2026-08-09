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
 * `party_datetime` to pole typu `date` z regula `pl-long` i godzina: klient
 * wybiera date z kalendarza, a w odpowiedzi zapisuje sie gotowy tekst
 * ("07 wrzesnia 2028 roku o godzinie 12:00"), bo renderer drukuje wartosci
 * pol doslownie i nie zna regul jezykowych.
 *
 * Skrypt jest idempotentny - ponowne uruchomienie nadpisuje pola formularza
 * i layout zamiast tworzyc drugi szablon o tym samym kodzie. UWAGA: nadpisze
 * tez recznie naniesione poprawki z edytora - do doszywania zmian sluza
 * skrypty doszywajace (wzor: `roczek-add-rsvp.ts`).
 *
 * Uruchamiany W KONTENERZE `personalization-api` (baza nie jest wystawiona
 * poza siec dockera); lokalnie: pnpm tsx src/scripts/create-zaproszenie-roczek-template.ts
 */
import { Prisma, PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

/** Slug tenanta, do ktorego nalezy szablon (nadpisywalny przez TENANT_SLUG). */
const TENANT_SLUG = 'kreatywne-papierki'

const TEMPLATE_CODE = 'ZAPROSZENIE_12X17'
const TEMPLATE_NAME = 'Zaproszenie 12 x 17'
const TEMPLATE_DESCRIPTION =
  'Zaproszenie 120 x 170 mm - miejsce na grafikę w górnej części (72 mm), pod nią wyśrodkowana kolumna treści: goście, okazja, data z kalendarza, miejsce, potwierdzenie przybycia i odręczny podpis.'

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
    key: 'party_datetime',
    label: 'Data i godzina przyjęcia',
    type: 'date',
    scope: 'SHARED',
    required: true,
    sortOrder: 5,
    // Zapis polski, a nie ISO - taki tekst idzie na wydruk i taki portal
    // potrafi rozebrac z powrotem na kalendarz przy edycji.
    defaultValue: '07 września 2028 roku o godzinie 12:00',
    helpText: 'Kalendarz z godziną - na zaproszeniu pojawi się polski zapis daty.',
    validationRules: { dateFormat: 'pl-long', withTime: true },
  },
  {
    key: 'party_place',
    label: 'Miejsce przyjęcia',
    type: 'textarea',
    scope: 'SHARED',
    required: true,
    sortOrder: 6,
    defaultValue: 'Restauracja „Żółty Parasol”\nul. Książęca 15, Szczytno',
    helpText: 'Do trzech wierszy - nazwa lokalu, ulica, miejscowość.',
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
    sortOrder: 7,
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
    sortOrder: 8,
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
    sortOrder: 9,
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

const defaults = Object.fromEntries(FIELDS.map((field) => [field.key, field.defaultValue ?? '']))

/**
 * Kolumna tresci pod grafika.
 *
 * Wszystko jest wysrodkowane i trzyma te sama szerokosc - kolejnosc pionowa
 * odczytuje sie jak zdanie: kto zaprasza kogo, na co, kiedy, gdzie.
 * Wysokosci ramek maja zapas na drugi (a przy miejscu - trzeci) wiersz;
 * tekst jest w ramce wysrodkowany pionowo, wiec zapas rozklada sie rowno.
 */
function buildLayers() {
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
      topMm: 103,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 15,
      zIndex: 3,
      fontFamily: SCRIPT_FONT,
      fontSize: 30,
      fill: INK_SCRIPT,
      lineHeight: 1,
      textAlign: 'center',
    }),

    // Data przychodzi z kalendarza juz jako gotowy tekst - warstwa tylko go
    // stawia. Ramka ma zapas na drugi wiersz, bo dluga data z godzina lamie
    // sie przy wiekszym kroju.
    textbox({
      id: 'party_datetime',
      name: 'Data i godzina',
      fieldKey: 'party_datetime',
      text: defaults.party_datetime,
      leftMm: COLUMN_LEFT_MM,
      topMm: 118.5,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 10,
      zIndex: 4,
      fontFamily: SERIF_FONT,
      fontSize: 12,
      letterSpacing: 60,
      lineHeight: 1.35,
      textAlign: 'center',
    }),

    textbox({
      id: 'party_place',
      name: 'Miejsce przyjęcia',
      fieldKey: 'party_place',
      text: defaults.party_place,
      leftMm: COLUMN_LEFT_MM,
      topMm: 129,
      widthMm: COLUMN_WIDTH_MM,
      heightMm: 14,
      zIndex: 5,
      fontFamily: SERIF_FONT,
      fontSize: 8.5,
      fill: INK_SOFT,
      letterSpacing: 120,
      lineHeight: 1.7,
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

export function buildLayout() {
  const layers = buildLayers()

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

  const layout = buildLayout()

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
