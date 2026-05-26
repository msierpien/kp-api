import fs from 'fs/promises';
import path from 'path';
import Redis from 'ioredis';
import prisma from '../../lib/prisma';
import { config } from '../../config';

export type DependencyHealth = {
  status: 'ok' | 'error';
  latencyMs: number;
  message?: string;
};

export type ReadinessHealth = {
  status: 'ok' | 'error';
  timestamp: string;
  uptimeSeconds: number;
  runtime: typeof config.runtime;
  dependencies: {
    database: DependencyHealth;
    redis: DependencyHealth;
    storage: DependencyHealth;
  };
};

async function measure(check: () => Promise<void>): Promise<DependencyHealth> {
  const startedAt = Date.now();

  try {
    await check();
    return {
      status: 'ok',
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function checkDatabaseHealth() {
  return measure(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });
}

export async function checkRedisHealth() {
  return measure(async () => {
    const redis = new Redis(config.redis.url, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      connectTimeout: 1000,
    });

    try {
      await redis.connect();
      await redis.ping();
    } finally {
      redis.disconnect();
    }
  });
}

export async function checkStorageHealth() {
  return measure(async () => {
    const storagePath = path.isAbsolute(config.storage.path)
      ? config.storage.path
      : path.join(process.cwd(), config.storage.path);

    await fs.access(storagePath);
  });
}

export async function getReadinessHealth(): Promise<ReadinessHealth> {
  const [database, redis, storage] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkStorageHealth(),
  ]);

  const dependencies = { database, redis, storage };
  const status = Object.values(dependencies).every((dependency) => dependency.status === 'ok') ? 'ok' : 'error';

  return {
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    runtime: config.runtime,
    dependencies,
  };
}
