/**
 * Sprawdzenie skladu arkuszowego i paserow Print & Cut BEZ BAZY.
 *
 * Pasery sa jedynym ukladem odniesienia plotera: jesli wyjda o milimetr obok,
 * ciecie mija sie z grafika i marnuje sie cala partia. Dlatego skrypt nie
 * poprzestaje na wygenerowaniu PNG - mierzy narozniki na wyrenderowanym
 * arkuszu i porownuje je z dwoma zrodlami:
 *
 *  1. z KONFIGURACJA layoutu - to sprawdza arytmetyke renderera (twarda
 *     asercja, tolerancja 0,2 mm),
 *  2. z plikiem referencyjnym ze Silhouette Studio, jesli jest pod reka -
 *     raport informacyjny, bo Silhouette liczy wstawke od krawedzi swojego
 *     obszaru roboczego i rozjezdza sie z A4 o ulamek milimetra.
 *
 *   pnpm tsx src/scripts/imposition-render-check.ts
 *
 * Uwaga: kroje pisma ida z rejestru serwera (`storage/fonts`) - na maszynie
 * bez nich node-canvas podstawi krój systemowy. Geometria zostaje wiarygodna,
 * sam rysunek liter nie.
 */
import fs from 'fs'
import path from 'path'
import {
  A4_SHEET_MM,
  SILHOUETTE_MARKS_DEFAULT,
  validateSheetImposition,
} from '@msierpien/kp-template-core'
import { buildLayout } from './create-zaproszenie-90x130-ploter-template'
// Atrapy sekretow: `config` waliduje env juz przy imporcie, a ten skrypt do
// bazy ani do szyfrowania nie siega. Stad ustawienie przed dynamicznym
// importem renderera nizej - statyczny import wywrocilby skrypt na maszynie
// bez `.env`.
process.env.DATABASE_URL ||= 'postgresql://check:check@localhost:5432/check'
process.env.JWT_ACCESS_SECRET ||= 'render-check-access-secret-render-check'
process.env.JWT_REFRESH_SECRET ||= 'render-check-refresh-secret-render-check'
process.env.ENCRYPTION_KEY ||= 'render-check-encryption-key-32b!'

const OUT_DIR = path.join(process.cwd(), 'tmp', 'imposition-check')
const MM_PER_INCH = 25.4

/**
 * Podklad arkusza. Skrypt nie kopiuje go do storage - wgrywa go
 * `create-zaproszenie-90x130-ploter-template.ts`. Brak pliku nie jest bledem:
 * arkusz wyjdzie wtedy z samymi paserami i uzytkami.
 */
const SHEET_BACKGROUND = 'templates/ZAPROSZENIE_90X130_PLOTER/sheet_background/podklad-czarne.png'

/**
 * Pomiar z pliku `czarna kartka.pdf` wyeksportowanego ze Silhouette Studio
 * (A4, Print & Cut, ustawienia domyslne). Sluzy wylacznie do porownania -
 * zrodlem prawdy dla renderera jest konfiguracja layoutu.
 */
const SILHOUETTE_REFERENCE_MM = {
  leftMm: 15.78,
  rightMm: 194.52,
  topMm: 15.78,
  bottomMm: 281.51,
}

/** Tolerancja asercji wobec konfiguracji: pol piksela przy 600 dpi to 0,04 mm. */
const TOLERANCE_MM = 0.2

/** Najdluzsze sensowne wpisy - krotkie imie zawsze sie zmiesci, dlugie nie. */
const ANSWERS = [
  {
    age_number: '20',
    celebrant_genitive: 'Kasi',
    front_date: 'SOBOTA · 20 LISTOPADA · 17:00',
    guest_name: 'Annę Kowalską',
    invite_body: 'na przyjęcie z okazji moich dwudziestych urodzin, które odbędzie się dnia',
    event_datetime: '20 LISTOPADA 2025 ROKU O GODZINIE 17:00',
    event_place: 'w Restauracji Primma Vera w Warszawie.',
    signature: 'Kasia',
  },
  {
    age_number: '18',
    celebrant_genitive: 'Aleksandry',
    front_date: 'PIĄTEK · 28 LISTOPADA · 19:30',
    guest_name: 'Panią Katarzynę',
    invite_body: 'na przyjęcie z okazji moich osiemnastych urodzin, które odbędzie się dnia',
    event_datetime: '28 LISTOPADA 2026 ROKU O GODZINIE 19:30',
    event_place: 'w Restauracji Pod Różą w Krakowie.',
    signature: 'Ola',
  },
]

type Box = { leftMm: number; rightMm: number; topMm: number; bottomMm: number }

