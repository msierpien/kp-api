import { PrismaClient } from '@prisma/client';
import { createTenantMiddleware } from './prisma-tenant-middleware';
import { getTenantId } from './tenant-context';

const prismaClientSingleton = () => {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

  // Add tenant isolation middleware
  client.$use(createTenantMiddleware(getTenantId));

  return client;
};

declare global {
  // eslint-disable-next-line no-var
  var prisma: undefined | ReturnType<typeof prismaClientSingleton>;
}

const prisma = globalThis.prisma ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== 'production') globalThis.prisma = prisma;
