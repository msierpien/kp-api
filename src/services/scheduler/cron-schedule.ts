function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function spreadMinuteOffset(
  key: string,
  intervalMinutes: number,
  windowStart: number,
  windowSize: number,
) {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error('intervalMinutes must be a positive integer');
  }
  if (!Number.isInteger(windowStart) || windowStart < 0 || windowStart > 59) {
    throw new Error('windowStart must be an integer between 0 and 59');
  }
  if (!Number.isInteger(windowSize) || windowSize <= 0) {
    throw new Error('windowSize must be a positive integer');
  }

  const maximumOffset = Math.min(intervalMinutes - 1, 59);
  const firstOffset = Math.min(windowStart, maximumOffset);
  const availableWindowSize = Math.min(windowSize, maximumOffset - firstOffset + 1);

  return firstOffset + (stableHash(key) % availableWindowSize);
}

export function intervalToCron(intervalMinutes: number, minuteOffset = 0): string {
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0) {
    throw new Error('intervalMinutes must be a positive integer');
  }
  if (!Number.isInteger(minuteOffset) || minuteOffset < 0 || minuteOffset > 59) {
    throw new Error('minuteOffset must be an integer between 0 and 59');
  }

  if (intervalMinutes >= 60 && intervalMinutes % 60 === 0) {
    const hours = intervalMinutes / 60;
    return hours === 1
      ? `${minuteOffset} * * * *`
      : `${minuteOffset} */${hours} * * *`;
  }

  const normalizedOffset = minuteOffset % intervalMinutes;
  return `${normalizedOffset}-59/${intervalMinutes} * * * *`;
}
