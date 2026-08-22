/**
 * Przycina plotno SVG ozdobnika do samego rysunku.
 *
 * Po co: Silhouette Studio zapisuje jako plotno CALA karte A4
 * (`viewBox="0 0 210 297"`), a rysunek zostawia tam, gdzie lezal na macie.
 * Ozdobnik z takiego eksportu ma wiec 60-70% pustego pola, a zaden z rendererow
 * nie patrzy na `properties.fit` - i kp-api (`fabric-renderer.service`),
 * i portal (`layer-factory`) rozciagaja grafike wprost do ramki warstwy:
 *
 *   scaleX = layer.width / img.width,  scaleY = layer.height / img.height
 *
 * Plotno A4 (proporcja 0,707) wciskane w ramke o proporcji 2,5 splaszcza
 * rysunek ponad trzykrotnie. Winietka "Bordowa Fala" miala tak ramke
 * 827 x 125 px zamiast 827 x 442.
 *
 * Po przycieciu ramka warstwy pokrywa sie z rysunkiem, wiec `width`/`height`
 * warstwy wreszcie opisuja to, co widac, a proporcje ustawia sie raz w edytorze.
 *
 * UWAGA. Przyciecie zmienia uklad wspolrzednych pliku. Nie uruchamiaj go na
 * grafice, z ktorej `extractCutPathsSvg` ma wyciagac sciezki noza - tamte
 * musza zostac w skali arkusza, zeby w Studio trafily tam, gdzie ma ciac nóż.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   node dist/scripts/crop-decoration-canvas.js
 *   IDS=a,b,c   - ktore ozdobniki (wymagane, celowo nie ma trybu "wszystkie")
 *   DRY_RUN=1   - tylko pomiar i plan, zero zapisow
 */
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { config } from '../config'

const prisma = new PrismaClient()

const DRY_RUN = process.env.DRY_RUN === '1'
const IDS = (process.env.IDS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

/**
 * Zapas na grubosc kreski - obrys wychodzi poza sciezke o pol swojej szerokosci.
 *
 * Liczony od WIELKOSCI RYSUNKU, nie od plotna. Ulamek plotna nie nadaje sie
 * na miare: po przycieciu ten sam margines jest wiekszym procentem mniejszego
 * plotna, wiec kolejne uruchomienie znowu widzialoby "za duzo pustego pola"
 * i przycinalo w kolko.
 */
const PADDING = 0.005

/**
 * Ile margines moze odbiegac od docelowego, zeby plotno uznac za przyciete.
 * Wieksze niz sam zapas - inaczej blad pomiaru o jeden piksel rastra
 * wystarczylby, zeby skrypt przepisal plik bez powodu.
 */
const TOLERANCE = PADDING * 1.5

const contentHashOf = (payload: Buffer) => crypto.createHash('sha256').update(payload).digest('hex')

/** Ramka rysunku w ulamkach plotna - mierzona na rastrze, po kanale alfa. */
async function artworkBox(svg: string) {
  const { Resvg } = await import('@resvg/resvg-js')
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: 1000 }, font: { loadSystemFonts: false } })
    .render()
    .asPng()

  const { loadImage, createCanvas } = await import('canvas')
  const image = await loadImage(png)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image as any, 0, 0)
  const data = ctx.getImageData(0, 0, image.width, image.height).data

  let x0 = image.width
  let y0 = image.height
  let x1 = -1
  let y1 = -1

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (data[(y * image.width + x) * 4 + 3] <= 16) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }

  if (x1 < 0) return null
  return {
    x0: x0 / image.width,
    x1: (x1 + 1) / image.width,
    y0: y0 / image.height,
    y1: (y1 + 1) / image.height,
  }
}

/**
 * Podmienia `viewBox` i zdejmuje `width`/`height` WYLACZNIE z korzenia.
 *
 * Atrybuty rozmiaru zostawione po przycieciu klamia o rozmiarze wlasnym pliku,
 * a to z nich przegladarka liczy `img.width` w portalu. Zdjete - proporcje
 * biora sie z samego `viewBox` i serwer z portalem licza tak samo.
 */
