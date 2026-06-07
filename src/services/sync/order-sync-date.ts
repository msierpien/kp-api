import { ValidationError } from '../../lib/errors';

const FALLBACK_LOOKBACK_DAYS = 7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasDateValue(value: unknown): boolean {
  return value instanceof Date || (typeof value === 'string' && value.trim() !== '');
}

function maxDate(first: string, second: string | null): string {
  return second && second > first ? second : first;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeOrderSyncDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (!match) {
    return null;
  }

  const date = new Date(`${match[1]}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10) === match[1] ? match[1] : null;
}

export function resolveConfiguredOrderSyncFromDate(config: unknown): string | null {
  if (!isRecord(config) || !isRecord(config.orderSync)) {
    return null;
  }

  const rawFromDate = hasOwn(config.orderSync, 'fromDate')
    ? config.orderSync.fromDate
    : config.orderSync.dateFrom
      ?? config.orderSync.syncFromDate
      ?? config.orderSync.startDate;

  return normalizeOrderSyncDate(rawFromDate);
}

export function assertValidOrderSyncDate(value: unknown, fieldName = 'fromDate'): string | null {
  if (!hasDateValue(value)) {
    return null;
  }

  const normalized = normalizeOrderSyncDate(value);
  if (!normalized) {
    throw new ValidationError(`${fieldName} must use YYYY-MM-DD format`);
  }

  return normalized;
}

export function resolveOrderSyncFromDate(input: {
  requestedFromDate?: unknown;
  lastSyncAt?: Date | string | null;
  config?: unknown;
  now?: Date;
}): string {
  const configuredFromDate = resolveConfiguredOrderSyncFromDate(input.config);
  const requestedFromDate = assertValidOrderSyncDate(input.requestedFromDate);
  const lastSyncDate = normalizeOrderSyncDate(input.lastSyncAt);

  if (requestedFromDate) {
    return maxDate(requestedFromDate, configuredFromDate);
  }

  if (lastSyncDate) {
    return maxDate(lastSyncDate, configuredFromDate);
  }

  if (configuredFromDate) {
    return configuredFromDate;
  }

  const now = input.now ?? new Date();
  const fallback = new Date(now.getTime() - FALLBACK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return normalizeOrderSyncDate(fallback) as string;
}
