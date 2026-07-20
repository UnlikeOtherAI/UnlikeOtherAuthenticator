export type StripeBillingPeriodPhase = 'calendar_month' | 'free_alignment_period' | 'unknown';

export function stripeCalendarBillingMonth(
  periodStart: Date | null,
  periodEnd: Date | null,
): string | null {
  if (!periodStart || !periodEnd) return null;
  const expectedStart = Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), 1);
  const expectedEnd = Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1);
  if (periodStart.getTime() !== expectedStart || periodEnd.getTime() !== expectedEnd) {
    return null;
  }
  return `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function stripeBillingPeriodPhase(
  periodStart: Date | null,
  periodEnd: Date | null,
): StripeBillingPeriodPhase {
  if (!periodStart || !periodEnd) return 'unknown';
  if (stripeCalendarBillingMonth(periodStart, periodEnd)) return 'calendar_month';
  const monthStart = Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), 1);
  const nextMonthStart = Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1);
  return periodStart.getTime() > monthStart &&
    periodStart.getTime() < nextMonthStart &&
    periodEnd.getTime() === nextMonthStart
    ? 'free_alignment_period'
    : 'unknown';
}
