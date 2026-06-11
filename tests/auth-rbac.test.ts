import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import bcrypt from 'bcrypt';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'access-secret-for-tests-32-chars-min';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-for-tests-32-chars-min';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012';

type StoredToken = Record<string, unknown>;

function createJwtHarness() {
  let counter = 0;
  const tokens = new Map<string, StoredToken>();

  return {
    sign(payload: object) {
      const token = `token-${++counter}`;
      tokens.set(token, payload as StoredToken);
      return token;
    },
    verify<T>(token: string): T {
      const payload = tokens.get(token);
      if (!payload) throw new Error('invalid token');
      return payload as T;
    },
  };
}

function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createAuthHarness(options: { isActive?: boolean } = {}) {
  const passwordHash = await bcrypt.hash('correct-password', 4);
  const tenant = {
    id: 'tenant-1',
    name: 'Tenant One',
    slug: 'tenant-one',
    featuresJson: { personalization_editor: true },
  };
  const user = {
    id: 'user-1',
    email: 'admin@example.com',
    passwordHash,
    name: 'Admin',
    role: 'ADMIN',
    tenantId: tenant.id,
    isActive: options.isActive ?? true,
    tenant,
  };
  const sessions = new Map<string, any>();

  const db = {
    user: {
      async findUnique(args: any) {
        if (args.where.email === user.email) return user;
        if (args.where.id === user.id) return user;
        return null;
      },
      async update() {
        return user;
      },
    },
    authSession: {
      async create(args: any) {
        const session = {
          ...args.data,
          revokedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        sessions.set(session.id, session);
        return session;
      },
      async findUnique(args: any) {
        const session = sessions.get(args.where.id);
        if (!session) return null;
        return args.include?.user ? { ...session, user } : session;
      },
      async updateMany(args: any) {
        const session = sessions.get(args.where.id);
        if (!session) return { count: 0 };
        if (args.where.refreshTokenHash && session.refreshTokenHash !== args.where.refreshTokenHash) {
          return { count: 0 };
        }
        if (args.where.revokedAt === null && session.revokedAt !== null) {
          return { count: 0 };
        }

        Object.assign(session, args.data, { updatedAt: new Date() });
        return { count: 1 };
      },
    },
  };

  const { AuthService } = await import('../src/services/auth.service');
  const jwt = createJwtHarness();
  return {
    service: new AuthService(jwt, db as any),
    jwt,
    sessions,
    user,
  };
}

describe('auth sessions', () => {
  it('creates a server-side refresh session during login', async () => {
    const { service, sessions } = await createAuthHarness();

    const result = await service.login('admin@example.com', 'correct-password', {
      userAgent: 'node-test',
      ipAddress: '127.0.0.1',
    });

    assert.equal(result.user.email, 'admin@example.com');
    assert.equal(sessions.size, 1);
    const session = Array.from(sessions.values())[0];
    assert.equal(session.userId, 'user-1');
    assert.equal(session.tenantId, 'tenant-1');
    assert.equal(session.userAgent, 'node-test');
    assert.equal(session.ipAddress, '127.0.0.1');
    assert.equal(session.refreshTokenHash, hashToken(result.refreshToken));
  });

  it('rotates refresh tokens and rejects reuse of the old token', async () => {
    const { service, sessions } = await createAuthHarness();
    const login = await service.login('admin@example.com', 'correct-password');
    const session = Array.from(sessions.values())[0];

    const refreshed = await service.refresh(login.refreshToken);

    assert.notEqual(refreshed.refreshToken, login.refreshToken);
    assert.equal(session.refreshTokenHash, hashToken(refreshed.refreshToken));
    await assert.rejects(() => service.refresh(login.refreshToken), /Nieprawidłowy lub wygasły token/);
  });

  it('revokes the refresh session on logout', async () => {
    const { service, sessions } = await createAuthHarness();
    const login = await service.login('admin@example.com', 'correct-password');
    const refreshed = await service.refresh(login.refreshToken);
    const session = Array.from(sessions.values())[0];

    await service.logout(refreshed.refreshToken);

    assert.ok(session.revokedAt instanceof Date);
    await assert.rejects(() => service.refresh(refreshed.refreshToken), /Nieprawidłowy lub wygasły token/);
  });

  it('rejects refresh when the user is inactive', async () => {
    const { service, user } = await createAuthHarness();
    const login = await service.login('admin@example.com', 'correct-password');
    user.isActive = false;

    await assert.rejects(
      () => service.refresh(login.refreshToken),
      /Nieprawidłowy lub wygasły token/,
    );
  });
});

describe('admin RBAC policy', () => {
  it('allows SUPER_ADMIN to access all admin paths', async () => {
    const { canAccessAdminPath } = await import('../src/lib/authz/admin-policy');

    assert.equal(canAccessAdminPath('SUPER_ADMIN', 'DELETE', '/admin/storage/cleanup'), true);
    assert.equal(canAccessAdminPath('SUPER_ADMIN', 'POST', '/admin/tenants'), true);
  });

  it('blocks ADMIN from system administration paths', async () => {
    const { canAccessAdminPath } = await import('../src/lib/authz/admin-policy');

    assert.equal(canAccessAdminPath('ADMIN', 'GET', '/admin/templates'), true);
    assert.equal(canAccessAdminPath('ADMIN', 'GET', '/admin/tenants'), false);
    assert.equal(canAccessAdminPath('ADMIN', 'POST', '/admin/storage/cleanup'), false);
    assert.equal(canAccessAdminPath('ADMIN', 'GET', '/admin/queues'), false);
  });

  it('limits OPERATOR to operational read/write paths', async () => {
    const { canAccessAdminPath } = await import('../src/lib/authz/admin-policy');

    assert.equal(canAccessAdminPath('OPERATOR', 'GET', '/admin/stats'), true);
    assert.equal(canAccessAdminPath('OPERATOR', 'DELETE', '/admin/orders/1'), false);
    assert.equal(canAccessAdminPath('OPERATOR', 'POST', '/admin/order-returns/1/retry'), true);
    assert.equal(canAccessAdminPath('OPERATOR', 'DELETE', '/admin/order-returns/1'), true);
    assert.equal(canAccessAdminPath('OPERATOR', 'POST', '/admin/warehouse/documents'), true);
    assert.equal(canAccessAdminPath('OPERATOR', 'GET', '/admin/warehouse/products'), true);
    assert.equal(canAccessAdminPath('OPERATOR', 'POST', '/admin/warehouse/products'), false);
    assert.equal(canAccessAdminPath('OPERATOR', 'GET', '/admin/warehouse/catalogs'), false);
    assert.equal(canAccessAdminPath('OPERATOR', 'GET', '/admin/templates'), false);
  });
});
