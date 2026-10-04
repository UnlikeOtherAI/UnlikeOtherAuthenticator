import { BillingSeatChargeTiming, BillingSeatPolicy } from '@prisma/client';

import { AppError } from '../utils/errors.js';

type MembershipInterval = {
  id: string;
  userId: string;
  startsAt: Date;
  endsAt: Date | null;
};

type CapacityRevision = {
  id: string;
  quantity: number;
  effectiveAt: Date;
};

export type SeatMonthQuoteInput = {
  billingMonth: string;
  seatPolicy: BillingSeatPolicy;
  seatChargeTiming: BillingSeatChargeTiming;
  unitAmountMinor: bigint;
  activatedAt: Date;
  endedAt: Date | null;
  membershipIntervals: MembershipInterval[];
  capacityRevisions: CapacityRevision[];
};

export type SeatMonthQuote = {
  amountMinor: bigint;
  unitAmountMinor: bigint;
  uniqueHumanSeats: number | null;
  seatMilliseconds: bigint;
  monthMilliseconds: bigint;
  evidenceIds: string[];
};

function invalidEvidence(): never {
  throw new AppError('INTERNAL', 409, 'BILLING_SEAT_EVIDENCE_INVALID');
}

function millis(value: Date): number {
  const result = value.getTime();
  if (!Number.isSafeInteger(result)) invalidEvidence();
  return result;
}

function monthBounds(month: string): { start: number; end: number } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) invalidEvidence();
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const start = Date.UTC(year, monthNumber - 1, 1);
  const end = Date.UTC(year, monthNumber, 1);
  if (year < 1970 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) invalidEvidence();
  return { start, end };
}

function overlap(start: number, end: number, from: number, to: number): number {
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

function automaticSeatTime(
  input: SeatMonthQuoteInput, from: number, to: number, monthDuration: bigint,
): Pick<SeatMonthQuote, 'uniqueHumanSeats' | 'seatMilliseconds' | 'evidenceIds'> {
  if (input.capacityRevisions.length !== 0) invalidEvidence();
  const byUser = new Map<string, MembershipInterval[]>();
  for (const interval of input.membershipIntervals) {
    const start = millis(interval.startsAt);
    const end = interval.endsAt === null ? Number.MAX_SAFE_INTEGER : millis(interval.endsAt);
    if (!interval.id || !interval.userId || start < millis(input.activatedAt) || end <= start) {
      invalidEvidence();
    }
    const list = byUser.get(interval.userId) ?? [];
    list.push(interval);
    byUser.set(interval.userId, list);
  }
  let seatMilliseconds = 0n;
  let uniqueHumanSeats = 0;
  const evidenceIds: string[] = [];
  for (const intervals of byUser.values()) {
    intervals.sort((a, b) => millis(a.startsAt) - millis(b.startsAt));
    let priorEnd = -Infinity;
    let userMilliseconds = 0n;
    for (const interval of intervals) {
      const start = millis(interval.startsAt);
      const end = interval.endsAt === null ? Number.MAX_SAFE_INTEGER : millis(interval.endsAt);
      if (start < priorEnd) invalidEvidence();
      priorEnd = end;
      const duration = overlap(start, end, from, to);
      if (duration > 0) {
        userMilliseconds += BigInt(duration);
        evidenceIds.push(interval.id);
      }
    }
    if (userMilliseconds > 0n) {
      uniqueHumanSeats += 1;
      seatMilliseconds += input.seatChargeTiming === BillingSeatChargeTiming.FULL_MONTH
        ? monthDuration : userMilliseconds;
    }
  }
  return { uniqueHumanSeats, seatMilliseconds, evidenceIds: evidenceIds.sort() };
}

function fixedSeatTime(
  input: SeatMonthQuoteInput, from: number, to: number, monthDuration: bigint,
): Pick<SeatMonthQuote, 'uniqueHumanSeats' | 'seatMilliseconds' | 'evidenceIds'> {
  if (input.membershipIntervals.length !== 0) invalidEvidence();
  const revisions = [...input.capacityRevisions].sort((a, b) =>
    millis(a.effectiveAt) - millis(b.effectiveAt));
  const first = revisions[0];
  if (!first || millis(first.effectiveAt) !== millis(input.activatedAt)) {
    invalidEvidence();
  }
  let quantity = 0;
  let cursor = from;
  let seatMilliseconds = 0n;
  let maxQuantity = 0;
  const evidenceIds: string[] = [];
  for (let index = 0; index < revisions.length; index += 1) {
    const revision = revisions[index];
    if (!revision) invalidEvidence();
    const time = millis(revision.effectiveAt);
    const previous = revisions[index - 1];
    if (!revision.id || !Number.isSafeInteger(revision.quantity) || revision.quantity <= 0 ||
      (previous && time <= millis(previous.effectiveAt))) invalidEvidence();
    if (time <= from) {
      quantity = revision.quantity;
      const next = revisions[index + 1];
      if (time === from || index === revisions.length - 1 ||
        (next && millis(next.effectiveAt) > from)) evidenceIds.push(revision.id);
      continue;
    }
    if (time >= to) break;
    if (quantity === 0) invalidEvidence();
    seatMilliseconds += BigInt(quantity) * BigInt(time - cursor);
    maxQuantity = Math.max(maxQuantity, quantity);
    cursor = time;
    quantity = revision.quantity;
    evidenceIds.push(revision.id);
  }
  if (quantity === 0) invalidEvidence();
  seatMilliseconds += BigInt(quantity) * BigInt(to - cursor);
  maxQuantity = Math.max(maxQuantity, quantity);
  if (input.seatChargeTiming === BillingSeatChargeTiming.FULL_MONTH) {
    seatMilliseconds = BigInt(maxQuantity) * monthDuration;
  }
  return { uniqueHumanSeats: null, seatMilliseconds, evidenceIds: [...new Set(evidenceIds)] };
}

/** The only rounding occurs after all member or capacity intervals are summed. */
export function quoteMonthlySeatCharge(input: SeatMonthQuoteInput): SeatMonthQuote {
  if (input.unitAmountMinor < 0n) invalidEvidence();
  const { start, end } = monthBounds(input.billingMonth);
  const monthMilliseconds = BigInt(end - start);
  const activatedAt = millis(input.activatedAt);
  const endedAt = input.endedAt === null ? Number.MAX_SAFE_INTEGER : millis(input.endedAt);
  if (endedAt <= activatedAt) invalidEvidence();
  const from = Math.max(start, activatedAt);
  const to = Math.min(end, endedAt);
  if (from >= to) {
    return { amountMinor: 0n, unitAmountMinor: input.unitAmountMinor,
      uniqueHumanSeats: input.seatPolicy === BillingSeatPolicy.AUTOMATIC ? 0 : null,
      seatMilliseconds: 0n, monthMilliseconds, evidenceIds: [] };
  }
  const evidence = input.seatPolicy === BillingSeatPolicy.AUTOMATIC
    ? automaticSeatTime(input, from, to, monthMilliseconds)
    : fixedSeatTime(input, from, to, monthMilliseconds);
  const numerator = input.unitAmountMinor * evidence.seatMilliseconds;
  const amountMinor = (numerator * 2n + monthMilliseconds) / (2n * monthMilliseconds);
  return { ...evidence, amountMinor, unitAmountMinor: input.unitAmountMinor,
    monthMilliseconds };
}
