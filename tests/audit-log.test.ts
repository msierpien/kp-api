import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'access-secret-for-tests-32-chars-min';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-for-tests-32-chars-min';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012';

describe('admin audit policy', () => {
  it('audits successful admin mutations only', async () => {
    const { shouldAuditAdminRequest } = await import('../src/services/audit/audit-log.service');

    assert.equal(shouldAuditAdminRequest('POST', 201, '/admin/users'), true);
    assert.equal(shouldAuditAdminRequest('PATCH', 200, '/admin/tenants/1'), true);
    assert.equal(shouldAuditAdminRequest('GET', 200, '/admin/users'), false);
    assert.equal(shouldAuditAdminRequest('POST', 403, '/admin/users'), false);
    assert.equal(shouldAuditAdminRequest('POST', 200, '/auth/login'), false);
  });

  it('derives stable action and resource names from admin URLs', async () => {
    const { auditAction, auditResourceFromUrl } = await import('../src/services/audit/audit-log.service');

    assert.equal(auditResourceFromUrl('/admin/templates/1/assets?tenantId=t1'), 'templates');
    assert.equal(auditResourceFromUrl('/admin/warehouse/products/1/sync-stock'), 'warehouse');
    assert.equal(auditAction('delete', '/admin/users/1'), 'DELETE:users');
  });
});
