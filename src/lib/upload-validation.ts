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

function startsWith(buffer: Buffer, signature: Buffer) {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

export function assertAllowedImageUpload(buffer: Buffer, mimetype: string) {
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimetype as AllowedImageMimeType)) {
    throw new Error(`Niedozwolony typ pliku: ${mimetype}. Dozwolone: PNG, JPG, WebP`);
  }

  const isPng = mimetype === 'image/png' && startsWith(buffer, PNG_SIGNATURE);
  const isJpeg = mimetype === 'image/jpeg' && startsWith(buffer, JPEG_SIGNATURE);
  const isWebp = mimetype === 'image/webp' &&
    startsWith(buffer, WEBP_RIFF_SIGNATURE) &&
    buffer.length >= 12 &&
    buffer.subarray(8, 12).equals(WEBP_FORMAT_SIGNATURE);

  if (!isPng && !isJpeg && !isWebp) {
    throw new Error('Sygnatura pliku nie zgadza się z deklarowanym typem MIME');
  }
}

export function assertAllowedPngUpload(buffer: Buffer, mimetype: string) {
  if (mimetype !== 'image/png' || !startsWith(buffer, PNG_SIGNATURE)) {
    throw new Error('Plik musi być poprawnym obrazem PNG');
  }
}

export function assertAllowedFontUpload(buffer: Buffer, extension: string) {
  const normalizedExtension = extension.toLowerCase();
  if (!ALLOWED_FONT_EXTENSIONS.includes(normalizedExtension as AllowedFontExtension)) {
    throw new Error(`Niedozwolony format: .${extension}. Dozwolone: TTF, OTF, WOFF, WOFF2`);
  }

  const isValid =
    (normalizedExtension === 'ttf' && startsWith(buffer, TTF_SIGNATURE)) ||
    (normalizedExtension === 'otf' && startsWith(buffer, OTF_SIGNATURE)) ||
    (normalizedExtension === 'woff' && startsWith(buffer, WOFF_SIGNATURE)) ||
    (normalizedExtension === 'woff2' && startsWith(buffer, WOFF2_SIGNATURE));

  if (!isValid) {
    throw new Error('Sygnatura pliku czcionki nie zgadza się z rozszerzeniem');
  }
}
