import pino from 'pino';

const isTest = process.env.NODE_ENV === 'test';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  redact: {
    paths: [
      'password',
      'passwordHash',
      'apiKey',
      'apiSecret',
      'refreshToken',
      'refreshTokenHash',
      'accessToken',
      '*.password',
      '*.passwordHash',
      '*.apiKey',
      '*.apiSecret',
      '*.refreshToken',
      '*.refreshTokenHash',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
});

export function createLogger(scope: string) {
  return logger.child({ scope });
}
