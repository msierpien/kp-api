import { config } from '../config';

/**
 * Origins dopuszczone do rozmowy z API: panel admina i portal klienta.
 *
 * Mieszka w lib, a nie w index.ts, bo korzysta z tego zarowno CORS, jak i
 * straznik CSRF na trasach admina - obie listy musza byc tą samą listą.
 */
const allowedOrigins = [config.frontend.adminUrl, config.frontend.publicPortalBaseUrl];

export function isAllowedOrigin(origin: string): boolean {
  if (allowedOrigins.includes(origin)) return true;
  return config.app.isDevelopment && origin.includes('localhost');
}
