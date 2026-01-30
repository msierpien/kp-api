import crypto from 'crypto';
import { config } from '../config';

// Pobierz klucz szyfrowania z config (32 bajty dla AES-256)
const ENCRYPTION_KEY = config.encryption.key;
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

/**
 * Szyfruje tekst używając AES-256-CBC
 */
export function encrypt(text: string): string {
  if (!text) return '';

  try {
    // Upewnij się że klucz ma 32 bajty
    const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Zwróć IV + encrypted (IV potrzebny do deszyfrowania)
    return iv.toString('hex') + ':' + encrypted;
  } catch (error) {
    console.error('Encryption failed:', error);
    // Fallback: zwróć plain text (lepsze niż crash)
    return text;
  }
}

/**
 * Deszyfruje tekst zaszyfrowany encrypt()
 */
export function decrypt(text: string): string {
  if (!text) return '';

  try {
    const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));
    const parts = text.split(':');

    if (parts.length !== 2) {
      // Fallback: jeśli nie ma IV (stare dane niezaszyfrowane), zwróć oryginalny tekst
      return text;
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = parts[1];
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    // Jeśli deszyfrowanie nie powiodło się (stare dane niezaszyfrowane), zwróć oryginalny tekst
    console.warn('Decryption failed, returning original text:', error);
    return text;
  }
}
