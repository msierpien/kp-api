import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPublicHttpsUrl,
  buildDryRunResult,
  normalizeConditions,
  type AutomationContext,
} from '../src/services/admin/automation-rules';

const context: AutomationContext = {
  caseId: 'case-1',
  trigger: 'CASE_STATUS_CHANGED',
  caseData: {
    status: 'SUBMITTED',
    createdAt: new Date('2026-06-02T12:00:00Z'),
    order: {
      totalPaid: '100',
      shop: { id: 'shop-1', name: 'Allegro' },
    },
  },
};

test('automation conditions evaluate AND inside groups and OR between groups', () => {
  const result = buildDryRunResult(
    'automation-1',
    [
      { groupId: 'a', groupOperator: 'AND', field: 'status', operator: 'equals', value: 'SUBMITTED' },
      { groupId: 'a', groupOperator: 'AND', field: 'order.shop.name', operator: 'equals', value: 'Other' },
      { groupId: 'b', groupOperator: 'AND', field: 'status', operator: 'equals', value: 'SUBMITTED' },
    ],
    context,
  );

  assert.equal(result.matched, true);
  assert.deepEqual(result.conditionResults.map((group) => group.groupMatched), [false, true]);
});

test('automation legacy conditions keep global OR semantics in one group', () => {
  const conditions = normalizeConditions([
    { field: 'status', operator: 'equals', value: 'NEW', logicOperator: 'OR' },
    { field: 'order.shop.name', operator: 'equals', value: 'Allegro', logicOperator: 'OR' },
  ]);

  const result = buildDryRunResult('automation-1', conditions, context);
  assert.equal(result.matched, true);
  assert.equal(result.conditionResults[0].groupOperator, 'OR');
});

test('automation greater_than coerces numeric strings', () => {
  const result = buildDryRunResult(
    'automation-1',
    [{ field: 'order.totalPaid', operator: 'greater_than', value: '20' }],
    context,
  );

  assert.equal(result.matched, true);
});

test('automation greater_than coerces dates', () => {
  const result = buildDryRunResult(
    'automation-1',
    [{ field: 'createdAt', operator: 'greater_than', value: '2026-06-01' }],
    context,
  );

  assert.equal(result.matched, true);
});

test('webhook URL validation rejects non-HTTPS and local targets before network lookup', async () => {
  await assert.rejects(() => assertPublicHttpsUrl('http://example.com/webhook'), /HTTPS/);
  await assert.rejects(() => assertPublicHttpsUrl('https://localhost/webhook'), /local/);
  await assert.rejects(() => assertPublicHttpsUrl('https://127.0.0.1/webhook'), /private IP/);
});
