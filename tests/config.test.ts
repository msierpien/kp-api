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

  it('maps runtime roles to isolated process responsibilities', async () => {
    const { resolveRuntime } = await import('../src/config');

    assert.deepEqual(resolveRuntime('api'), {
      role: 'api',
      apiEnabled: true,
      workersEnabled: false,
      schedulerEnabled: false,
    });

    assert.deepEqual(resolveRuntime('worker'), {
      role: 'worker',
      apiEnabled: false,
      workersEnabled: true,
      schedulerEnabled: false,
    });

    assert.deepEqual(resolveRuntime('scheduler'), {
      role: 'scheduler',
      apiEnabled: false,
      workersEnabled: false,
      schedulerEnabled: true,
    });
  });

  it('lets explicit runtime flags override role defaults', async () => {
    const { resolveRuntime } = await import('../src/config');

    assert.deepEqual(resolveRuntime('api', false, true, true), {
      role: 'api',
      apiEnabled: false,
      workersEnabled: true,
      schedulerEnabled: true,
    });
  });
});
