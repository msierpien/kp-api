import { z } from 'zod';
import { createLogger } from './lib/logger';

const logger = createLogger('config');

/**
 * Validation schema for environment variables
 */
const envSchema = z.object({
  // Environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // API
  API_PORT: z.string().transform(Number).pipe(z.number().int().positive()).default('3001'),
  API_HOST: z.string().default('0.0.0.0'),
  APP_URL: z.string().url().default('http://localhost:3001'),
  TRUST_PROXY: z.string().transform(val => val === 'true').default('false'),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // Redis
  REDIS_HOST: z.string().default('redis'),
  REDIS_PORT: z.string().transform(Number).pipe(z.number().int().positive()).default('6379'),
  REDIS_PASSWORD: z.string().optional(),

  // JWT
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // Encryption
  ENCRYPTION_KEY: z.string().length(32, 'ENCRYPTION_KEY must be exactly 32 characters'),

  // Email (SMTP)
  AUTO_SEND_EMAILS: z.string().transform(val => val === 'true').default('false'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.string().transform(Number).pipe(z.number().int().positive()).default('587'),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().email().optional(),

  // Frontend URLs
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  PUBLIC_PORTAL_BASE_URL: z.string().url().default('http://localhost:3002'),

  // Storage URLs
  PUBLIC_STORAGE_URL: z.string().url().optional(),

  // Webhook
  WEBHOOK_SECRET: z.string().optional(),

  // Storage
  STORAGE_TYPE: z.enum(['local', 's3']).default('local'),
  STORAGE_PATH: z.string().default('./storage'),

  // Runtime process roles
  WORKERS_ENABLED: z.string().transform(val => val !== 'false').default('true'),
  SCHEDULER_ENABLED: z.string().transform(val => val !== 'false').default('true'),
});

type Env = z.infer<typeof envSchema>;

/**
 * Load and validate configuration from environment variables
 */
function loadConfig(): Env {
  try {
    const parsed = envSchema.parse(process.env);
    return parsed;
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error({
        errors: error.errors.map((err) => ({
          path: err.path.join('.'),
          message: err.message,
        })),
      }, 'Invalid environment variables');
      process.exit(1);
    }
    throw error;
  }
}

// Load and freeze config on module initialization
const env = loadConfig();

/**
 * Application configuration
 * All configuration should be accessed through this object
 */
export const config = {
  /**
   * Application settings
   */
  app: {
    env: env.NODE_ENV,
    port: env.API_PORT,
    host: env.API_HOST,
    url: env.APP_URL,
    trustProxy: env.TRUST_PROXY,
    isDevelopment: env.NODE_ENV === 'development',
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
  },

  /**
   * Database configuration
   */
  database: {
    url: env.DATABASE_URL,
  },

  /**
   * Redis configuration
   */
  redis: {
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    password: env.REDIS_PASSWORD,
    url: env.REDIS_PASSWORD
      ? `redis://:${env.REDIS_PASSWORD}@${env.REDIS_HOST}:${env.REDIS_PORT}`
      : `redis://${env.REDIS_HOST}:${env.REDIS_PORT}`,
  },

  /**
   * JWT authentication configuration
   */
  auth: {
    jwtAccessSecret: env.JWT_ACCESS_SECRET,
    jwtRefreshSecret: env.JWT_REFRESH_SECRET,
    jwtAccessExpiresIn: env.JWT_ACCESS_EXPIRES_IN,
    jwtRefreshExpiresIn: env.JWT_REFRESH_EXPIRES_IN,
  },

  /**
   * Encryption configuration
   */
  encryption: {
    key: env.ENCRYPTION_KEY,
  },

  /**
   * Email configuration (SMTP)
   */
  smtp: {
    autoSend: env.AUTO_SEND_EMAILS,
    host: env.SMTP_HOST,
    port: env.SMTP_PORT || 587,
    user: env.SMTP_USER,
    pass: env.SMTP_PASSWORD,
    from: env.SMTP_FROM,
    enabled: Boolean(env.SMTP_HOST && env.SMTP_FROM),
  },

  /**
   * Frontend URLs
   */
  frontend: {
    adminUrl: env.FRONTEND_URL,
    portalUrl: env.PUBLIC_PORTAL_BASE_URL,
    publicPortalBaseUrl: env.PUBLIC_PORTAL_BASE_URL,
  },

  /**
   * Webhook configuration
   */
  webhook: {
    secret: env.WEBHOOK_SECRET,
  },

  /**
   * Storage configuration
   */
  storage: {
    type: env.STORAGE_TYPE,
    path: env.STORAGE_PATH,
    publicUrl: env.PUBLIC_STORAGE_URL || `${env.APP_URL}/storage`,
  },

  runtime: {
    workersEnabled: env.WORKERS_ENABLED,
    schedulerEnabled: env.SCHEDULER_ENABLED,
  },
} as const;

export type Config = typeof config;
