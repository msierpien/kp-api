/**
 * Naprawa ozdobnikow, ktore w edytorze slucha koloru wiodacego, a na
 * renderze i wydruku nie.
 *
 * Skad problem: `tint` z warstwy podstawia sie pod `currentColor` w pliku
 * SVG (`applySvgTint`). Plik, ktory `currentColor` nie ma - bo wszedl do
 * biblioteki bez opcji "przygotuj do przebarwiania" albo jeszcze przed jej
 * powstaniem - zostaje przy wlasnych barwach. Kanwa edytora przebarwia
 * ozdobnik po swojemu, wiec projektant widzi kolor, ktorego renderer nie ma
 * jak oddac: zdjecia produktowe, miniatura szablonu i PACZKA DO DRUKU
 * wychodza czarne.
 *
 * Skrypt robi to samo, co przycisk "Przebarw" w panelu
 * (`retintDecoration`), tylko hurtem i bez kontekstu tenantow: przepuszcza
 * plik przez `prepareSvgArtwork({ tintable: true })`, nadpisuje go i
 * uaktualnia `tintable`, `fileSize` oraz `contentHash`.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/repair-decoration-tints.js
 *   DRY_RUN=1     - tylko plan, zero zapisow (uruchom to najpierw)
 *   CATEGORY=...  - ograniczenie do jednej kategorii biblioteki
 *   IDS=a,b,c     - ograniczenie do wskazanych ozdobnikow
 */
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { config } from '../config'
import { prepareSvgArtwork, svgSupportsTint } from '../lib/svg-sanitizer'

const prisma = new PrismaClient()

/**
 * To samo, co `contentHashOf` w `decorations.service` - powtorzone tutaj,
 * zeby skrypt CLI nie ciagnal za soba serwisu z middlewarem tenantow.
 */
const contentHashOf = (payload: Buffer) => crypto.createHash('sha256').update(payload).digest('hex')

const DRY_RUN = process.env.DRY_RUN === '1'
const CATEGORY = process.env.CATEGORY || undefined
const IDS = (process.env.IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

async function main() {
  const rows = await prisma.decorationAsset.findMany({
    where: {
      mimeType: 'image/svg+xml',
      ...(CATEGORY ? { category: CATEGORY } : {}),
      ...(IDS.length > 0 ? { id: { in: IDS } } : {}),
    },
    orderBy: { createdAt: 'asc' },
  })

  const changed: any[] = []
  const skipped: any[] = []

  for (const row of rows) {
    const fullPath = path.join(config.storage.path, row.filePath)

    let raw: string
    try {
      raw = await fs.readFile(fullPath, 'utf-8')
    } catch (error) {
      skipped.push({ id: row.id, name: row.name, powod: `brak pliku (${(error as Error).message})` })
      continue
    }

    const prepared = prepareSvgArtwork(raw, { tintable: true })
    const tintable = svgSupportsTint(prepared.svg)

    // Nic sie nie zmienilo w tresci ani we flagach - plik byl juz gotowy.
    if (prepared.svg === raw && tintable === row.tintable) {
      skipped.push({ id: row.id, name: row.name, powod: 'juz przygotowany' })
      continue
    }

    const entry = {
      id: row.id,
      name: row.name,
      kategoria: row.category,
      tintablePrzed: row.tintable,
      tintablePo: tintable,
      wypelnienZaKolorem: prepared.tintableFills,
      usunieteSciezkiNoza: prepared.removedCutPaths,
      bajtow: `${row.fileSize} -> ${Buffer.byteLength(prepared.svg, 'utf-8')}`,
    }

    if (!DRY_RUN) {
      await fs.writeFile(fullPath, prepared.svg, 'utf-8')
      await prisma.decorationAsset.update({
        where: { id: row.id },
        data: {
          tintable,
          fileSize: Buffer.byteLength(prepared.svg, 'utf-8'),
          // Tresc pliku wlasnie sie zmienila, wiec stary odcisk juz jej nie opisuje.
          contentHash: contentHashOf(Buffer.from(prepared.svg, 'utf-8')),
        },
      })
    }

    changed.push(entry)
  }

  console.log(
    JSON.stringify(
      {
        dryRun: DRY_RUN,
        sprawdzonych: rows.length,
        naprawionych: changed.length,
        pominietych: skipped.length,
        naprawione: changed,
        pominiete: skipped.slice(0, 20),
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
