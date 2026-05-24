import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'access-secret-for-tests-32-chars-min';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-for-tests-32-chars-min';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012';

describe('auth cookie attributes', () => {
  it('uses cross-site compatible cookies in production', async () => {
    const { buildAuthCookieOptions } = await import('../src/lib/auth-cookies');

    const options = buildAuthCookieOptions(900, true);

    assert.match(options, /Path=\//);
    assert.match(options, /HttpOnly/);
    assert.match(options, /Max-Age=900/);
    assert.match(options, /SameSite=None/);
    assert.match(options, /Secure/);
  });

  it('keeps lax cookies outside production', async () => {
    const { buildAuthCookieOptions } = await import('../src/lib/auth-cookies');

    const options = buildAuthCookieOptions(900, false);

    assert.match(options, /Path=\//);
    assert.match(options, /HttpOnly/);
    assert.match(options, /Max-Age=900/);
    assert.match(options, /SameSite=Lax/);
    assert.doesNotMatch(options, /SameSite=None/);
    assert.doesNotMatch(options, /Secure/);
  });

  it('expires cookies with the same SameSite and Secure production attributes', async () => {
    const { buildExpiredAuthCookie } = await import('../src/lib/auth-cookies');

    const expiredProductionCookie = buildExpiredAuthCookie('accessToken', true);
    const expiredDevelopmentCookie = buildExpiredAuthCookie('accessToken', false);

    assert.match(expiredProductionCookie, /^accessToken=/);
    assert.match(expiredProductionCookie, /Max-Age=0/);
    assert.match(expiredProductionCookie, /SameSite=None/);
    assert.match(expiredProductionCookie, /Secure/);

    assert.match(expiredDevelopmentCookie, /^accessToken=/);
    assert.match(expiredDevelopmentCookie, /Max-Age=0/);
    assert.match(expiredDevelopmentCookie, /SameSite=Lax/);
    assert.doesNotMatch(expiredDevelopmentCookie, /Secure/);
  });
});
