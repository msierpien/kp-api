import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createTenantMiddleware, TENANT_MODELS } from '../src/lib/prisma-tenant-middleware';

async function applyMiddleware(action: string, args: Record<string, unknown>, tenantId: string | null = 'tenant-a') {
  const middleware = createTenantMiddleware(() => tenantId);
  let nextArgs: Record<string, unknown> | undefined;

  await middleware(
    {
      model: 'WarehouseProduct',
      action,
      args,
      dataPath: [],
      runInTransaction: false,
    } as any,
    async (params) => {
      nextArgs = params.args as Record<string, unknown>;
      return params;
    },
  );

  return nextArgs;
}

describe('Prisma tenant middleware', () => {
  it('tracks every Prisma model with a direct tenantId field', () => {
    const schemaPath = join(process.cwd(), 'prisma/schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');
    const modelNames = Array.from(schema.matchAll(/model\s+(\w+)\s+\{([\s\S]*?)\n\}/g))
      .filter(([, , body]) => /^\s+tenantId\s+/m.test(body))
      .map(([_, model]) => model)
      .sort();

    assert.deepEqual(Array.from(TENANT_MODELS).sort(), modelNames);
  });

  it('adds tenantId to read filters without dropping caller filters', async () => {
    const args = await applyMiddleware('findMany', {
      where: {
        isActive: true,
      },
    });

    assert.deepEqual(args?.where, {
      isActive: true,
      tenantId: 'tenant-a',
    });
  });

  it('forces tenantId on createMany array and object payloads', async () => {
    const arrayArgs = await applyMiddleware('createMany', {
      data: [
        { sku: 'A', tenantId: 'tenant-b' },
        { sku: 'B' },
      ],
    });

    assert.deepEqual(arrayArgs?.data, [
      { sku: 'A', tenantId: 'tenant-a' },
      { sku: 'B', tenantId: 'tenant-a' },
    ]);

    const objectArgs = await applyMiddleware('createMany', {
      data: { sku: 'C', tenantId: 'tenant-b' },
    });

    assert.deepEqual(objectArgs?.data, { sku: 'C', tenantId: 'tenant-a' });
  });

  it('prevents tenant reassignment on update and upsert update payloads', async () => {
    const updateArgs = await applyMiddleware('updateMany', {
      where: { sku: 'A' },
      data: {
        tenantId: 'tenant-b',
        tenant: { connect: { id: 'tenant-b' } },
        name: 'Updated',
      },
    });

    assert.deepEqual(updateArgs, {
      where: { sku: 'A', tenantId: 'tenant-a' },
      data: { name: 'Updated' },
    });

    const upsertArgs = await applyMiddleware('upsert', {
      where: { id: 'product-1' },
      create: { sku: 'A', tenantId: 'tenant-b' },
      update: { tenantId: 'tenant-b', name: 'Updated' },
    });

    assert.deepEqual(upsertArgs, {
      where: { id: 'product-1', tenantId: 'tenant-a' },
      create: { sku: 'A', tenantId: 'tenant-a' },
      update: { name: 'Updated' },
    });
  });

  it('passes through unchanged when there is no tenant context', async () => {
    const args = { where: { isActive: true } };
    const result = await applyMiddleware('findMany', args, null);

    assert.deepEqual(result, args);
  });
});