/**
 * Bbox ciemnych pikseli w wycinku arkusza (jednym z czterech naroznikow).
 *
 * Czytamy gotowy raster, a nie liczby z konfiguracji - dopiero to dowodzi,
 * ze paser naprawde wyladowal tam, gdzie mial, i nie zostal niczym przykryty.
 */
function measureCorner(
  data: Uint8ClampedArray,
  imageWidth: number,
  region: { x0: number; y0: number; x1: number; y1: number },
  pxPerMm: number
): Box | null {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (let y = region.y0; y < region.y1; y += 1) {
    for (let x = region.x0; x < region.x1; x += 1) {
      const offset = (y * imageWidth + x) * 4
      // Sam czarny, kanal po kanale - nie jasnosc. Barwna grafika projektu
      // potrafi miec jasnosc ponizej progu (czerwien #cc0000 ma 68) i
      // wchodzilaby w pomiar mimo ze nie jest paserem.
      const darkest = Math.max(data[offset], data[offset + 1], data[offset + 2])
      if (darkest > 100) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (!Number.isFinite(minX)) return null
  return {
    leftMm: minX / pxPerMm,
    rightMm: (maxX + 1) / pxPerMm,
    topMm: minY / pxPerMm,
    bottomMm: (maxY + 1) / pxPerMm,
  }
}

function assertClose(label: string, actualMm: number, expectedMm: number, errors: string[]): void {
  const deltaMm = Math.abs(actualMm - expectedMm)
  if (deltaMm > TOLERANCE_MM) {
    errors.push(`${label}: ${actualMm.toFixed(2)} mm, oczekiwano ${expectedMm.toFixed(2)} mm (różnica ${deltaMm.toFixed(2)} mm)`)
  }
}

async function main() {
  const { templateLayoutSchema } = await import('../schemas/admin.schema')
  const { renderImpositionSheetPng } = await import('../services/renderer/fabric-renderer.service')

  // Podklad z assetu szablonu - render-check ma sprawdzac dokladnie to, co
  // pojdzie na drukarke, razem z ozdobna ramka pod uzytkami.
  const layout = buildLayout(SHEET_BACKGROUND)

  // Ten sam schemat, ktory tnie zapis z panelu - pole spoza niego zniknieloby
  // po cichu przy pierwszym zapisie w edytorze.
  const parsed = templateLayoutSchema.safeParse(layout)
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues, null, 2))
    throw new Error('Layout nie przechodzi schematu panelu')
  }
  if (!parsed.data.imposition?.enabled) {
    throw new Error('Schemat panelu wyciął blok imposition')
  }

  const warnings = validateSheetImposition(layout)
  if (warnings.length > 0) {
    console.error(JSON.stringify(warnings, null, 2))
    throw new Error('Skład arkuszowy zgłasza ostrzeżenia')
  }

  const items = ANSWERS.map((answers, itemIndex) => ({ answers, itemIndex }))
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // Kazda strona to osobny arkusz: przod na wstazce, tyl na czystym papierze.
  const pageFiles: string[] = []
  for (let index = 1; index < layout.pages.length; index += 1) {
    const page = layout.pages[index]
    const extra = await renderImpositionSheetPng(layout, items, { pageId: page.id })
    const extraFile = path.join(OUT_DIR, `arkusz-str-${index + 1}.png`)
    fs.writeFileSync(extraFile, extra.buffer)
    pageFiles.push(`${extraFile} (${page.name})`)
  }

  const sheet = await renderImpositionSheetPng(layout, items, { pageId: layout.pages[0].id })
  const file = path.join(OUT_DIR, 'arkusz.png')
  fs.writeFileSync(file, sheet.buffer)

  const { createCanvas, loadImage } = await import('canvas')
  const image = await loadImage(sheet.buffer)
  const measureCanvas = createCanvas(image.width, image.height)
  const measureCtx = measureCanvas.getContext('2d')
  measureCtx.drawImage(image as any, 0, 0)
  const { data } = measureCtx.getImageData(0, 0, image.width, image.height)

  const pxPerMm = image.width / A4_SHEET_MM.widthMm
  // Okno pomiarowe: 30 mm od kazdego rogu. Miesci calego pasera (ramie 10 mm
  // przy wstawce 15,88 mm konczy sie na 25,88 mm) z zapasem na przesuniecie.
  const window = Math.round(30 * pxPerMm)
  const corners = {
    lewyGorny: { x0: 0, y0: 0, x1: window, y1: window },
    prawyGorny: { x0: image.width - window, y0: 0, x1: image.width, y1: window },
    lewyDolny: { x0: 0, y0: image.height - window, x1: window, y1: image.height },
    prawyDolny: { x0: image.width - window, y0: image.height - window, x1: image.width, y1: image.height },
  }

  const marks = SILHOUETTE_MARKS_DEFAULT
  const expectedLeft = marks.insetLeftMm
  const expectedRight = A4_SHEET_MM.widthMm - marks.insetRightMm
  const expectedTop = marks.insetTopMm
  const expectedBottom = A4_SHEET_MM.heightMm - marks.insetBottomMm

  const errors: string[] = []
  const measured: Record<string, Box> = {}

  for (const [name, region] of Object.entries(corners)) {
    const box = measureCorner(data, image.width, region, pxPerMm)
    if (!box) {
      errors.push(`${name}: nie znaleziono pasera`)
      continue
    }
    measured[name] = box

    const isLeft = name.startsWith('lewy')
    const isTop = name.endsWith('Gorny')
    const armMm = isLeft ? marks.armLengthMm : marks.armLengthRightMm

    assertClose(`${name} lewa krawędź`, box.leftMm, isLeft ? expectedLeft : expectedRight - armMm, errors)
    assertClose(`${name} prawa krawędź`, box.rightMm, isLeft ? expectedLeft + armMm : expectedRight, errors)
    assertClose(`${name} górna krawędź`, box.topMm, isTop ? expectedTop : expectedBottom - marks.armLengthMm, errors)
    assertClose(`${name} dolna krawędź`, box.bottomMm, isTop ? expectedTop + marks.armLengthMm : expectedBottom, errors)
  }

  // Niepelny arkusz (nieparzysta liczba sztuk w zamowieniu): jedno gniazdo
  // zostaje puste, ale pasery musza byc w komplecie - inaczej ostatni arkusz
  // partii bylby nie do wyciecia.
  const partial = await renderImpositionSheetPng(layout, [
    { answers: { ...ANSWERS[0], guest_name: 'Jan Nowak' }, itemIndex: 2 },
  ])
  fs.writeFileSync(path.join(OUT_DIR, 'arkusz-niepelny.png'), partial.buffer)

  const partialImage = await loadImage(partial.buffer)
  const partialCanvas = createCanvas(partialImage.width, partialImage.height)
  const partialCtx = partialCanvas.getContext('2d')
  partialCtx.drawImage(partialImage as any, 0, 0)
  const partialData = partialCtx.getImageData(0, 0, partialImage.width, partialImage.height).data
  for (const [name, region] of Object.entries(corners)) {
    if (measureCorner(partialData, partialImage.width, region, pxPerMm)) continue
    errors.push(`niepełny arkusz, ${name}: brak pasera`)
  }

  // Strona PDF powstaje z pikseli arkusza i jego gestosci - profil agenta
  // druku sprawdza ten wymiar i odrzuca zlecenie, jesli sie nie zgadza.
  const pageWidthMm = (sheet.widthPx / sheet.dpi) * MM_PER_INCH
  const pageHeightMm = (sheet.heightPx / sheet.dpi) * MM_PER_INCH
  assertClose('strona PDF, szerokość', pageWidthMm, A4_SHEET_MM.widthMm, errors)
  assertClose('strona PDF, wysokość', pageHeightMm, A4_SHEET_MM.heightMm, errors)

  // Porownanie z plikiem ze Silhouette - informacyjnie, bez asercji.
  const reference = measured.lewyGorny && measured.prawyDolny
    ? {
        lewaMm: Number((measured.lewyGorny.leftMm - SILHOUETTE_REFERENCE_MM.leftMm).toFixed(2)),
        goraMm: Number((measured.lewyGorny.topMm - SILHOUETTE_REFERENCE_MM.topMm).toFixed(2)),
        prawaMm: Number((measured.prawyDolny.rightMm - SILHOUETTE_REFERENCE_MM.rightMm).toFixed(2)),
        dolMm: Number((measured.prawyDolny.bottomMm - SILHOUETTE_REFERENCE_MM.bottomMm).toFixed(2)),
      }
    : null

  console.log(
    JSON.stringify(
      {
        layoutOk: true,
        arkusz: `${file} (${sheet.widthMm} x ${sheet.heightMm} mm, ${sheet.widthPx} x ${sheet.heightPx} px, ${sheet.dpi} dpi)`,
        stronaPdfMm: `${pageWidthMm.toFixed(2)} x ${pageHeightMm.toFixed(2)}`,
        pozostaleArkusze: pageFiles,
        paseryMm: Object.fromEntries(
          Object.entries(measured).map(([name, box]) => [
            name,
            {
              x: `${box.leftMm.toFixed(2)} - ${box.rightMm.toFixed(2)}`,
              y: `${box.topMm.toFixed(2)} - ${box.bottomMm.toFixed(2)}`,
            },
          ])
        ),
        odchylkaOdPlikuSilhouette: reference,
        bledy: errors,
      },
      null,
      2
    )
  )

  if (errors.length > 0) {
    throw new Error(`Pasery nie zgadzają się z konfiguracją (${errors.length} odchyłek)`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
