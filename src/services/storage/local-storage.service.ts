import fs from 'fs/promises';
import path from 'path';
import { nanoid } from 'nanoid';
import mime from 'mime-types';

const STORAGE_ROOT = process.env.STORAGE_PATH || path.join(process.cwd(), 'storage');
const BASE_URL = process.env.API_URL || 'http://localhost:3001';

interface SaveFileOptions {
  orderId: string;
  templateVersion: number;
  filename?: string;
  extension: string;
}

interface StoredFile {
  path: string;
  relativePath: string;
  url: string;
  filename: string;
  size: number;
}

/**
 * Inicjalizuje katalog storage
 */
export async function initStorage(): Promise<void> {
  try {
    await fs.mkdir(STORAGE_ROOT, { recursive: true });
    console.log(`[Storage] Storage root initialized: ${STORAGE_ROOT}`);
  } catch (error) {
    console.error('[Storage] Failed to initialize storage:', error);
    throw error;
  }
}

/**
 * Zapisuje plik do lokalnego storage
 */
export async function saveFile(
  buffer: Buffer,
  options: SaveFileOptions
): Promise<StoredFile> {
  const { orderId, templateVersion, filename, extension } = options;

  // Folder: storage/orderId/v{templateVersion}/
  const folderPath = path.join(STORAGE_ROOT, orderId, `v${templateVersion}`);
  await fs.mkdir(folderPath, { recursive: true });

  // Nazwa pliku: {filename}-{nanoid}.{extension}
  const fileId = nanoid(10);
  const baseName = filename || 'asset';
  const fileName = `${baseName}-${fileId}.${extension}`;
  const filePath = path.join(folderPath, fileName);

  // Zapisz plik
  await fs.writeFile(filePath, buffer);

  // Relatywna ścieżka od storage root
  const relativePath = path.relative(STORAGE_ROOT, filePath);

  // URL: /storage/{relativePath}
  const url = `${BASE_URL}/storage/${relativePath.replace(/\\/g, '/')}`;

  return {
    path: relativePath,
    relativePath,
    url,
    filename: fileName,
    size: buffer.length,
  };
}

/**
 * Odczytuje plik z lokalnego storage
 */
export async function readFile(relativePath: string): Promise<Buffer> {
  const fullPath = path.join(STORAGE_ROOT, relativePath);
  return fs.readFile(fullPath);
}

/**
 * Usuwa plik z lokalnego storage
 */
export async function deleteFile(relativePath: string): Promise<void> {
  const fullPath = path.join(STORAGE_ROOT, relativePath);
  await fs.unlink(fullPath);
}

/**
 * Sprawdza czy plik istnieje
 */
export async function fileExists(relativePath: string): Promise<boolean> {
  try {
    const fullPath = path.join(STORAGE_ROOT, relativePath);
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Zwraca MIME type na podstawie rozszerzenia
 */
export function getMimeType(filename: string): string {
  return mime.lookup(filename) || 'application/octet-stream';
}

/**
 * Generuje URL z TTL (dla przyszłych signed URLs)
 * Na razie zwraca normalny URL
 */
export function generateSignedUrl(
  relativePath: string,
  expiresInSeconds: number = 3600
): string {
  // TODO: Implementacja signed URLs z tokenem lub HMAC
  // Na razie zwracamy normalny URL
  const url = `${BASE_URL}/storage/${relativePath.replace(/\\/g, '/')}`;
  return url;
}

/**
 * Pobiera rozmiar pliku w bajtach
 */
export async function getFileSize(relativePath: string): Promise<number> {
  const fullPath = path.join(STORAGE_ROOT, relativePath);
  const stats = await fs.stat(fullPath);
  return stats.size;
}
