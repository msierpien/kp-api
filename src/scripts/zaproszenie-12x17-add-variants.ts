/**
 * Dokłada do szablonu ZAPROSZENIE_12X17 trzy warianty układu: pierwsze,
 * drugie i trzecie urodziny. Różnią się WYŁĄCZNIE grafiką z cyfrą - reszta
 * składu jest kopiowana z bieżącego układu.
 *
 * Wyboru dokonuje klient w formularzu: pole „Napis odręczny (okazja)"
 * (`celebration_script`) staje się listą wyboru, a jego odpowiedź jest
 * `variantFieldKey` layoutu. Jeden wybór zmienia wiec napis I grafikę -
 * klient nie odpowiada dwa razy na to samo. Lista jest zamknieta (bez
 * własnego tekstu): wpis spoza listy nie dopasowałby żadnego wariantu
 * i karta wyszłaby z cyfrą z pierwszego wariantu.
 *
 * Skrypt DOSZYWA warianty do istniejącego layoutu zamiast budować go od nowa
 * (`create-zaproszenie-roczek-template.ts` skasowałby poprawki naniesione
 * ręcznie w edytorze: grafikę, linie, przesunięte ramki).
 *
 * Grafiki bierze z assetów szablonu - dopasowuje je po nazwie pliku
 * (cyfra między separatorami, np. „...-1-up..." albo „..._2_up...";
 * nadpisywalne przez ASSET_1/2/3). Brakujący asset przerywa pracę
 * z informacją, co wgrać w zakładce Assety.
 *
 * Idempotentny: ponowne uruchomienie przelicza warianty od nowa z układu
 * PIERWSZEGO wariantu (albo z `pages`, gdy wariantów jeszcze nie ma).
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/zaproszenie-12x17-add-variants.js
 *   DRY_RUN=1 - tylko raport, bez zapisu
 */
import path from 'path'
import { loadImage } from 'canvas'
import { PrismaClient } from '@prisma/client'
import { getTemplateVariants, withTemplateVariants, type TemplateLayoutJson, type TemplatePage } from '@msierpien/kp-template-core'

const prisma = new PrismaClient()

const TEMPLATE_CODE = 'ZAPROSZENIE_12X17'
const FIELD_KEY = 'celebration_script'

type VariantSpec = {
  id: string
  name: string
  /** Odpowiedź klienta, przy której wybieramy ten wariant - i zarazem napis na karcie. */
  matchValue: string
  /**
   * Wzorzec nazwy pliku assetu z odpowiednią cyfrą.
   *
   * Separator jest dowolny, bo grafiki bywają wgrywane raz z myślnikiem
   * („kro_liczek-1-up"), raz z podkreśleniem („kro_liczek_2_up").
   */
  assetPattern: RegExp
}

/** Env podaje zwykły fragment nazwy, nie wyrażenie - stąd escapowanie. */
function patternFromEnv(value: string | undefined, fallback: RegExp) {
  if (!value) return fallback
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
}

const VARIANTS: VariantSpec[] = [
  // Pierwszy na liście jest wariantem podstawowym: to jego układ widzą
  // konsumenci nieznający wariantów i to on pada, gdy odpowiedź nie pasuje.
  { id: 'variant-1', name: 'Pierwsze urodziny', matchValue: 'Pierwszych Urodzin', assetPattern: patternFromEnv(process.env.ASSET_1, /[-_]1[-_]up/i) },
  { id: 'variant-2', name: 'Drugie urodziny', matchValue: 'Drugich Urodzin', assetPattern: patternFromEnv(process.env.ASSET_2, /[-_]2[-_]up/i) },
  { id: 'variant-3', name: 'Trzecie urodziny', matchValue: 'Trzecich Urodzin', assetPattern: patternFromEnv(process.env.ASSET_3, /[-_]3[-_]up/i) },
]

/**
 * Warstwa z grafiką - ta, którą wariant podmienia.
 *
 * Bierzemy warstwę `image` o największej powierzchni: mockup i inne drobne
 * obrazki (kreski, ozdobniki) są od niej wyraźnie mniejsze, a ilustracja
 * zajmuje cały górny pas karty.
 */
function findArtworkLayer(pages: TemplatePage[]) {
  const images = pages
    .flatMap((page) => page.layers)
    .filter((layer: any) => layer.type === 'image')
    .map((layer: any) => ({ id: layer.id, width: layer.width || 0, height: layer.height || 0 }))
    .sort((a, b) => b.width * b.height - a.width * a.height)

  if (images.length === 0) throw new Error('Layout nie ma warstwy z grafiką - wgraj ilustrację w edytorze')
  return images[0]
}

/**
 * Ramka grafiki dopasowana do proporcji PLIKU, wpisana w ramkę bazową.
 *
 * Renderer skaluje obraz dokładnie do `width`/`height` warstwy - `fit` nie
 * ratuje proporcji. Kwadratowa ilustracja w ramce 4:3 wychodziła więc
 * rozciągnięta o jedną trzecią. Ramka bazowa jest górnym ograniczeniem
 * (mieścimy się w całości), a środek warstwy zostaje nietknięty.
 */
