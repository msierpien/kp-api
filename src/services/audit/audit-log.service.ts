import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import prisma from '../../lib/prisma';

const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const RESOURCE_ID_KEYS = ['id', 'shopId', 'eventId', 'fileName', 'name', 'itemId', 'mappingId', 'ean'];

function requestPath(url: string) {
  return url.split('?')[0] || '/';
}

export function shouldAuditAdminRequest(method: string, statusCode: number, url: string) {
  const path = requestPath(url);
  return path.startsWith('/admin') &&
    AUDITED_METHODS.has(method.toUpperCase()) &&
    statusCode >= 200 &&
    statusCode < 400;
}

export function auditResourceFromUrl(url: string) {
  const path = requestPath(url).replace(/^\/admin(?=\/|$)/, '') || '/';
  const [resource] = path.split('/').filter(Boolean);
  return resource || 'admin';
}

export function auditAction(method: string, url: string) {
  return `${method.toUpperCase()}:${auditResourceFromUrl(url)}`;
}

function stringRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function resourceIdFromParams(params: unknown) {
  const record = stringRecord(params);
  if (!record) return undefined;

  for (const key of RESOURCE_ID_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }

  return undefined;
}

function jsonObject(value: unknown): Prisma.JsonObject | undefined {
  const record = stringRecord(value);
  if (!record) return undefined;
  return JSON.parse(JSON.stringify(record)) as Prisma.JsonObject;
}

function userAgent(request: FastifyRequest) {
  const header = request.headers['user-agent'];
  return Array.isArray(header) ? header.join(' ') : header;
}

function targetTenantId(request: FastifyRequest) {
  if (request.user?.role !== 'SUPER_ADMIN') return undefined;
  const query = stringRecord(request.query);
  const tenantId = query?.tenantId;
  return typeof tenantId === 'string' && tenantId ? tenantId : undefined;
}

export async function writeAdminAuditLog(request: FastifyRequest, reply: FastifyReply) {
  if (!shouldAuditAdminRequest(request.method, reply.statusCode, request.url)) return;

  const user = request.user;
  if (!user) return;

  try {
    await prisma.auditLog.create({
      data: {
        actorUserId: user.userId,
        actorEmail: user.email,
        actorRole: user.role,
        actorTenantId: user.tenantId,
        targetTenantId: targetTenantId(request),
        action: auditAction(request.method, request.url),
        resource: auditResourceFromUrl(request.url),
        resourceId: resourceIdFromParams(request.params),
        method: request.method,
        path: requestPath(request.url),
        statusCode: reply.statusCode,
        ipAddress: request.ip,
        userAgent: userAgent(request),
        metadataJson: {
          params: jsonObject(request.params) || {},
          query: jsonObject(request.query) || {},
        },
      },
    });
  } catch (error) {
    request.log.warn({ err: error }, 'Failed to write admin audit log');
  }
}
