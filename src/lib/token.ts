import crypto from 'crypto';
import { encrypt } from './encryption';

/**
 * Generuje kryptograficznie bezpieczny token dostępu.
 * Zwraca:
 * - token (plain text do wysłania użytkownikowi)
 * - hash (SHA-256 do wyszukiwania w bazie)
 * - encrypted (zaszyfrowany token do zapisania w bazie)
 *
 * Token: 64 znaki URL-safe (base64url z 48 bajtów)
 * Hash: SHA-256 hex (64 znaki)
 * Encrypted: AES-256-CBC zaszyfrowany token
 */
export function generateAccessToken(): { token: string; hash: string; encrypted: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  const hash = hashToken(token);
  const encrypted = encrypt(token);
  return { token, hash, encrypted };
}

/**
 * Hashuje token używając SHA-256.
 * Używaj do porównywania tokena z URL z hashem w bazie.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Maskuje token dla celów logowania (pokazuje tylko początek i koniec).
 * Przykład: "abc...xyz" zamiast pełnego tokena
 */
export function maskToken(token: string, visibleChars: number = 4): string {
  if (token.length <= visibleChars * 2) {
    return '***';
  }
  return `${token.slice(0, visibleChars)}...${token.slice(-visibleChars)}`;
}