function fitToBox(box: { width: number; height: number }, image: { width: number; height: number }) {
  const scale = Math.min(box.width / image.width, box.height / image.height)
  return { width: Math.round(image.width * scale), height: Math.round(image.height * scale) }
}

/** Kopia stron z podmienioną grafiką w warstwie ilustracji. */
function pagesWithArtwork(
  pages: TemplatePage[],
  layerId: string,
  imageUrl: string,
  size: { width: number; height: number }
): TemplatePage[] {
  return pages.map((page) => ({
    ...page,
    layers: page.layers.map((layer: any) =>
      layer.id === layerId
        ? { ...layer, width: size.width, height: size.height, properties: { ...layer.properties, imageUrl } }
        : layer
    ),
  })) as TemplatePage[]
}

async function main() {
  const template = await prisma.personalizationTemplate.findFirst({
    where: { code: TEMPLATE_CODE },
    include: { forms: { include: { fields: true }, orderBy: { sortOrder: 'asc' } } },
  })
  if (!template) throw new Error(`Brak szablonu ${TEMPLATE_CODE}`)

  const layout = template.layoutJson as unknown as TemplateLayoutJson
  if (!layout) throw new Error('Szablon nie ma layoutu')

  // Baza dla wszystkich wariantów: układ PIERWSZEGO wariantu, a przy pierwszym
  // uruchomieniu - zwykłe strony. Dzięki temu ponowne odpalenie nie mnoży
  // wariantów ani nie kopiuje układu tego, który akurat był otwarty.
  const existing = getTemplateVariants(layout)
  const basePages = existing.length > 0 ? existing[0].pages : (layout.pages ?? [])
  if (basePages.length === 0) throw new Error('Layout nie ma stron')

  const artwork = findArtworkLayer(basePages)

  const assets = await prisma.templateAsset.findMany({ where: { templateId: template.id } })
  const missing: string[] = []
  const resolved = VARIANTS.map((variant) => {
    const asset = assets.find((item) => variant.assetPattern.test(item.fileName))
    if (!asset) missing.push(`${variant.name}: żaden asset nie pasuje do ${variant.assetPattern}`)
    return { ...variant, filePath: asset?.filePath ?? '', fileName: asset?.fileName ?? '' }
  })

  if (missing.length > 0) {
    console.error(
      JSON.stringify(
        {
          blad: 'Brakuje grafik w assetach szablonu',
          brakujace: missing,
          masz: assets.map((asset) => asset.fileName),
          rada: 'Wgraj grafiki w edytorze (Assety) tak, aby nazwa pliku zawierała odpowiedni fragment, albo podaj go w ASSET_2 / ASSET_3.',
        },
        null,
        2
      )
    )
    throw new Error('Brak grafik dla wariantów')
  }

  const storageRoot = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage')
  const variants = []
  const sizes: string[] = []
  for (const variant of resolved) {
    const image = await loadImage(path.join(storageRoot, variant.filePath))
    const size = fitToBox(artwork, image)
    sizes.push(`${variant.name}: plik ${image.width}x${image.height} -> ramka ${size.width}x${size.height}`)
    variants.push({
      id: variant.id,
      name: variant.name,
      matchValue: variant.matchValue,
      pages: pagesWithArtwork(basePages, artwork.id, variant.filePath, size),
    })
  }

  const nextLayout = {
    ...withTemplateVariants(layout, variants),
    variantFieldKey: FIELD_KEY,
  }

  // Pole sterujące: z tekstu na zamkniętą listę wyboru. Wartości opcji SĄ
  // napisem na karcie, więc muszą być identyczne z `matchValue` wariantów.
  const form = template.forms[0]
  if (!form) throw new Error('Szablon nie ma formularza')
  const field = form.fields.find((item) => item.key === FIELD_KEY)
  if (!field) throw new Error(`Formularz nie ma pola ${FIELD_KEY}`)

  const fieldData = {
    type: 'select',
    label: 'Które urodziny (napis i grafika)',
    optionsJson: VARIANTS.map((variant) => variant.matchValue),
    validationRulesJson: { allowCustom: false },
    defaultValue: VARIANTS[0].matchValue,
    helpText: 'Wybór zmienia napis odręczny i cyfrę na ilustracji.',
  }

  if (process.env.DRY_RUN === '1') {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          warstwaGrafiki: artwork.id,
          warianty: variants.map((variant) => ({ name: variant.name, matchValue: variant.matchValue })),
          grafiki: resolved.map((variant) => `${variant.name} -> ${variant.fileName}`),
          ramki: sizes,
        },
        null,
        2
      )
    )
    return
  }

  await prisma.formField.update({ where: { id: field.id }, data: fieldData })
  await prisma.personalizationTemplate.update({
    where: { id: template.id },
    data: { layoutJson: nextLayout as any },
  })

  console.log(
    JSON.stringify(
      {
        templateId: template.id,
        variantFieldKey: FIELD_KEY,
        warstwaGrafiki: artwork.id,
        ramki: sizes,
        warianty: resolved.map((variant) => ({
          name: variant.name,
          matchValue: variant.matchValue,
          grafika: variant.fileName,
        })),
        opcjePola: fieldData.optionsJson,
      },
      null,
      2
    )
  )
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
