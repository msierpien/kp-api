import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'access-secret-for-tests-32-chars-min';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-for-tests-32-chars-min';
process.env.ENCRYPTION_KEY = '12345678901234567890123456789012';

describe('encryption', () => {
  it('encrypts new values with authenticated v2 payloads', async () => {
    const { encrypt, decrypt } = await import('../src/lib/encryption');

    const encrypted = encrypt('secret-value');

    assert.match(encrypted, /^v2:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    assert.equal(decrypt(encrypted), 'secret-value');
    assert.notEqual(encrypted, 'secret-value');
  });

  it('fails closed when an authenticated payload is tampered with', async () => {
    const { encrypt, decrypt } = await import('../src/lib/encryption');

    const encrypted = encrypt('secret-value');
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('0') ? '1' : '0'}`;

    const warn = console.warn;
    console.warn = () => undefined;
    try {
      assert.throws(() => decrypt(tampered), /Decryption failed/);
    } finally {
      console.warn = warn;
    }
  });

  it('keeps plaintext backward compatibility for legacy stored values', async () => {
    const { decrypt } = await import('../src/lib/encryption');

    assert.equal(decrypt('legacy-plaintext-value'), 'legacy-plaintext-value');
  });
});
