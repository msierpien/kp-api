/**
 * Jednorazowe sprzatanie zaleglych plikow paczek do druku.
 *
 * Panel pokazuje wylacznie NAJNOWSZA paczke sprawy, wiec starsze byly
 * niewidoczne i tylko rosly na dysku - od 2026-08-10 generowanie kasuje je
 * samo, ale to, co uzbieralo sie wczesniej, trzeba usunac raz recznie.
 *
 * Zostawia najnowsza paczke kazdej sprawy (ZIP plus pliki wyrenderowane
 * razem z nim) i pomija pliki z TRWAJACYM wydrukiem - `PrintJob` kasuje sie
 * kaskadowo razem z assetem, wiec usuniecie zabraloby agentowi zadanie.
 *
 * Uruchamiany W KONTENERZE `personalization-api`:
 *   DRY_RUN=1 node dist/scripts/cleanup-old-print-assets.js   # raport
 *   node dist/scripts/cleanup-old-print-assets.js             # usuwanie
 */
import { PrismaClient } from '@prisma/client'
import { deleteFile } from '../services/storage/local-storage.service'
import { PRINT_JOB_ACTIVE_STATUSES } from '../lib/print-job-statuses'

const prisma = new PrismaClient()

const ASSET_TYPES = ['PRINT_PACKAGE_ZIP', 'PDF_PRINT', 'PNG_PRINT']

/**
 * Okno „ta sama paczka": pliki sztuk powstaja chwile przed ZIP-em, wiec
 * najnowsza paczke rozpoznajemy po czasie, a nie po pojedynczym id.
 */
const PACKAGE_WINDOW_MS = 30 * 60 * 1000

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10

async function main() {
  const dryRun = process.env.DRY_RUN === '1'

  const cases = await prisma.asset.groupBy({
    by: ['caseId'],
    where: { assetType: { in: ASSET_TYPES } },
    _count: { _all: true },
  })

  let totalDeleted = 0
  let totalBytes = 0
  let totalSkipped = 0
  const perCase: string[] = []

  for (const group of cases) {
    const assets = await prisma.asset.findMany({
      where: { caseId: group.caseId, assetType: { in: ASSET_TYPES } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        filePath: true,
        fileSize: true,
        createdAt: true,
        printJobs: {
          where: { status: { in: [...PRINT_JOB_ACTIVE_STATUSES] } },
          select: { id: true },
        },
      },
    })

    if (assets.length === 0) continue

    // Najnowsza paczka = wszystko z ostatniego okna czasowego.
    const newest = assets[0].createdAt.getTime()
    const stale = assets.filter(
      (asset) => newest - asset.createdAt.getTime() > PACKAGE_WINDOW_MS
    )
    const removable = stale.filter((asset) => asset.printJobs.length === 0)
    totalSkipped += stale.length - removable.length

    if (removable.length === 0) continue

    const bytes = removable.reduce((sum, asset) => sum + asset.fileSize, 0)
    totalDeleted += removable.length
    totalBytes += bytes
    perCase.push(`${group.caseId}: ${removable.length} plików (${mb(bytes)} MB)`)

    if (dryRun) continue

    await prisma.asset.deleteMany({ where: { id: { in: removable.map((a) => a.id) } } })
    for (const asset of removable) {
      try {
        await deleteFile(asset.filePath)
      } catch {
        // Brak pliku nie jest bledem - wpis i tak zniknal z bazy.
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        spraw: cases.length,
        doUsuniecia: totalDeleted,
        zwolnioneMB: mb(totalBytes),
        pominieteZWydrukiem: totalSkipped,
        szczegoly: perCase.slice(0, 20),
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
