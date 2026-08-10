import fs from 'fs/promises';
import path from 'path';
import prisma from '../../lib/prisma';
import { config } from '../../config';

const STORAGE_ROOT = config.storage.path;

/**
 * Katalogi zarzadzane POZA tabelami plikow.
 *
 * Czcionki zyja wylacznie na dysku (`fonts.service` nie ma wpisu w bazie -
 * `Asset` wymaga `caseId`, wiec nie ma ich gdzie trzymac), a szablony maja
 * wlasny cykl zycia. Bez tej listy nocne czyszczenie uznawalo je za
 * osierocone i kasowalo: szablony traciły kroje, a klienci - ozdobniki.
 *
 * Zasada: co nie jest opisane w bazie, musi byc opisane TUTAJ. Trzeciej
 * mozliwosci nie ma - pliku bez wlasciciela nie wolno milczaco skasowac.
 */
const PROTECTED_DIRS = new Set(['templates', 'fonts']);

/**
 * Najmlodszy wiek pliku, ktory wolno rozwazac do usuniecia.
 *
 * Worker zapisuje plik (`saveFile`), a rekord w bazie tworzy dopiero
 * chwile pozniej - w tym oknie plik JEST osierocony. Bez tego progu
 * czyszczenie uruchomione w trakcie renderu paczki 300 winietek kasowalo
 * pliki, ktore wlasnie powstaja.
 */
const MIN_FILE_AGE_MS = 24 * 60 * 60 * 1000;

/** Kategorie plikow - panel pokazuje je osobno, bo znacza co innego. */
export type StorageFileKind = 'preview' | 'print' | 'decoration' | 'other';

export const STORAGE_KIND_LABELS: Record<StorageFileKind, string> = {
  preview: 'Podglądy klienta',
  print: 'Pliki do druku',
  decoration: 'Ozdobniki',
  other: 'Pozostałe',
};

export interface StorageKindStats {
  kind: StorageFileKind;
  files: number;
  bytes: number;
}

interface CleanupStats {
  totalFilesScanned: number;
  orphanedFilesFound: number;
  orphanedFilesDeleted: number;
  spaceSavedBytes: number;
  /** Pliki pominiete, bo sa mlodsze niz `MIN_FILE_AGE_MS`. */
  skippedTooYoung: number;
  /** Pliki pominiete, bo leza w katalogu chronionym. */
  skippedProtected: number;
  /** Podzial kandydatow wedlug rodzaju - to samo, co widzi panel. */
  byKind: StorageKindStats[];
  /** Kilka pierwszych sciezek do podejrzenia przed usunieciem. */
  sample: string[];
  errors: string[];
}

interface CleanupOptions {
  dryRun?: boolean;
  /** Dodatkowy prog wieku, ponad wymuszone 24 h. */
  olderThanDays?: number;
  removeOrphanedOnly?: boolean;
}

/** Ile sciezek pokazac w podgladzie przed usunieciem. */
const SAMPLE_LIMIT = 20;

/** Czy sciezka lezy w katalogu, ktorego nie wolno ruszac. */
function isProtected(relativePath: string): boolean {
  const [topLevel] = relativePath.split(path.sep);
  return PROTECTED_DIRS.has(topLevel);
}

/** Dlaczego plik zostaje albo leci. */
export type CleanupVerdict = 'known' | 'protected' | 'too-young' | 'orphaned';

/**
 * Jedyne miejsce, w ktorym zapada decyzja o usunieciu pliku.
 *
 * Trzy bariery, kazda z osobna juz raz zawiodla:
 * - `knownInDb` - plik opisany w ktorejkolwiek tabeli plikow (brakowalo
 *   `DecorationAsset`, wiec ozdobniki byly "osierocone"),
 * - katalog chroniony (czcionki nie maja wpisu w bazie i nie moga miec),
 * - wiek (plik swiezo zapisany przez workera nie ma jeszcze rekordu).
 */
export function cleanupVerdict(input: {
  relativePath: string;
  ageMs: number;
  knownInDb: boolean;
  minAgeMs?: number;
}): CleanupVerdict {
  if (input.knownInDb) return 'known';
  if (isProtected(input.relativePath)) return 'protected';
  if (input.ageMs < Math.max(MIN_FILE_AGE_MS, input.minAgeMs ?? 0)) return 'too-young';
  return 'orphaned';
}

