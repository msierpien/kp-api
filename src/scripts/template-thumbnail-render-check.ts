/**
 * Sprawdzenie miniatury szablonu BEZ BAZY.
 *
 * `renderTemplateThumbnailJpeg` zasila karty w bibliotece szablonow. Tutaj
 * odpalamy ja na layoucie ROCZEK (czysta typografia, zero grafik do
 * podlozenia w storage), zeby zobaczyc trzy rzeczy: ze bierze PIERWSZA strone
 * wariantu podstawowego, ze skaluje w dol do zadanej szerokosci i ze JPEG
 * wychodzi w rozmiarze nadajacym sie na liste.
 *
 *   pnpm tsx src/scripts/template-thumbnail-render-check.ts
 *
 * Uwaga: kroje pisma ida z rejestru serwera (`storage/fonts`) - na maszynie
 * bez nich node-canvas podstawi krój systemowy. Geometria i kadr sa wtedy
 * wiarygodne, sam rysunek liter nie.
 */
import fs from 'fs'
import path from 'path'
import { getTemplatePages } from '@msierpien/kp-template-core'
import { templateLayoutSchema } from '../schemas/admin.schema'
import { renderTemplateThumbnailJpeg } from '../services/renderer/fabric-renderer.service'
import { buildSampleAnswers } from '../services/admin/template-thumbnail.service'
import { buildLayout } from './create-roczek-template'

const OUT_DIR = path.join(process.cwd(), 'tmp', 'template-thumbnail-check')

/** Szerokosci: docelowa z serwisu miniatur i skrajna, ktorej nie wolno przekroczyc w gore. */
const WIDTHS = [720, 5000]

/**
 * Pola szablonu tak, jak leza w bazie - z kazdym zrodlem przykladowej
 * wartosci, ktore zna `buildSampleAnswers`: wartosc domyslna, lista wyboru
 * i `placeholder` z wiodacym „np.” do obcięcia. Warstwy skladane z szablonu
 * („{{ child_name }}”) bez odpowiedzi zostawilyby na miniaturze surowy
 * znacznik w klamerkach - to sprawdzamy tu przede wszystkim.
 */
const FIELDS = [
  { key: 'cover_script', defaultValue: 'mam już Roczek', placeholder: null, optionsJson: null },
  { key: 'inside_script', defaultValue: 'Ale szok, mam już\nROK!', placeholder: null, optionsJson: null },
  { key: 'child_name', defaultValue: null, placeholder: 'np. Oluś', optionsJson: null },
  {
    key: 'host_phrase',
    defaultValue: null,
    placeholder: null,
    optionsJson: ['Wraz z Rodzicami zaprasza', 'Wraz z Mamą zaprasza'],
  },
  { key: 'guest_names', defaultValue: null, placeholder: 'np. Państwa Kowalskich', optionsJson: null },
  { key: 'occasion_line', defaultValue: 'na urodzinowe świętowanie.', placeholder: null, optionsJson: null },
  { key: 'party_datetime', defaultValue: '12.06.2026, godz. 14:00', placeholder: null, optionsJson: null },
]

async function main() {
  const layout = buildLayout()

  const parsed = templateLayoutSchema.safeParse(layout)
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues, null, 2))
    throw new Error('Layout nie przechodzi schematu panelu')
  }

  const pages = getTemplatePages(layout as any)
  const nativeWidth = Math.round(Number(pages[0].canvas.width))

  fs.mkdirSync(OUT_DIR, { recursive: true })

  const answers = buildSampleAnswers([{ fields: FIELDS }])

  const out: Record<string, string> = {}
  for (const widthPx of WIDTHS) {
    const render = await renderTemplateThumbnailJpeg(layout as any, answers, { widthPx })
    const file = path.join(OUT_DIR, `thumb-${widthPx}.jpg`)
    fs.writeFileSync(file, render.buffer)
    out[`widthPx=${widthPx}`] =
      `${file} (${render.widthPx} x ${render.heightPx} px, ${Math.round(render.buffer.length / 1024)} kB)`
  }

  console.log(
    JSON.stringify(
      {
        layoutOk: true,
        stronyWLayoucie: pages.length,
        natywnaSzerokoscPx: nativeWidth,
        przykladoweOdpowiedzi: answers,
        jpeg: out,
      },
      null,
      2
    )
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
