import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'access-secret-for-tests-32-chars-min';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-for-tests-32-chars-min';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012';

describe('configuration helpers', () => {
  it('trusts proxy by default only in production', async () => {
    const { resolveTrustProxy } = await import('../src/config');

    assert.equal(resolveTrustProxy('production'), true);
    assert.equal(resolveTrustProxy('development'), false);
    assert.equal(resolveTrustProxy('test'), false);
  });

  it('lets TRUST_PROXY explicitly override the production default', async () => {
    const { resolveTrustProxy } = await import('../src/config');

    assert.equal(resolveTrustProxy('production', 'false'), false);
    assert.equal(resolveTrustProxy('development', 'true'), true);
  });
});
