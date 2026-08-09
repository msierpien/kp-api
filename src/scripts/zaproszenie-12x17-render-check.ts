/**
 * Sprawdzenie szablonu ZAPROSZENIE_12X17 BEZ BAZY: layout przez schemat Zod
 * panelu i podglad strony jako PNG w rozdzielczosci druku.
 *
 * Po co osobno: `create-zaproszenie-roczek-template.ts` pisze do bazy, wiec
 * nie da sie go odpalic przy samym sprawdzaniu skladu. Tutaj bierzemy z niego
 * `buildLayout`, dorysowujemy kropkowana kreske do lokalnego storage
 * i renderujemy ta sama sciezka, ktora robi wydruk (`renderPrintPagePng`).
 *
 *   pnpm tsx src/scripts/zaproszenie-12x17-render-check.ts
 *
 * Uwaga: kroje pisma ida z rejestru serwera (`storage/fonts`). Na maszynie bez
 * Cormorant Infant i Bonheur Royale node-canvas podstawi krój systemowy -
 * sklad i geometria sa wtedy wiarygodne, sam rysunek liter nie.
 */
import fs from 'fs'
import path from 'path'
import { createCanvas } from 'canvas'
import { getTemplatePages } from '@msierpien/kp-template-core'
import { templateLayoutSchema } from '../schemas/admin.schema'
import { renderPrintPagePng } from '../services/renderer/fabric-renderer.service'
import { buildLayout } from './create-zaproszenie-roczek-template'

const STORAGE_ROOT = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage')
const OUT_DIR = path.join(process.cwd(), 'tmp', 'zaproszenie-12x17-check')

/** Odpowiedzi udajace wypelniony formularz - najdluzsze sensowne wartosci. */
const ANSWERS: Record<string, string> = {
  intro_text: 'SERDECZNIE ZAPRASZAM',
  guest_names: 'Babcię Zosię i Dziadka Tadeusza',
  occasion_text: 'NA PRZYJĘCIE Z OKAZJI MOICH',
  celebration_script: 'Pierwszych Urodzin',
  party_date: '07/09\n2028',
  party_time: '12:00',
  time_label: 'godzina',
  party_place: 'Restauracja\n„Żółty Parasol”\nul. Książęca 15,\nSzczytno',
  rsvp_text: 'Prosimy o potwierdzenie przybycia do 05.08.2028\nMama: +48 500 500 500',
  signature_name: 'Hania',
  signature_suffix: 'wraz z Rodzicami',
}

/** Kreska w storage - taka sama jak ta, ktora skrypt szablonu zapisuje jako asset. */
function writeSeparator(relative: string) {
  const target = path.join(STORAGE_ROOT, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })

  const width = 6
  const height = Math.round((17 / 25.4) * 300)
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#6b625a'
  const step = Math.round((1.5 / 25.4) * 300)
  for (let y = 0; y + width <= height; y += step) {
    ctx.fillRect(0, y, width, width)
  }

  fs.writeFileSync(target, canvas.toBuffer('image/png'))
  return relative
}

async function main() {
  const separatorUrl = writeSeparator('templates/ZAPROSZENIE_12X17/decoration/kreska-kropki-check.png')
  const layout = buildLayout(separatorUrl)

  // Ten sam schemat, ktory tnie zapis z panelu - pole spoza niego zniknieloby
  // po cichu przy pierwszym zapisie w edytorze.
  const parsed = templateLayoutSchema.safeParse(layout)
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues, null, 2))
    throw new Error('Layout nie przechodzi schematu panelu')
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const [page] = getTemplatePages(layout as any)
  const render = await renderPrintPagePng(layout as any, page, ANSWERS)
  const file = path.join(OUT_DIR, 'zaproszenie.png')
  fs.writeFileSync(file, render.buffer)

  console.log(
    JSON.stringify(
      { layoutOk: true, warstwy: layout.layers.length, mm: [render.widthMm, render.heightMm], png: file },
      null,
      2
    )
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
