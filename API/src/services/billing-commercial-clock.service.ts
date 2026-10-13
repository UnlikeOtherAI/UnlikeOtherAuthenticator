import { AppError } from '../utils/errors.js';

const DAY = 86_400_000;

export function commercialTimezone(value: string | null | undefined): string {
  const timezone = value ?? 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return timezone;
  } catch {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_TIMEZONE_INVALID');
  }
}

/** Elapsed hours count only while the company's local date is Monday–Friday. */
export function weekdayGraceDeadline(failure: Date, timezone: string, hours = 24): Date {
  if (!Number.isFinite(failure.getTime()) || !Number.isSafeInteger(hours) || hours <= 0) {
    throw new AppError('BAD_REQUEST', 400, 'BILLING_GRACE_INVALID');
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: commercialTimezone(timezone), year: 'numeric', month: '2-digit',
    day: '2-digit', weekday: 'short',
  });
  const dateKey = (timestamp: number) => formatter.format(timestamp);
  const weekday = (timestamp: number) => formatter.formatToParts(timestamp)
    .find((part) => part.type === 'weekday')?.value;
  let cursor = failure.getTime();
  let remaining = hours * 3_600_000;
  while (remaining > 0) {
    const key = dateKey(cursor);
    // Binary-search the actual next local-date boundary. This naturally handles
    // 23/25-hour DST dates and IANA offsets without treating a day as 24 hours.
    let left = cursor + 1;
    let right = cursor + 2 * DAY;
    while (left < right) {
      const middle = left + Math.floor((right - left) / 2);
      if (dateKey(middle) === key) left = middle + 1;
      else right = middle;
    }
    const nextDate = left;
    if (!['Sat', 'Sun'].includes(weekday(cursor) ?? '')) {
      const used = Math.min(remaining, nextDate - cursor);
      remaining -= used;
      if (remaining === 0) return new Date(cursor + used);
    }
    cursor = nextDate;
  }
  return new Date(cursor);
}

/** One month is a calendar month in UTC, clamped to the final day. */
export function defaultTrialEnd(start: Date): Date {
  const result = new Date(start);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}
