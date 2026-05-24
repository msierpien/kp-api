import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  UploadValidationError,
  assertAllowedFontUpload,
  assertAllowedImageUpload,
  assertAllowedPngUpload,
  imageExtensionForMimeType,
} from '../src/lib/upload-validation';

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const jpg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const ttf = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00]);

describe('upload validation', () => {
  it('accepts images only when MIME type and magic bytes match', () => {
    assert.doesNotThrow(() => assertAllowedImageUpload(png, 'image/png'));
    assert.doesNotThrow(() => assertAllowedImageUpload(jpg, 'image/jpeg'));
    assert.doesNotThrow(() => assertAllowedImageUpload(webp, 'image/webp'));

    assert.throws(
      () => assertAllowedImageUpload(png, 'image/jpeg'),
      UploadValidationError,
    );
  });

  it('rejects SVG and other active content even when uploaded as an image asset', () => {
    assert.throws(
      () => assertAllowedImageUpload(svg, 'image/svg+xml'),
      UploadValidationError,
    );
  });

  it('enforces per-upload size limits', () => {
    assert.throws(
      () => assertAllowedPngUpload(Buffer.concat([png, Buffer.alloc(10)]), 'image/png', { maxBytes: png.length }),
      /za duży/,
    );
  });

  it('validates font signatures by extension', () => {
    assert.doesNotThrow(() => assertAllowedFontUpload(ttf, 'ttf'));
    assert.throws(
      () => assertAllowedFontUpload(ttf, 'woff2'),
      UploadValidationError,
    );
  });

  it('maps stored image extensions from MIME type, not user filename', () => {
    assert.equal(imageExtensionForMimeType('image/png'), 'png');
    assert.equal(imageExtensionForMimeType('image/jpeg'), 'jpg');
    assert.equal(imageExtensionForMimeType('image/webp'), 'webp');
  });
});