/** Rodzaj pliku rozpoznany po sciezce - zgodnie z tym, jak zapisuje je worker. */
export function classifyStorageFile(relativePath: string): StorageFileKind {
  const [topLevel] = relativePath.split(path.sep);
  if (topLevel === 'decorations') return 'decoration';

  const fileName = path.basename(relativePath);
  // `podglad-` to PDF podgladowy wysylany klientowi po zatwierdzeniu -
  // dla panelu to ten sam rodzaj co podglad z edytora.
  if (fileName.startsWith('preview-') || fileName.startsWith('podglad-')) return 'preview';
  if (fileName.startsWith('final-') || fileName.startsWith('print-package')) return 'print';

  return 'other';
}

/**
 * Znajduje wszystkie pliki w storage (bez katalogow chronionych).
 */
async function getAllStorageFiles(): Promise<{ files: string[]; protectedCount: number }> {
  const files: string[] = [];
  let protectedCount = 0;

  async function scanDir(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (entry.name.startsWith('.')) continue;
          if (isProtected(path.relative(STORAGE_ROOT, fullPath))) {
            protectedCount += 1;
            continue;
          }
          await scanDir(fullPath);
        } else if (entry.isFile() && !entry.name.startsWith('.')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`[Cleanup] Error scanning ${dir}:`, error);
    }
  }

  await scanDir(STORAGE_ROOT);
  return { files, protectedCount };
}

/**
 * Sciezki plikow znane bazie - ze WSZYSTKICH tabel, ktore trzymaja pliki.
 *
 * `DecorationAsset` byl tu pominiety, wiec biblioteka ozdobnikow sprzedawcy
 * kwalifikowala sie do skasowania jako "osierocona".
 */
async function getAllDatabaseFilePaths(): Promise<Set<string>> {
  const [assets, templateAssets, decorations] = await Promise.all([
    prisma.asset.findMany({ select: { filePath: true } }),
    prisma.templateAsset.findMany({ select: { filePath: true } }),
    prisma.decorationAsset.findMany({ select: { filePath: true } }),
  ]);

  const paths = new Set<string>();

  for (const row of [...assets, ...templateAssets, ...decorations]) {
    paths.add(path.join(STORAGE_ROOT, row.filePath));
  }

  return paths;
}

