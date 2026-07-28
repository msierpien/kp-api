import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_ACCESS_SECRET ||= 'x'.repeat(32);
process.env.JWT_REFRESH_SECRET ||= 'y'.repeat(32);
process.env.ENCRYPTION_KEY ||= 'z'.repeat(32);

const SAVED_AT = new Date('2026-07-28T10:00:00.000Z');

test('znacznik wersji to updatedAt szablonu w ISO', async () => {
  const { templateVersionToken } = await import('../src/services/admin/template-version');

  assert.equal(templateVersionToken(SAVED_AT), '2026-07-28T10:00:00.000Z');
});

test('zapis ze swiezym znacznikiem przechodzi', async () => {
  const { assertTemplateVersion, templateVersionToken } = await import(
    '../src/services/admin/template-version'
  );

  assert.doesNotThrow(() => assertTemplateVersion(SAVED_AT, templateVersionToken(SAVED_AT)));
});

test('zapis z nieswiezym znacznikiem konczy sie konfliktem, nie nadpisaniem', async () => {
  const { assertTemplateVersion } = await import('../src/services/admin/template-version');
  const { ConflictError } = await import('../src/lib/errors');

  const nowInDb = new Date('2026-07-28T10:05:00.000Z');

  assert.throws(
    () => assertTemplateVersion(nowInDb, '2026-07-28T10:00:00.000Z'),
    (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /odśwież/i);
      return true;
    }
  );
});

test('brak znacznika nie blokuje zapisu - skrypty i starszy panel dzialaja dalej', async () => {
  const { assertTemplateVersion } = await import('../src/services/admin/template-version');

  assert.doesNotThrow(() => assertTemplateVersion(new Date(), undefined));
  assert.doesNotThrow(() => assertTemplateVersion(new Date(), ''));
});
