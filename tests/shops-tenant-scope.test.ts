import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'access-secret-for-tests-32-chars-min';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-for-tests-32-chars-min';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012';

describe('shop tenant scope', () => {
  it('scopes regular admins to their tenant', async () => {
    const { resolveShopTenantWhereForContext } = await import('../src/services/admin/shops.service');

    assert.deepEqual(
      resolveShopTenantWhereForContext({
        tenantId: 'tenant-a',
        role: 'ADMIN',
      }),
      { tenantId: 'tenant-a' },
    );
  });

  it('allows super admin to see all shops or an override tenant', async () => {
    const { resolveShopTenantWhereForContext } = await import('../src/services/admin/shops.service');

    assert.deepEqual(
      resolveShopTenantWhereForContext({
        tenantId: 'system',
        role: 'SUPER_ADMIN',
      }),
      {},
    );

    assert.deepEqual(
      resolveShopTenantWhereForContext({
        tenantId: 'system',
        role: 'SUPER_ADMIN',
        overrideTenantId: 'tenant-b',
      }),
      { tenantId: 'tenant-b' },
    );
  });

  it('rejects non-super-admin access without tenant context', async () => {
    const { resolveShopTenantWhereForContext } = await import('../src/services/admin/shops.service');

    assert.throws(
      () => resolveShopTenantWhereForContext({ role: 'ADMIN' }),
      /Brak kontekstu tenanta/,
    );
    assert.throws(
      () => resolveShopTenantWhereForContext(null),
      /Brak kontekstu tenanta/,
    );
  });
});