function rewriteRootSvg(svg: string, viewBox: string) {
  const match = svg.match(/<svg\b[^>]*>/i)
  if (!match) return null

  const rewritten = match[0]
    .replace(/\sviewBox\s*=\s*(["'])[\s\S]*?\1/i, '')
    .replace(/\swidth\s*=\s*(["'])[\s\S]*?\1/i, '')
    .replace(/\sheight\s*=\s*(["'])[\s\S]*?\1/i, '')
    .replace(/\s*\/?>$/, (tail) => ` viewBox="${viewBox}"${tail.trim() === '/>' ? '/>' : '>'}`)

  return svg.replace(match[0], rewritten)
}

async function main() {
  if (IDS.length === 0) {
    throw new Error('Podaj IDS - skrypt celowo nie ma trybu "wszystkie", bo przesuwa rysunek w kazdej warstwie, ktora go uzywa')
  }

  const rows = await prisma.decorationAsset.findMany({
    where: { id: { in: IDS }, mimeType: 'image/svg+xml' },
    orderBy: { createdAt: 'asc' },
  })

  const changed: any[] = []
  const skipped: any[] = []

  for (const row of rows) {
    const fullPath = path.join(config.storage.path, row.filePath)
    const raw = await fs.readFile(fullPath, 'utf-8')

    const viewBox = raw.match(/viewBox\s*=\s*["']([^"']+)["']/i)?.[1]
    if (!viewBox) {
      skipped.push({ id: row.id, name: row.name, powod: 'plik nie ma viewBox - nie ma w czym liczyc przyciecia' })
      continue
    }

    const [vx, vy, vw, vh] = viewBox.trim().split(/[\s,]+/).map(Number)
    if (![vx, vy, vw, vh].every(Number.isFinite) || vw <= 0 || vh <= 0) {
      skipped.push({ id: row.id, name: row.name, powod: `nieczytelny viewBox "${viewBox}"` })
      continue
    }

    const box = await artworkBox(raw)
    if (!box) {
      skipped.push({ id: row.id, name: row.name, powod: 'raster jest pusty - nie ma czego przycinac' })
      continue
    }

    // Wszystko dalej w jednostkach viewBoxa - tylko w nich margines znaczy
    // to samo przed przycieciem i po nim.
    const artwork = {
      x0: vx + box.x0 * vw,
      x1: vx + box.x1 * vw,
      y0: vy + box.y0 * vh,
      y1: vy + box.y1 * vh,
    }
    const artworkWidth = artwork.x1 - artwork.x0
    const artworkHeight = artwork.y1 - artwork.y0
    const pad = PADDING * Math.max(artworkWidth, artworkHeight)
    const slack = TOLERANCE * Math.max(artworkWidth, artworkHeight)

    const target = {
      x: artwork.x0 - pad,
      y: artwork.y0 - pad,
      width: artworkWidth + 2 * pad,
      height: artworkHeight + 2 * pad,
    }

    const alreadyCropped =
      Math.abs(target.x - vx) <= slack &&
      Math.abs(target.y - vy) <= slack &&
      Math.abs(target.width - vw) <= slack &&
      Math.abs(target.height - vh) <= slack

    if (alreadyCropped) {
      skipped.push({ id: row.id, name: row.name, powod: 'plotno juz przyciete do rysunku' })
      continue
    }

    const nextViewBox = [target.x, target.y, target.width, target.height]
      .map((value) => Number(value.toFixed(4)))
      .join(' ')

    const output = rewriteRootSvg(raw, nextViewBox)
    if (!output) {
      skipped.push({ id: row.id, name: row.name, powod: 'nie znalazlem korzenia <svg>' })
      continue
    }

    const entry = {
      id: row.id,
      name: row.name,
      viewBoxPrzed: viewBox,
      viewBoxPo: nextViewBox,
      rysunekZajmowalPlotno: `${(((box.x1 - box.x0) * 100)).toFixed(1)}% x ${(((box.y1 - box.y0) * 100)).toFixed(1)}%`,
      proporcjaPrzed: Number((vw / vh).toFixed(3)),
      proporcjaPo: Number((target.width / target.height).toFixed(3)),
    }

    if (!DRY_RUN) {
      await fs.writeFile(fullPath, output, 'utf-8')
      await prisma.decorationAsset.update({
        where: { id: row.id },
        data: {
          fileSize: Buffer.byteLength(output, 'utf-8'),
          contentHash: contentHashOf(Buffer.from(output, 'utf-8')),
        },
      })
    }

    changed.push(entry)
  }

  const brakujace = IDS.filter((id) => !rows.some((row) => row.id === id))

  console.log(
    JSON.stringify(
      {
        dryRun: DRY_RUN,
        przycietych: changed.length,
        pominietych: skipped.length,
        ...(brakujace.length > 0 ? { nieZnalezione: brakujace } : {}),
        przyciete: changed,
        pominiete: skipped,
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
