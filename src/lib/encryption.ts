import crypto from 'crypto';
import { config } from '../config';

// Pobierz klucz szyfrowania z config (32 bajty dla AES-256)
const ENCRYPTION_KEY = config.encryption.key;
const ALGORITHM = 'aes-256-gcm';
const LEGACY_ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 12;
const LEGACY_IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const VERSION_PREFIX = 'v2';

function getKey() {
  return Buffer.from(ENCRYPTION_KEY, 'utf8');
}

/**
 * Szyfruje tekst używając AES-256-GCM.
 */
export function encrypt(text: string): string {
  if (!text) return '';

  try {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return [
      VERSION_PREFIX,
      iv.toString('hex'),
      authTag.toString('hex'),
      encrypted,
    ].join(':');
  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Encryption failed');
  }
}

/**
 * Deszyfruje tekst zaszyfrowany encrypt()
 */
export function decrypt(text: string): string {
  if (!text) return '';

  try {
    const parts = text.split(':');

    if (parts[0] === VERSION_PREFIX) {
      if (parts.length !== 4) {
        throw new Error('Invalid encrypted payload');
      }

      const key = getKey();
      const iv = Buffer.from(parts[1], 'hex');
      const authTag = Buffer.from(parts[2], 'hex');
      const encryptedText = parts[3];

      if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
        throw new Error('Invalid encrypted payload');
      }

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    }

    if (parts.length === 2) {
      const key = getKey();
      const iv = Buffer.from(parts[0], 'hex');
      const encryptedText = parts[1];
      if (iv.length !== LEGACY_IV_LENGTH) return text;

      const decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    }

    // Backward compatibility for old plaintext values.
    return text;
  } catch (error) {
    if (text.startsWith(`${VERSION_PREFIX}:`)) {
      console.warn('Authenticated decryption failed:', error);
      throw new Error('Decryption failed');
    }

    // Backward compatibility for old plaintext or legacy broken values.
    console.warn('Legacy decryption failed, returning original text:', error);
    return text;
  }
}
