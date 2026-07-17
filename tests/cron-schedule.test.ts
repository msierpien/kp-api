import assert from 'node:assert/strict';
import test from 'node:test';
import { intervalToCron, spreadMinuteOffset } from '../src/services/scheduler/cron-schedule';

test('intervalToCron applies an offset to recurring schedules', () => {
  assert.equal(intervalToCron(10, 4), '4-59/10 * * * *');
  assert.equal(intervalToCron(60, 17), '17 * * * *');
  assert.equal(intervalToCron(120, 17), '17 */2 * * *');
});

test('spreadMinuteOffset keeps jobs in their assigned windows', () => {
  const shopOffset = spreadMinuteOffset('shop:production', 10, 3, 6);
  const wholesaleOffset = spreadMinuteOffset('wholesale:provider', 60, 12, 12);

  assert.ok(shopOffset >= 3 && shopOffset <= 8);
  assert.ok(wholesaleOffset >= 12 && wholesaleOffset <= 23);
  assert.equal(
    spreadMinuteOffset('shop:production', 10, 3, 6),
    shopOffset,
    'the same entity must keep a stable offset',
  );
});

test('cron schedule helpers reject invalid values', () => {
  assert.throws(() => intervalToCron(0), /positive integer/);
  assert.throws(() => intervalToCron(10, 60), /between 0 and 59/);
  assert.throws(() => spreadMinuteOffset('shop', 10, -1, 5), /between 0 and 59/);
});
