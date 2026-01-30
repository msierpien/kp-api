import fs from 'fs/promises';
import path from 'path';
import prisma from '../../lib/prisma';
import { config } from '../../config';

const STORAGE_ROOT = config.storage.path;

interface CleanupStats {
  totalFilesScanned: number;
  orphanedFilesFound: number;
  orphanedFilesDeleted: number;
  spaceSavedBytes: number;
  errors: string[];
}

interface CleanupOptions {
  dryRun?: boolean; // Nie usuwa, tylko raportuje
  olderThanDays?: number; // Usuń preview starsze niż X dni
  removeOrphanedOnly?: boolean; // Tylko orphaned files (nie w DB)
}

/**
 * Znajduje wszystkie pliki w storage
 */
async function getAllStorageFiles(): Promise<string[]> {
  const files: string[] = [];
  
  async function scanDir(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          // Skip hidden directories and templates (managed separately)
          if (!entry.name.startsWith('.') && entry.name !== 'templates') {
            await scanDir(fullPath);
          }
        } else if (entry.isFile() && !entry.name.startsWith('.')) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`[Cleanup] Error scanning ${dir}:`, error);
    }
  }
  
  await scanDir(STORAGE_ROOT);
  return files;
}

/**
 * Pobiera wszystkie ścieżki plików z bazy danych
 */
async function getAllDatabaseFilePaths(): Promise<Set<string>> {
  const assets = await prisma.asset.findMany({
    select: { filePath: true },
  });
  
  const templateAssets = await prisma.templateAsset.findMany({
    select: { filePath: true },
  });
  
  const paths = new Set<string>();
  
  // Normalizuj ścieżki z DB (relatywne)
  assets.forEach(asset => {
    const fullPath = path.join(STORAGE_ROOT, asset.filePath);
    paths.add(fullPath);
  });
  
  templateAssets.forEach(asset => {
    const fullPath = path.join(STORAGE_ROOT, asset.filePath);
    paths.add(fullPath);
  });
  
  return paths;
}

/**
 * Główna funkcja cleanup storage
 */
export async function cleanupStorage(options: CleanupOptions = {}): Promise<CleanupStats> {
  const {
    dryRun = false,
    olderThanDays,
    removeOrphanedOnly = true,
  } = options;

  console.log('[Cleanup] Starting storage cleanup', {
    dryRun,
    olderThanDays,
    removeOrphanedOnly,
  });

  const stats: CleanupStats = {
    totalFilesScanned: 0,
    orphanedFilesFound: 0,
    orphanedFilesDeleted: 0,
    spaceSavedBytes: 0,
    errors: [],
  };

  try {
    // 1. Znajdź wszystkie pliki w storage
    const allFiles = await getAllStorageFiles();
    stats.totalFilesScanned = allFiles.length;
    
    console.log(`[Cleanup] Found ${allFiles.length} files in storage`);

    // 2. Pobierz wszystkie ścieżki z bazy
    const dbFilePaths = await getAllDatabaseFilePaths();
    
    console.log(`[Cleanup] Found ${dbFilePaths.size} files referenced in database`);

    // 3. Znajdź orphaned files (w storage ale nie w DB)
    const orphanedFiles: string[] = [];
    const now = Date.now();
    
    for (const file of allFiles) {
      if (!dbFilePaths.has(file)) {
        // Jeśli jest filtr wieku, sprawdź datę modyfikacji
        if (olderThanDays) {
          try {
            const stat = await fs.stat(file);
            const fileAge = (now - stat.mtimeMs) / (1000 * 60 * 60 * 24); // dni
            
            if (fileAge < olderThanDays) {
              continue; // Plik jest za młody, pomiń
            }
          } catch (error) {
            stats.errors.push(`Cannot stat file: ${file}`);
            continue;
          }
        }
        
        orphanedFiles.push(file);
      }
    }
    
    stats.orphanedFilesFound = orphanedFiles.length;
    
    console.log(`[Cleanup] Found ${orphanedFiles.length} orphaned files`);

    // 4. Usuń orphaned files
    if (removeOrphanedOnly && orphanedFiles.length > 0) {
      for (const file of orphanedFiles) {
        try {
          const stat = await fs.stat(file);
          
          if (!dryRun) {
            await fs.unlink(file);
            stats.orphanedFilesDeleted++;
            stats.spaceSavedBytes += stat.size;
            console.log(`[Cleanup] Deleted: ${file} (${(stat.size / 1024).toFixed(2)} KB)`);
          } else {
            stats.spaceSavedBytes += stat.size;
            console.log(`[Cleanup] Would delete: ${file} (${(stat.size / 1024).toFixed(2)} KB)`);
          }
        } catch (error) {
          const msg = `Error deleting ${file}: ${error instanceof Error ? error.message : 'Unknown'}`;
          stats.errors.push(msg);
          console.error(`[Cleanup] ${msg}`);
        }
      }
    }

    // 5. Cleanup pustych folderów
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
    spaceSaved: `${(stats.spaceSavedBytes / 1024 / 1024).toFixed(2)} MB`,
    errors: stats.errors.length,
  });

  return stats;
}

/**
 * Usuwa puste katalogi rekursywnie
 */
async function cleanupEmptyDirectories(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    // Rekursywnie sprawdź podkatalogi
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        const fullPath = path.join(dir, entry.name);
        await cleanupEmptyDirectories(fullPath);
      }
    }
    
    // Sprawdź czy katalog jest pusty po usunięciu podkatalogów
    const remaining = await fs.readdir(dir);
    const hasVisibleFiles = remaining.some(name => !name.startsWith('.'));
    
    if (!hasVisibleFiles && dir !== STORAGE_ROOT) {
      await fs.rmdir(dir);
      console.log(`[Cleanup] Removed empty directory: ${dir}`);
    }
  } catch (error) {
    // Ignoruj błędy przy usuwaniu katalogów
  }
}

/**
 * Usuwa stare preview dla case (po zmianie statusu lub edycji)
 */
export async function cleanupCasePreview(caseId: string): Promise<void> {
  console.log(`[Cleanup] Cleaning up old previews for case ${caseId}`);
  
  try {
    // Znajdź wszystkie PNG_PREVIEW dla tego case
    const previews = await prisma.asset.findMany({
      where: {
        caseId,
        assetType: 'PNG_PREVIEW',
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    
    // Zachowaj tylko najnowszy, usuń resztę
    if (previews.length > 1) {
      const toDelete = previews.slice(1); // Wszystkie oprócz pierwszego (najnowszego)
      
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
