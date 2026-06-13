import dns from 'node:dns/promises';
import net from 'node:net';

export type LogicOperator = 'AND' | 'OR';

export interface AutomationCondition {
  field: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than' | 'in';
  value: unknown;
  groupId?: string;
  groupOperator?: LogicOperator;
  logicOperator?: LogicOperator;
}

export interface NormalizedAutomationCondition extends AutomationCondition {
  groupId: string;
  groupOperator: LogicOperator;
}

export interface AutomationContext {
  caseId: string;
  trigger: string;
  caseData?: any;
  previousStatus?: string;
  newStatus?: string;
}

export interface AutomationDryRunResult {
  automationId: string;
  matched: boolean;
  conditionResults: Array<{
    groupId: string;
    groupOperator: LogicOperator;
    groupMatched: boolean;
    conditions: Array<{
      field: string;
      operator: string;
      expected: unknown;
      actual: unknown;
      matched: boolean;
    }>;
  }>;
}

const DATE_FIELD_RE = /(^|\.)(createdAt|updatedAt|submittedAt|createdAtShop|syncedAt|lastSyncAt)$/i;
const NUMBER_FIELD_RE = /(^|\.)(quantity|priority|totalPaid|total|amount|count|runCount|ordersFetched|ordersCreated|ordersSkipped)$/i;
const PRIVATE_HOSTS = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

function normalizeLogicOperator(value: unknown, fallback: LogicOperator = 'AND'): LogicOperator {
  return value === 'OR' ? 'OR' : fallback;
}

export function normalizeConditions(conditions: unknown): NormalizedAutomationCondition[] {
  if (!Array.isArray(conditions)) return [];
  const rawConditions = conditions.filter((condition: any) => condition && typeof condition === 'object');
  const hasGroups = rawConditions.some((condition: any) => condition?.groupId);
  const legacyOperator = normalizeLogicOperator((rawConditions[0] as any)?.logicOperator, 'AND');

  return rawConditions
    .map((condition: any) => ({
      field: String(condition.field || ''),
      operator: condition.operator || 'equals',
      value: condition.value,
      groupId: hasGroups ? String(condition.groupId || 'group-1') : 'group-1',
      groupOperator: normalizeLogicOperator(
        condition.groupOperator ?? condition.logicOperator,
        hasGroups ? 'AND' : legacyOperator,
      ),
      logicOperator: condition.logicOperator,
    }))
    .filter((condition) => condition.field && condition.operator)
    .map((condition, index) => ({
      ...condition,
      groupId: condition.groupId || `group-${index + 1}`,
    }));
}

function getFieldValue(obj: any, field: string, context?: AutomationContext): any {
  if (field === 'previousStatus') return context?.previousStatus;
  if (field === 'newStatus') return context?.newStatus;
  if (field === 'shopId') return obj?.order?.shop?.id;
  if (field === 'shopName') return obj?.order?.shop?.name;
  if (field === 'templateId') return obj?.template?.id ?? obj?.templateId;

  const parts = field.split('.');
  let value = obj;
  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = value[part];
    } else {
      return undefined;
    }
  }
  return value;
}

function normalizeComparable(field: string, value: unknown): number | string | null {
  if (value === null || value === undefined || value === '') return null;

  if (DATE_FIELD_RE.test(field) || value instanceof Date) {
    const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (NUMBER_FIELD_RE.test(field) || typeof value === 'number') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  return String(value).toLowerCase();
}

function normalizeListValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function evaluateCondition(
  condition: NormalizedAutomationCondition,
  context: AutomationContext,
): { matched: boolean; actual: unknown } {
  const actual = getFieldValue(context.caseData, condition.field, context);

  switch (condition.operator) {
    case 'equals':
      return { actual, matched: String(actual) === String(condition.value) };
    case 'not_equals':
      return { actual, matched: String(actual) !== String(condition.value) };
    case 'contains':
      return {
        actual,
        matched: String(actual ?? '').toLowerCase().includes(String(condition.value ?? '').toLowerCase()),
      };
    case 'greater_than': {
      const left = normalizeComparable(condition.field, actual);
      const right = normalizeComparable(condition.field, condition.value);
      return { actual, matched: left !== null && right !== null && left > right };
    }
    case 'less_than': {
      const left = normalizeComparable(condition.field, actual);
      const right = normalizeComparable(condition.field, condition.value);
      return { actual, matched: left !== null && right !== null && left < right };
    }
    case 'in': {
      const expected = normalizeListValue(condition.value).map((item) => String(item));
      return { actual, matched: expected.includes(String(actual)) };
    }
    default:
      return { actual, matched: false };
  }
}

export function evaluateConditions(
  conditions: AutomationCondition[],
  context: AutomationContext,
): boolean {
  return buildDryRunResult('dry-run', conditions, context).matched;
}

export function buildDryRunResult(
  automationId: string,
  conditions: unknown,
  context: AutomationContext,
): AutomationDryRunResult {
  const normalized = normalizeConditions(conditions);
  if (normalized.length === 0) {
    return { automationId, matched: true, conditionResults: [] };
  }

  if (!context.caseData) {
    return { automationId, matched: false, conditionResults: [] };
  }

  const groups = new Map<string, NormalizedAutomationCondition[]>();
  for (const condition of normalized) {
    const group = groups.get(condition.groupId) ?? [];
    group.push(condition);
    groups.set(condition.groupId, group);
  }

  const conditionResults = Array.from(groups.entries()).map(([groupId, group]) => {
    const groupOperator = group[0]?.groupOperator ?? 'AND';
    const conditionsWithResult = group.map((condition) => {
      const result = evaluateCondition(condition, context);
      return {
        field: condition.field,
        operator: condition.operator,
        expected: condition.value,
        actual: result.actual,
        matched: result.matched,
      };
    });
    const groupMatched = groupOperator === 'OR'
      ? conditionsWithResult.some((condition) => condition.matched)
      : conditionsWithResult.every((condition) => condition.matched);

    return {
      groupId,
      groupOperator,
      groupMatched,
      conditions: conditionsWithResult,
    };
  });

  return {
    automationId,
    matched: conditionResults.some((group) => group.groupMatched),
    conditionResults,
  };
}

function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0 ||
      a >= 224
    );
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
  }

  return true;
}

export async function assertPublicHttpsUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Webhook URL is invalid');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use HTTPS');
  }

  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOSTS.has(host) || host.endsWith('.local')) {
    throw new Error('Webhook URL cannot point to a local host');
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Webhook URL cannot point to a private IP address');
    return;
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (records.length === 0 || records.some((record) => isPrivateIp(record.address))) {
    throw new Error('Webhook URL cannot resolve to a private IP address');
  }
}

export async function executeWebhook(config: Record<string, any>, context: AutomationContext): Promise<void> {
  const url = String(config.url || '');
  const method = String(config.method || 'POST').toUpperCase();
  const timeoutMs = Math.min(Math.max(Number(config.timeoutMs ?? 10000), 1000), 30000);
  const headers = config.headers && typeof config.headers === 'object' ? config.headers : {};
  await assertPublicHttpsUrl(url);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const payload = config.payload && typeof config.payload === 'object'
    ? config.payload
    : {
        trigger: context.trigger,
        caseId: context.caseId,
        timestamp: new Date().toISOString(),
        data: context.caseData,
      };

  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: method === 'GET' ? undefined : JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
