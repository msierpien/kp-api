import fs from 'fs/promises';
import path from 'path';
import { nanoid } from 'nanoid';
import mime from 'mime-types';
import { config } from '../../config';

const STORAGE_ROOT = config.storage.path;
const PUBLIC_STORAGE_URL = config.storage.publicUrl;

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

  // URL: używamy publicUrl z config
  const url = buildStorageUrl(relativePath);

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
 * Buduje publiczny URL do pliku w storage
 * Używa config.storage.publicUrl (http://localhost:3001/storage)
 */
export function buildStorageUrl(relativePath: string): string {
  return `${PUBLIC_STORAGE_URL}/${relativePath.replace(/\\/g, '/')}`;
}

/**
 * Buduje publiczny URL tylko jeśli plik istnieje
 * Zwraca null jeśli plik nie istnieje
 */
export async function buildStorageUrlSafe(relativePath: string): Promise<string | null> {
  const exists = await fileExists(relativePath);
  if (!exists) {
    return null;
  }
  return buildStorageUrl(relativePath);
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
  return buildStorageUrl(relativePath);
}

/**
 * Pobiera rozmiar pliku w bajtach
 */
export async function getFileSize(relativePath: string): Promise<number> {
  const fullPath = path.join(STORAGE_ROOT, relativePath);
  const stats = await fs.stat(fullPath);
  return stats.size;
}
