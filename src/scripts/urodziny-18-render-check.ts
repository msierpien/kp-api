/**
 * Podglad szablonu URODZINY_18_PLOTER BEZ BAZY.
 *
 * Geometrie skladu i paserow sprawdza `imposition-render-check.ts` - tu chodzi
 * o sam projekt: czy tekst miesci sie w ramkach, nie wchodzi na kokarde i nie
 * dotyka falowanej krawedzi owalu. Renderuje ta sama sciezka, ktora robi
 * paczke do druku.
 *
 *   pnpm tsx src/scripts/urodziny-18-render-check.ts
 *
 * Uwaga: kroje pisma ida z rejestru serwera (`storage/fonts`) - na maszynie
 * bez nich node-canvas podstawi krój systemowy i sklad przestanie byc
 * wiarygodny.
 */
import fs from 'fs'
import path from 'path'
import { validateSheetImposition } from '@msierpien/kp-template-core'
import { buildLayout } from './create-urodziny-18-ploter-template'

// Atrapy sekretow: `config` waliduje env juz przy imporcie, a ten skrypt do
// bazy ani do szyfrowania nie siega.
process.env.DATABASE_URL ||= 'postgresql://check:check@localhost:5432/check'
process.env.JWT_ACCESS_SECRET ||= 'render-check-access-secret-render-check'
process.env.JWT_REFRESH_SECRET ||= 'render-check-refresh-secret-render-check'
process.env.ENCRYPTION_KEY ||= 'render-check-encryption-key-32b!'

const OUT_DIR = path.join(process.cwd(), 'tmp', 'urodziny-18-check')

/** Podklad wgrywa skrypt zakladajacy szablon; brak pliku nie jest bledem. */
const SHEET_BACKGROUND = 'templates/URODZINY_18_PLOTER/sheet_background/podklad-czarne.png'

/**
 * Wpisy skrajne, nie wygodne: krotkie imie zmiesci sie zawsze, a dlugie
 * i liczebnik z ogonkami pokaza, gdzie sklad puszcza.
 */
const ANSWERS = [
  {
    headline: 'OLA KOŃCZY',
    age_word: 'Osiemnaście',
    invite_text: 'ZAPRASZAM NA PRZYJĘCIE URODZINOWE',
    event_date: 'Sobota, 5 października, o 14:00',
    event_place: 'ul. Kwiatowa 12, Warszawa',
    rsvp_info: 'POTWIERDŹ: +48 123 456 789',
  },
  {
    headline: 'ALEKSANDRA KOŃCZY',
    age_word: 'Dwadzieścia',
    invite_text: 'ZAPRASZAMY NA PRZYJĘCIE URODZINOWE',
    event_date: 'Piątek, 28 listopada, o 19:30',
    event_place: 'Restauracja Pod Różą, ul. Świętokrzyska 45, Kraków',
    rsvp_info: 'POTWIERDŹ DO 1 LISTOPADA',
  },
]

async function main() {
  const { templateLayoutSchema } = await import('../schemas/admin.schema')
  const { renderImpositionSheetPng, renderProofPagePng } = await import(
    '../services/renderer/fabric-renderer.service'
  )

  const layout = buildLayout(SHEET_BACKGROUND)

  // Ten sam schemat, ktory tnie zapis z panelu - pole spoza niego zniknieloby
  // po cichu przy pierwszym zapisie w edytorze.
  const parsed = templateLayoutSchema.safeParse(layout)
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues, null, 2))
    throw new Error('Layout nie przechodzi schematu panelu')
  }

  const warnings = validateSheetImposition(layout)
  if (warnings.length > 0) {
    console.error(JSON.stringify(warnings, null, 2))
    throw new Error('Skład arkuszowy zgłasza ostrzeżenia')
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out: Record<string, string> = {}

  const sheet = await renderImpositionSheetPng(
    layout,
    ANSWERS.map((answers, itemIndex) => ({ answers, itemIndex }))
  )
  const sheetFile = path.join(OUT_DIR, 'arkusz.png')
  fs.writeFileSync(sheetFile, sheet.buffer)
  out.arkusz = `${sheetFile} (${sheet.widthMm} x ${sheet.heightMm} mm, ${sheet.dpi} dpi)`

  // Sama kartka, bez podkladu i bez obrotu - tak wyglada projekt w edytorze.
  const [page] = layout.pages
  for (let index = 0; index < ANSWERS.length; index += 1) {
    const proof = await renderProofPagePng(page as any, ANSWERS[index], undefined, index)
    const file = path.join(OUT_DIR, `kartka-${index + 1}.png`)
    fs.writeFileSync(file, proof.buffer)
    out[`kartka-${index + 1}`] = `${file} (${proof.widthMm} x ${proof.heightMm} mm)`
  }

  console.log(JSON.stringify({ layoutOk: true, warstwy: layout.layers.length, pliki: out }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
