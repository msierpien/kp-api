/**
 * Sprawdzenie szablonu WINIETKA_BOTANICZNA BEZ BAZY: layout przez schemat Zod
 * panelu i podglad przodu jako PNG w rozdzielczosci druku.
 *
 * Po co osobno: `create-winietka-botaniczna-template.ts` pisze do bazy, wiec
 * nie da sie go odpalic przy samym sprawdzaniu skladu. Tutaj bierzemy z niego
 * `buildLayout`, wkladamy tlo do lokalnego storage i renderujemy ta sama
 * sciezka, ktora robi wydruk (`renderPrintPagePng`).
 *
 *   BG_SOURCE="/sciezka/do/Botaniczna Zieleń.png" \
 *     pnpm tsx src/scripts/winietka-botaniczna-render-check.ts
 *
 * Uwaga: kroje pisma ida z rejestru serwera (`storage/fonts`). Na maszynie bez
 * Cormorant Garamond node-canvas podstawi krój systemowy - sklad i geometria
 * sa wtedy wiarygodne, sam rysunek liter nie.
 */
import fs from 'fs'
import path from 'path'
import { getTemplatePages } from '@msierpien/kp-template-core'
import { templateLayoutSchema } from '../schemas/admin.schema'
import { renderPrintPagePng } from '../services/renderer/fabric-renderer.service'
import { buildLayout } from './create-winietka-botaniczna-template'

const STORAGE_ROOT = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage')
const OUT_DIR = path.join(process.cwd(), 'tmp', 'winietka-botaniczna-check')

const BG_SOURCE =
  process.env.BG_SOURCE ||
  '/Volumes/Dysk 500/Kreatywne-papierki/grafika wektorowa/winietki/Botaniczna Zieleń.png'

/** Najdluzsze sensowne wpisy - krotkie imie zawsze sie zmiesci, dlugie nie. */
const CASES: Record<string, string> = {
  'anna-kowalska': 'Anna Kowalska',
  'dlugie-nazwisko': 'Katarzyna Wiśniewska-Kowalczyk',
  'jedno-slowo': 'Konstantynopolitańczykiewiczówna',
}

/** Tlo w lokalnym storage - tam, gdzie na serwerze siedzi asset szablonu. */
function writeBackground(relative: string) {
  const target = path.join(STORAGE_ROOT, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(BG_SOURCE, target)
  return relative
}

async function main() {
  const backgroundUrl = writeBackground(
    'templates/WINIETKA_BOTANICZNA/background/botaniczna-zielen-check.png'
  )
  const layout = buildLayout(backgroundUrl)

  // Ten sam schemat, ktory tnie zapis z panelu - pole spoza niego zniknieloby
  // po cichu przy pierwszym zapisie w edytorze.
  const parsed = templateLayoutSchema.safeParse(layout)
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues, null, 2))
    throw new Error('Layout nie przechodzi schematu panelu')
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const [front] = getTemplatePages(layout as any)

  const out: Record<string, string> = {}
  for (const [name, guestName] of Object.entries(CASES)) {
    const render = await renderPrintPagePng(layout as any, front, { guest_name: guestName })
    const file = path.join(OUT_DIR, `${name}.png`)
    fs.writeFileSync(file, render.buffer)
    out[name] = `${file} (${render.widthMm} x ${render.heightMm} mm, ${render.widthPx} x ${render.heightPx} px)`
  }

  console.log(JSON.stringify({ layoutOk: true, warstwy: layout.layers.length, png: out }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