function summarizeByKind(entries: Array<{ relativePath: string; size: number }>): StorageKindStats[] {
  const totals = new Map<StorageFileKind, StorageKindStats>();

  for (const entry of entries) {
    const kind = classifyStorageFile(entry.relativePath);
    const current = totals.get(kind) || { kind, files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += entry.size;
    totals.set(kind, current);
  }

  return [...totals.values()].sort((a, b) => b.bytes - a.bytes);
}

/**
 * Czyszczenie osieroconych plikow.
 *
 * "Osierocony" = nie ma go w zadnej tabeli plikow ORAZ nie lezy w katalogu
 * chronionym ORAZ jest starszy niz doba. Wszystkie trzy warunki musza byc
 * spelnione - kazdy z osobna juz raz okazal sie za slaby.
 */
export async function cleanupStorage(options: CleanupOptions = {}): Promise<CleanupStats> {
  const {
    dryRun = false,
    olderThanDays,
    removeOrphanedOnly = true,
  } = options;

  console.log('[Cleanup] Starting storage cleanup', { dryRun, olderThanDays, removeOrphanedOnly });

  const stats: CleanupStats = {
    totalFilesScanned: 0,
    orphanedFilesFound: 0,
    orphanedFilesDeleted: 0,
    spaceSavedBytes: 0,
    skippedTooYoung: 0,
    skippedProtected: 0,
    byKind: [],
    sample: [],
    errors: [],
  };

  try {
    const { files: allFiles } = await getAllStorageFiles();
    stats.totalFilesScanned = allFiles.length;

    console.log(`[Cleanup] Found ${allFiles.length} files in storage`);

    const dbFilePaths = await getAllDatabaseFilePaths();
    console.log(`[Cleanup] Found ${dbFilePaths.size} files referenced in database`);

    const now = Date.now();
    // Wymuszona doba, a `olderThanDays` moze prog tylko podniesc.
    const minAgeMs = Math.max(MIN_FILE_AGE_MS, (olderThanDays || 0) * 24 * 60 * 60 * 1000);

    const orphaned: Array<{ fullPath: string; relativePath: string; size: number }> = [];

    for (const file of allFiles) {
      const relativePath = path.relative(STORAGE_ROOT, file);
      const knownInDb = dbFilePaths.has(file);

      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        stats.errors.push(`Cannot stat file: ${file}`);
        continue;
      }

      const verdict = cleanupVerdict({
        relativePath,
        ageMs: now - stat.mtimeMs,
        knownInDb,
        minAgeMs,
      });

      if (verdict === 'too-young') stats.skippedTooYoung += 1;
      if (verdict === 'protected') stats.skippedProtected += 1;
      if (verdict !== 'orphaned') continue;

      orphaned.push({ fullPath: file, relativePath, size: stat.size });
    }

    stats.orphanedFilesFound = orphaned.length;
    stats.byKind = summarizeByKind(orphaned);
    stats.sample = orphaned.slice(0, SAMPLE_LIMIT).map((entry) => entry.relativePath);

    console.log(`[Cleanup] Found ${orphaned.length} orphaned files`);

    if (removeOrphanedOnly && orphaned.length > 0) {
      for (const entry of orphaned) {
        if (dryRun) {
          stats.spaceSavedBytes += entry.size;
          continue;
        }

        try {
          await fs.unlink(entry.fullPath);
          stats.orphanedFilesDeleted += 1;
          stats.spaceSavedBytes += entry.size;
        } catch (error) {
          const msg = `Error deleting ${entry.relativePath}: ${error instanceof Error ? error.message : 'Unknown'}`;
          stats.errors.push(msg);
          console.error(`[Cleanup] ${msg}`);
        }
      }
    }

    if (!dryRun && stats.orphanedFilesDeleted > 0) {
      await cleanupEmptyDirectories(STORAGE_ROOT);
    }
  } catch (error) {
    const msg = `Fatal error during cleanup: ${error instanceof Error ? error.message : 'Unknown'}`;
    stats.errors.push(msg);
    console.error(`[Cleanup] ${msg}`);
  }

  console.log('[Cleanup] Cleanup complete', {
    filesScanned: stats.totalFilesScanned,
    orphanedFound: stats.orphanedFilesFound,
    deleted: stats.orphanedFilesDeleted,
    tooYoung: stats.skippedTooYoung,
    spaceSaved: `${(stats.spaceSavedBytes / 1024 / 1024).toFixed(2)} MB`,
    errors: stats.errors.length,
  });

  return stats;
}

/**
 * Usuwa puste katalogi rekursywnie (poza chronionymi).
 */
async function cleanupEmptyDirectories(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      if (isProtected(path.relative(STORAGE_ROOT, fullPath))) continue;
      await cleanupEmptyDirectories(fullPath);
    }

    const remaining = await fs.readdir(dir);
    const hasVisibleFiles = remaining.some((name) => !name.startsWith('.'));

    if (!hasVisibleFiles && dir !== STORAGE_ROOT) {
      await fs.rmdir(dir);
      console.log(`[Cleanup] Removed empty directory: ${dir}`);
    }
  } catch {
    // Ignoruj bledy przy usuwaniu katalogow
  }
}

/**
 * Usuwa stare preview dla case (po zmianie statusu lub edycji)
 */
export async function cleanupCasePreview(caseId: string): Promise<void> {
  console.log(`[Cleanup] Cleaning up old previews for case ${caseId}`);

  try {
    const previews = await prisma.asset.findMany({
      where: { caseId, assetType: 'PNG_PREVIEW' },
      orderBy: { createdAt: 'desc' },
    });

    // Zachowaj tylko najnowszy, usuń resztę
    if (previews.length > 1) {
      const toDelete = previews.slice(1);

      for (const preview of toDelete) {
        const fullPath = path.join(STORAGE_ROOT, preview.filePath);

        try {
          await fs.unlink(fullPath);
          await prisma.asset.delete({ where: { id: preview.id } });
          console.log(`[Cleanup] Deleted old preview: ${preview.filePath}`);
        } catch (error) {
          console.error(`[Cleanup] Error deleting preview ${preview.filePath}:`, error);
        }
      }
    }
  } catch (error) {
    console.error(`[Cleanup] Error cleaning case ${caseId} previews:`, error);
  }
}

export type { CleanupStats, CleanupOptions };
export { MIN_FILE_AGE_MS, PROTECTED_DIRS };
