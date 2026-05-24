import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/test';
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'access-secret-for-tests-32-chars-min';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'refresh-secret-for-tests-32-chars-min';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012';

describe('domain errors', () => {
  it('maps application errors to the API error response shape', async () => {
    const { ValidationError } = await import('../src/lib/errors');
    const { toErrorResponse } = await import('../src/plugins/error-handler.plugin');

    const response = toErrorResponse(new ValidationError('Nieprawidłowy formularz', { field: 'email' }));

    assert.deepEqual(response, {
      error: 'Bad Request',
      message: 'Nieprawidłowy formularz',
      statusCode: 400,
      details: { field: 'email' },
    });
  });

  it('keeps generic errors internal by default', async () => {
    const { toErrorResponse } = await import('../src/plugins/error-handler.plugin');

    const response = toErrorResponse(new Error('Unexpected failure'));

    assert.deepEqual(response, {
      error: 'Internal Server Error',
      message: 'Unexpected failure',
      statusCode: 500,
    });
  });
});
