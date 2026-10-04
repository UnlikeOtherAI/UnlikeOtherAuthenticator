import { BillingMonthlyChargeBasis, BillingSeatPolicy } from '@prisma/client';

import type {
  BillingCycleMoney, BillingCycleSeatInterval, BillingCycleSubscriptionLine,
} from '../contracts/billing-statement-v1.js';
import { exactMoney, minorAmountToMajor } from './billing-money.service.js';
import type { quoteSubscriptionMonthlyCharge } from './billing-monthly-subscription-quote.service.js';

type MonthlyQuote = Awaited<ReturnType<typeof quoteSubscriptionMonthlyCharge>>;

export function cycleMoney(amountMinor: bigint, currency: string): BillingCycleMoney {
  return { ...exactMoney(minorAmountToMajor(amountMinor.toString(), currency), currency),
    amount_minor: amountMinor.toString() };
}

function decimalSeconds(milliseconds: bigint | null): string | null {
  if (milliseconds === null) return null;
  const whole = milliseconds / 1000n;
  const fraction = (milliseconds % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function clipInterval(startsAt: Date, endsAt: Date | null,
  periodStart: Date, periodEnd: Date): { starts_at: string; ends_at: string } | null {
  const start = new Date(Math.max(startsAt.getTime(), periodStart.getTime()));
  const end = new Date(Math.min(endsAt?.getTime() ?? periodEnd.getTime(), periodEnd.getTime()));
  if (start >= end) return null;
  return { starts_at: start.toISOString(), ends_at: end.toISOString() };
}

function seatIntervals(quote: MonthlyQuote, periodStart: Date,
  periodEnd: Date): BillingCycleSeatInterval[] {
  if (quote.seatPolicy === BillingSeatPolicy.FIXED) {
    const revisions = [...quote.capacityRevisions]
      .sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime());
    return revisions.flatMap((revision, index) => {
      const interval = clipInterval(revision.effectiveAt,
        revisions[index + 1]?.effectiveAt ?? null, periodStart, periodEnd);
      return interval ? [{ ...interval, quantity: revision.quantity.toString() }] : [];
    });
  }
  const groups = new Map<string, { interval: NonNullable<ReturnType<typeof clipInterval>>;
    quantity: number }>();
  for (const row of quote.intervals) {
    const interval = clipInterval(row.startsAt, row.endsAt, periodStart, periodEnd);
    if (!interval) continue;
    const key = `${interval.starts_at}\0${interval.ends_at}`;
    const group = groups.get(key);
    if (group) group.quantity += 1;
    else groups.set(key, { interval, quantity: 1 });
  }
  return [...groups.values()].map((item) => ({ ...item.interval,
    quantity: item.quantity.toString() }))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at) ||
      a.ends_at.localeCompare(b.ends_at));
}

export function projectMonthlySubscriptionLine(
  quote: MonthlyQuote, periodStart: Date, periodEnd: Date,
): BillingCycleSubscriptionLine {
  const fixed = quote.seatPolicy === BillingSeatPolicy.FIXED;
  const intervals = seatIntervals(quote, periodStart, periodEnd);
  const fixedQuantity = fixed && intervals.every((item) => item.quantity === intervals[0]?.quantity)
    ? intervals[0]?.quantity ?? null : null;
  return {
    id: quote.agreementId ?? quote.source.id,
    label: quote.chargeBasis === BillingMonthlyChargeBasis.FLAT
      ? 'Monthly subscription' : 'Monthly seats',
    charge_basis: quote.chargeBasis.toLowerCase() as 'flat' | 'per_seat',
    seat_policy: quote.seatPolicy?.toLowerCase() as 'automatic' | 'fixed' | undefined ?? null,
    seat_timing: quote.seatChargeTiming?.toLowerCase() as
      'full_month' | 'prorated' | undefined ?? null,
    unit_price: cycleMoney(quote.unitAmountMinor, quote.currency),
    quantity: quote.chargeBasis === BillingMonthlyChargeBasis.FLAT ? '1' :
      fixed ? fixedQuantity : quote.uniqueHumanSeats?.toString() ?? null,
    active_seat_seconds: decimalSeconds(quote.seatMilliseconds),
    month_seconds: decimalSeconds(quote.monthMilliseconds),
    intervals,
    customer_charge: cycleMoney(quote.amountMinor, quote.currency),
  };
}

export function privateMonthlyQuoteEvidence(quote: MonthlyQuote) {
  return {
    source: quote.source, service_id: quote.serviceId, tariff_id: quote.tariffId,
    organisation_id: quote.organisationId, team_id: quote.teamId,
    agreement_id: quote.agreementId, billing_month: quote.billingMonth,
    amount_minor: quote.amountMinor.toString(),
    unit_amount_minor: quote.unitAmountMinor.toString(), currency: quote.currency,
    charge_basis: quote.chargeBasis, seat_policy: quote.seatPolicy,
    seat_timing: quote.seatChargeTiming,
    baseline_captured_at: quote.baselineCapturedAt?.toISOString() ?? null,
    baseline_member_count: quote.baselineMemberCount,
    evidence_ids: [...quote.evidenceIds].sort(),
    intervals: [...quote.intervals].sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => ({ id: item.id, user_id: item.userId,
      starts_at: item.startsAt.toISOString(), ends_at: item.endsAt?.toISOString() ?? null })),
    capacity_revisions: [...quote.capacityRevisions].sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => ({ id: item.id,
      quantity: item.quantity, effective_at: item.effectiveAt.toISOString() })),
  };
}
