/**
 * Sprawdzenie szablonu STRAZAK BEZ BAZY: layout przez schemat Zod panelu
 * i podglad kazdej strony jako PNG w rozdzielczosci druku.
 *
 * Po co osobno: `create-strazak-template.ts` pisze do bazy, wiec nie da sie go
 * odpalic przy samym sprawdzaniu skladu. Tutaj bierzemy z niego `buildLayout`
 * i rysunek krążka, dokladamy grafiki do lokalnego storage i renderujemy
 * ta sama sciezka, ktora robi wydruk (`renderPrintPagePng`).
 *
 *   FRONT_SOURCE=tmp/strazak-przod.png BACK_SOURCE=tmp/strazak-tyl.png \
 *     pnpm tsx src/scripts/strazak-render-check.ts
 *
 * Uwaga: kroje pisma ida z rejestru serwera (`storage/fonts`). Na maszynie bez
 * tego rejestru node-canvas podstawi krój systemowy - sklad i geometria sa
 * wtedy wiarygodne, sam rysunek liter nie.
 */
import fs from 'fs'
import path from 'path'
import { getTemplatePages } from '@msierpien/kp-template-core'
import { templateLayoutSchema } from '../schemas/admin.schema'
import { renderPrintPagePng } from '../services/renderer/fabric-renderer.service'
import { buildLayout, drawBadgeRulePng } from './create-strazak-template'

const STORAGE_ROOT = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage')
const OUT_DIR = path.join(process.cwd(), 'tmp', 'strazak-check')

const FRONT_SOURCE = process.env.FRONT_SOURCE || 'tmp/strazak-przod.png'
const BACK_SOURCE = process.env.BACK_SOURCE || 'tmp/strazak-tyl.png'

/** Odpowiedzi udajace wypelniony formularz - najdluzsze sensowne wartosci. */
const ANSWERS: Record<string, string> = {
  guest_name: 'Zosiu',
  invite_line: 'zapraszam Cię na moją',
  occasion_line: 'URODZINOWĄ AKCJĘ',
  age_line: 'z okazji 5. urodzin',
  party_datetime: '12 września 2026, godz. 15:00',
  party_place: 'Sala zabaw „Iskierka”\nul. Wesoła 3, Kraków',
  rsvp_line: 'Potwierdź przybycie: Mama Ania 600 100 200',
  child_name: 'Oliwiera',
  badge_age_word: 'PIĘĆ',
  badge_age_unit: 'latek',
  badge_occasion: 'Piąte urodziny',
  badge_date: '16 lipca 2027',
  badge_time: 'godzina 14:00',
}

function copyToStorage(source: string, relative: string) {
  const target = path.join(STORAGE_ROOT, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  return relative
}

async function main() {
  const frontUrl = copyToStorage(FRONT_SOURCE, 'templates/STRAZAK/background/strazak-przod-check.png')
  const backUrl = copyToStorage(BACK_SOURCE, 'templates/STRAZAK/background/strazak-tyl-check.png')

  const ruleRelative = 'templates/STRAZAK/decoration/strazak-kreska-check.png'
  const ruleTarget = path.join(STORAGE_ROOT, ruleRelative)
  fs.mkdirSync(path.dirname(ruleTarget), { recursive: true })
  const rule = await drawBadgeRulePng()
  fs.writeFileSync(ruleTarget, rule.buffer)

  const layout = buildLayout(frontUrl, backUrl, ruleRelative)

  // Ten sam schemat, ktorym panel waliduje zapis layoutu. Nieznane pole nie
  // wywala bledu, tylko po cichu wypada - dlatego porownujemy tez ksztalt.
  const parsed = templateLayoutSchema.safeParse(layout)
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.format(), null, 2))
    throw new Error('Layout nie przechodzi schematu panelu')
  }

  // Porownanie po posortowanych kluczach: `z.object` odtwarza obiekt w swojej
  // kolejnosci pol, wiec zwykly `JSON.stringify` roznilby sie zawsze.
  const stable = (value: unknown): string =>
    JSON.stringify(value, (_key, item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item
    )

  const dropped = stable(layout) !== stable(parsed.data)
  console.log(dropped ? 'Zod: UWAGA - schemat zmienil layout' : 'Zod: OK (nic nie wypadlo)')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const rendered = new Map<string, Buffer>()
  for (const page of getTemplatePages(layout as any)) {
    const render = await renderPrintPagePng(layout as any, page, ANSWERS)
    const file = path.join(OUT_DIR, `${page.id}.png`)
    fs.writeFileSync(file, render.buffer)
    rendered.set(page.id, render.buffer)
    console.log(`${page.id} (${page.name}): ${render.widthMm} x ${render.heightMm} mm, ${render.widthPx} x ${render.heightPx} px -> ${file}`)
  }

  const composite = await composeFrontWithBadge(rendered.get('page-1')!, rendered.get('page-3')!)
  const compositeFile = path.join(OUT_DIR, 'podglad-z-krazkiem.png')
  fs.writeFileSync(compositeFile, composite)
  console.log(`gotowa karta (przód + doklejony krążek) -> ${compositeFile}`)
}

/**
 * Podglad tego, co dostaje klient: przod PO OBCIECIU SPADU z krążkiem wycietym
 * w kolo i doklejonym na srodku. Zaden renderer tego nie zlozy - to dwa osobne
 * wydruki - a bez tego obrazka nie widac, ile grafiki przodu krążek zaslania.
 */
async function composeFrontWithBadge(frontPng: Buffer, badgePng: Buffer): Promise<Buffer> {
  const { loadImage, createCanvas } = await import('canvas')
  const mm = (value: number) => Math.round((value / 25.4) * 300)

  const front = await loadImage(frontPng)
  const badge = await loadImage(badgePng)

  const width = mm(105)
  const height = mm(148)
  const bleed = mm(3)
  const diameter = mm(70)
  // Papier krążka konczy sie tam, gdzie tnie nozyczka - kilka pikseli pod
  // zewnetrzna obrecza, zeby nie zostawac z biala nitka dookola.
  const radius = diameter / 2 - 6

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(front, bleed, bleed, width, height, 0, 0, width, height)

  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.30)'
  ctx.shadowBlur = 20
  ctx.shadowOffsetY = 7
  ctx.beginPath()
  ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.beginPath()
  ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(badge, (width - diameter) / 2, (height - diameter) / 2, diameter, diameter)
  ctx.restore()

  return canvas.toBuffer('image/png')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
