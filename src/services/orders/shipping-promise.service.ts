export interface ShippingPromiseInput {
  baseDate: Date;
  leadTimeDays?: number | null;
  cutoffHour?: number;
  cutoffMinute?: number;
  timeZone?: string;
  notBefore?: Date | null;
}

export interface ShippingPromise {
  shippingDate: Date;
  shippingLeadTimeDays: number;
  shippingPromiseLabel: string;
  shippingSource: string;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const DEFAULT_TIME_ZONE = 'Europe/Warsaw';

export function normalizeCutoff(config: any) {
  const value = config?.shipping?.sameDayCutoff ?? config?.sameDayCutoff ?? config?.orderSync?.sameDayCutoff;
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return { hour, minute };
      }
    }
  }

  return { hour: 12, minute: 0 };
}

export function calculateShippingPromise(input: ShippingPromiseInput): ShippingPromise {
  const timeZone = input.timeZone || DEFAULT_TIME_ZONE;
  const cutoffHour = input.cutoffHour ?? 12;
  const cutoffMinute = input.cutoffMinute ?? 0;
  const leadTimeDays = normalizeLeadTimeDays(input.leadTimeDays);
  const baseParts = getLocalParts(input.baseDate, timeZone);
  const baseDate = localDate(baseParts.year, baseParts.month, baseParts.day);
  const baseBusinessDate = isBusinessDate(baseDate) ? baseDate : nextBusinessDate(baseDate);
  const afterCutoff = isBusinessDate(baseDate)
    && (baseParts.hour > cutoffHour || (baseParts.hour === cutoffHour && baseParts.minute >= cutoffMinute));
  const startDate = afterCutoff ? nextBusinessDate(baseBusinessDate) : baseBusinessDate;
  let shippingDate = addBusinessDays(startDate, leadTimeDays);

  if (input.notBefore) {
    const notBeforeParts = getLocalParts(input.notBefore, timeZone);
    const notBeforeDate = localDate(notBeforeParts.year, notBeforeParts.month, notBeforeParts.day);
    if (notBeforeDate.getTime() > shippingDate.getTime()) {
      shippingDate = isBusinessDate(notBeforeDate) ? notBeforeDate : nextBusinessDate(notBeforeDate);
    }
  }

  return {
    shippingDate,
    shippingLeadTimeDays: leadTimeDays,
    shippingPromiseLabel: shippingLabel(baseDate, shippingDate),
    shippingSource: leadTimeDays === 0 ? 'LOCAL_STOCK' : 'LEAD_TIME',
  };
}

export function shippingLabel(baseDate: Date, shippingDate: Date) {
  const diff = calendarDayDiff(baseDate, shippingDate);
  if (diff === 0) return 'Wysyłka dzisiaj';
  if (diff === 1) return 'Wysyłka jutro';
  if (diff === 2) return 'Wysyłka pojutrze';
  return `Wysyłka do ${formatPolishDate(shippingDate)}`;
}

export function maxShippingPromise(promises: Array<ShippingPromise | null | undefined>) {
  const valid = promises.filter(Boolean) as ShippingPromise[];
  if (valid.length === 0) return null;
  return valid.reduce((max, current) => (
    current.shippingDate.getTime() > max.shippingDate.getTime() ? current : max
  ));
}

function normalizeLeadTimeDays(value?: number | null) {
  const days = Number(value ?? 0);
  if (!Number.isInteger(days) || days < 0 || days > 365) return 0;
  return days;
}

function getLocalParts(date: Date, timeZone: string): LocalDateParts {
  const parts = new Intl.DateTimeFormat('pl-PL', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
  };
}

function localDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

function isBusinessDate(date: Date) {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}

function nextBusinessDate(date: Date) {
  let next = addCalendarDays(date, 1);
  while (!isBusinessDate(next)) {
    next = addCalendarDays(next, 1);
  }
  return next;
}

function addBusinessDays(date: Date, days: number) {
  let next = date;
  let remaining = days;
  while (remaining > 0) {
    next = addCalendarDays(next, 1);
    if (isBusinessDate(next)) remaining--;
  }
  return next;
}

function addCalendarDays(date: Date, days: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

function calendarDayDiff(start: Date, end: Date) {
  const day = 24 * 60 * 60 * 1000;
  return Math.round((end.getTime() - start.getTime()) / day);
}

function formatPolishDate(date: Date) {
  return new Intl.DateTimeFormat('pl-PL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}
