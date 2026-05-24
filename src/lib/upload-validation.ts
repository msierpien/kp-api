const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_RIFF_SIGNATURE = Buffer.from('RIFF');
const WEBP_FORMAT_SIGNATURE = Buffer.from('WEBP');
const TTF_SIGNATURE = Buffer.from([0x00, 0x01, 0x00, 0x00]);
const OTF_SIGNATURE = Buffer.from('OTTO');
const WOFF_SIGNATURE = Buffer.from('wOFF');
const WOFF2_SIGNATURE = Buffer.from('wOF2');

export type AllowedImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type AllowedFontExtension = 'ttf' | 'otf' | 'woff' | 'woff2';

export const ALLOWED_IMAGE_MIME_TYPES: AllowedImageMimeType[] = ['image/png', 'image/jpeg', 'image/webp'];
export const ALLOWED_FONT_EXTENSIONS: AllowedFontExtension[] = ['ttf', 'otf', 'woff', 'woff2'];
export const MAX_TEMPLATE_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_PREVIEW_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_FONT_UPLOAD_BYTES = 2 * 1024 * 1024;

type UploadValidationOptions = {
  maxBytes?: number;
};

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadValidationError';
  }
}

export function isUploadValidationError(error: unknown): error is Error {
  return error instanceof UploadValidationError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE');
}

function startsWith(buffer: Buffer, signature: Buffer) {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

function assertUploadSize(buffer: Buffer, maxBytes: number | undefined, label: string) {
  if (maxBytes === undefined) return;
  if (buffer.length > maxBytes) {
    const maxMb = (maxBytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '');
    throw new UploadValidationError(`${label} jest za duży. Maksymalny rozmiar: ${maxMb} MB`);
  }
}

export function imageExtensionForMimeType(mimetype: string): 'png' | 'jpg' | 'webp' {
  if (mimetype === 'image/png') return 'png';
  if (mimetype === 'image/jpeg') return 'jpg';
  if (mimetype === 'image/webp') return 'webp';
  throw new UploadValidationError(`Niedozwolony typ pliku: ${mimetype}. Dozwolone: PNG, JPG, WebP`);
}

export function assertAllowedImageUpload(
  buffer: Buffer,
  mimetype: string,
  options: UploadValidationOptions = {}
) {
  assertUploadSize(buffer, options.maxBytes, 'Plik graficzny');

  if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimetype as AllowedImageMimeType)) {
    throw new UploadValidationError(`Niedozwolony typ pliku: ${mimetype}. Dozwolone: PNG, JPG, WebP`);
  }

  const isPng = mimetype === 'image/png' && startsWith(buffer, PNG_SIGNATURE);
  const isJpeg = mimetype === 'image/jpeg' && startsWith(buffer, JPEG_SIGNATURE);
  const isWebp = mimetype === 'image/webp' &&
    startsWith(buffer, WEBP_RIFF_SIGNATURE) &&
    buffer.length >= 12 &&
    buffer.subarray(8, 12).equals(WEBP_FORMAT_SIGNATURE);

  if (!isPng && !isJpeg && !isWebp) {
    throw new UploadValidationError('Sygnatura pliku nie zgadza się z deklarowanym typem MIME');
  }
}

export function assertAllowedPngUpload(
  buffer: Buffer,
  mimetype: string,
  options: UploadValidationOptions = {}
) {
  assertUploadSize(buffer, options.maxBytes, 'Podgląd PNG');

  if (mimetype !== 'image/png' || !startsWith(buffer, PNG_SIGNATURE)) {
    throw new UploadValidationError('Plik musi być poprawnym obrazem PNG');
  }
}

export function assertAllowedFontUpload(
  buffer: Buffer,
  extension: string,
  options: UploadValidationOptions = {}
) {
  assertUploadSize(buffer, options.maxBytes, 'Plik czcionki');

  const normalizedExtension = extension.toLowerCase();
  if (!ALLOWED_FONT_EXTENSIONS.includes(normalizedExtension as AllowedFontExtension)) {
    throw new UploadValidationError(`Niedozwolony format: .${extension}. Dozwolone: TTF, OTF, WOFF, WOFF2`);
  }

  const isValid =
    (normalizedExtension === 'ttf' && startsWith(buffer, TTF_SIGNATURE)) ||
    (normalizedExtension === 'otf' && startsWith(buffer, OTF_SIGNATURE)) ||
    (normalizedExtension === 'woff' && startsWith(buffer, WOFF_SIGNATURE)) ||
    (normalizedExtension === 'woff2' && startsWith(buffer, WOFF2_SIGNATURE));

  if (!isValid) {
    throw new UploadValidationError('Sygnatura pliku czcionki nie zgadza się z rozszerzeniem');
  }
}
