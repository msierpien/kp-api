import crypto from 'crypto';

/**
 * Generuje kryptograficznie bezpieczny token dostępu.
 * Zwraca token (do wysłania użytkownikowi) i hash (do zapisania w bazie).
 *
 * Token: 64 znaki URL-safe (base64url z 48 bajtów)
 * Hash: SHA-256 hex (64 znaki)
 */
export function generateAccessToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(48).toString('base64url');
  const hash = hashToken(token);
  return { token, hash };
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
