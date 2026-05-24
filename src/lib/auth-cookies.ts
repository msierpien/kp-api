import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';

const ACCESS_TOKEN_COOKIE = 'accessToken';
const REFRESH_TOKEN_COOKIE = 'refreshToken';
const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60;
const REFRESH_TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function parseCookies(cookieHeader: string | undefined) {
  const cookies = new Map<string, string>();
  if (!cookieHeader) return cookies;

  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;

    const name = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();
    if (!name) continue;

    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }

  return cookies;
}

export function getCookieValue(request: FastifyRequest, name: string) {
  return parseCookies(request.headers.cookie).get(name);
}

export function getAccessTokenFromRequest(request: FastifyRequest) {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  return getCookieValue(request, ACCESS_TOKEN_COOKIE);
}

export function getRefreshTokenFromRequest(request: FastifyRequest) {
  return getCookieValue(request, REFRESH_TOKEN_COOKIE);
}

export function buildAuthCookieOptions(maxAgeSeconds: number, isProduction = config.app.isProduction) {
  const parts = [
    'Path=/',
    'HttpOnly',
    `Max-Age=${maxAgeSeconds}`,
    isProduction ? 'SameSite=None' : 'SameSite=Lax',
  ];

  if (isProduction) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export function buildExpiredAuthCookie(name: string, isProduction = config.app.isProduction) {
  const parts = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    isProduction ? 'SameSite=None' : 'SameSite=Lax',
  ];

  if (isProduction) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export function setAuthCookies(reply: FastifyReply, tokens: { accessToken: string; refreshToken?: string }) {
  const cookies = [
    `${ACCESS_TOKEN_COOKIE}=${encodeURIComponent(tokens.accessToken)}; ${buildAuthCookieOptions(ACCESS_TOKEN_MAX_AGE_SECONDS)}`,
  ];

  if (tokens.refreshToken) {
    cookies.push(
      `${REFRESH_TOKEN_COOKIE}=${encodeURIComponent(tokens.refreshToken)}; ${buildAuthCookieOptions(REFRESH_TOKEN_MAX_AGE_SECONDS)}`
    );
  }

  reply.header('Set-Cookie', cookies);
}

export function clearAuthCookies(reply: FastifyReply) {
  reply.header('Set-Cookie', [
    buildExpiredAuthCookie(ACCESS_TOKEN_COOKIE),
    buildExpiredAuthCookie(REFRESH_TOKEN_COOKIE),
  ]);
}
