import { createHash } from 'node:crypto';
import { BillingTariffMode, Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';

const DENOMINATOR = 10_000n * 10n ** 18n;
const MICRO_FACTOR = 1_000_000_000n;
const MAX_INT64 = 9_223_372_036_854_775_807n;

function scaledRaw(value: Prisma.Decimal): bigint {
  const [whole, fraction = ''] = value.toFixed(18).split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

function roundedCumulative(quanta: bigint): bigint {
  const credits = (quanta * MICRO_FACTOR + DENOMINATOR - 1n) / DENOMINATOR;
  if (credits > MAX_INT64) throw new AppError('BAD_REQUEST', 400, 'PAID_LIABILITY_TOO_LARGE');
  return credits;
}

export function maximumRatedMicrocredits(raw: Prisma.Decimal, markupBps: number): bigint {
  if (!Number.isSafeInteger(markupBps) || markupBps < 0 || raw.isNegative()) {
    throw new AppError('BAD_REQUEST', 400, 'PAID_LIABILITY_RATE_INVALID');
  }
  return roundedCumulative(scaledRaw(raw) * BigInt(10_000 + markupBps));
}

/** One frozen-rated liability delta is shared by cycles and all budget scopes. */
export async function recordPaidUsageLiability(
  tx: Prisma.TransactionClient,
  params: { dispatchId: string; receiptId: string; actual: Prisma.Decimal;
    creditAccountId?: string; operatorWaiver?: boolean },
) {
  const hold = await tx.billingCreditBudgetDispatch.findUnique({
    where: { dispatchId: params.dispatchId },
  });
  if (!hold) throw new AppError('BAD_REQUEST', 409, 'PAID_DISPATCH_EVIDENCE_MISSING');
  if (hold.isLegacy) throw new AppError('BAD_REQUEST', 409, 'LEGACY_RATING_SOURCE_REQUIRED');
  const prior = await tx.billingPaidUsageLiability.findUnique({
    where: { dispatchId: params.dispatchId },
  });
  if (prior) {
    if (prior.receiptId !== params.receiptId || !prior.rawCostActual.eq(params.actual)
      || prior.creditAccountId !== (params.creditAccountId ?? null)) {
      throw new AppError('BAD_REQUEST', 409, 'PAID_RECEIPT_CONFLICT');
    }
    return prior;
  }
  if (hold.status !== 'ACTIVE') throw new AppError('BAD_REQUEST', 409, 'PAID_DISPATCH_NOT_ACTIVE');
  if ((hold.paymentMode === 'PREPAID') !== Boolean(params.creditAccountId)) {
    throw new AppError('BAD_REQUEST', 409, 'PAID_RATING_SCOPE_MISSING');
  }
  const ratingScopeKey = params.creditAccountId
    ? `prepaid:${params.creditAccountId}`
    : `payg:${createHash('sha256').update(JSON.stringify([
      hold.orgId, hold.teamId, hold.currency,
    ])).digest('hex')}`;
  await tx.$queryRaw(Prisma.sql`SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(${`billing-paid-rating:${ratingScopeKey}`}, 0))::text`);
  const bucket = await tx.billingPaidRatingBucket.findUnique({ where: { ratingScopeKey } });
  if (bucket && (bucket.orgId !== hold.orgId || bucket.currency !== hold.currency)) {
    throw new AppError('BAD_REQUEST', 409, 'PAID_RATING_SCOPE_CONFLICT');
  }
  const legacyBucket = params.creditAccountId
    ? await tx.billingPrepaidRatingBucket.findUnique({
      where: { creditAccountId: params.creditAccountId },
    }) : null;
  if (legacyBucket && legacyBucket.currency !== hold.currency) {
    throw new AppError('BAD_REQUEST', 409, 'PAID_RATING_SCOPE_CONFLICT');
  }
  const oldQuanta = bucket ? BigInt(bucket.cumulativeRatedQuanta.toFixed(0)) : 0n;
  const oldMicro = bucket?.ratedMicrocredits ?? 0n;
  const legacyQuanta = legacyBucket ? BigInt(legacyBucket.cumulativeRatedQuanta.toFixed(0)) : 0n;
  const legacyPaid = legacyBucket?.debitedMicrocredits ?? 0n;
  const ratedQuanta = hold.tariffMode === BillingTariffMode.FREE ? 0n
    : scaledRaw(params.actual) * BigInt(10_000 + hold.frozenMarkupBps);
  const newQuanta = oldQuanta + ratedQuanta;
  const targetMicro = roundedCumulative(legacyQuanta + newQuanta);
  const alreadyPaid = legacyPaid + oldMicro;
  const deltaMicro = targetMicro > alreadyPaid ? targetMicro - alreadyPaid : 0n;
  if (!params.operatorWaiver && hold.reservedMicrocredits !== null
    && deltaMicro > hold.reservedMicrocredits) {
    throw new AppError('BAD_REQUEST', 409, 'PAID_RECEIPT_EXCEEDS_BOUND');
  }
  await tx.billingPaidRatingBucket.upsert({ where: { ratingScopeKey },
    create: { ratingScopeKey, orgId: hold.orgId, currency: hold.currency,
      cumulativeRatedQuanta: newQuanta.toString(), ratedMicrocredits: oldMicro + deltaMicro },
    update: { cumulativeRatedQuanta: newQuanta.toString(), ratedMicrocredits: oldMicro + deltaMicro },
  });
  const liability = await tx.billingPaidUsageLiability.create({ data: {
    dispatchId: hold.dispatchId, receiptId: params.receiptId,
    serviceId: hold.serviceId, providerServiceId: hold.providerServiceId,
    orgId: hold.orgId, teamId: hold.teamId, userId: hold.userId,
    billingMonth: hold.billingMonth, currency: hold.currency,
    tariffId: hold.tariffId, frozenMarkupBps: hold.frozenMarkupBps,
    paymentMode: hold.paymentMode, creditAccountId: params.creditAccountId,
    rawCostActual: params.actual,
    ratedQuanta: ratedQuanta.toString(), ratedMicrocredits: deltaMicro,
  } });
  await tx.billingCreditBudgetDispatch.update({ where: { dispatchId: hold.dispatchId },
    data: { status: 'SETTLED', terminalAt: new Date() },
  });
  return liability;
}

/** Preserve the exact amount already debited by the pre-cutover PREPAID
 * cumulative bucket. No historical receipt is rerated into the new bucket. */
export async function recordLegacyPrepaidLiability(tx: Prisma.TransactionClient,
  params: { dispatchId: string; receiptId: string; reservationId: string;
    ratedMicrocredits: bigint; occurredAt: Date }) {
  const hold = await tx.billingCreditBudgetDispatch.findUnique({
    where: { dispatchId: params.dispatchId },
  });
  if (!hold?.isLegacy || hold.paymentMode !== 'PREPAID') {
    throw new AppError('BAD_REQUEST', 409, 'LEGACY_RATING_SOURCE_REQUIRED');
  }
  const prior = await tx.billingCreditBudgetLegacyLiability.findUnique({
    where: { dispatchId: params.dispatchId },
  });
  if (prior) {
    if (prior.receiptId !== params.receiptId || prior.sourceId !== params.reservationId
      || prior.ratedMicrocredits !== params.ratedMicrocredits) {
      throw new AppError('BAD_REQUEST', 409, 'LEGACY_RECEIPT_CONFLICT');
    }
    return prior;
  }
  if (hold.status !== 'ACTIVE' || params.ratedMicrocredits < 0n
    || (hold.reservedMicrocredits !== null
      && params.ratedMicrocredits > hold.reservedMicrocredits)) {
    throw new AppError('BAD_REQUEST', 409, 'LEGACY_RECEIPT_EXCEEDS_BOUND');
  }
  const row = await tx.billingCreditBudgetLegacyLiability.create({ data: {
    dispatchId: hold.dispatchId, receiptId: params.receiptId,
    serviceId: hold.serviceId, orgId: hold.orgId, teamId: hold.teamId,
    userId: hold.userId, billingMonth: hold.billingMonth,
    ratedMicrocredits: params.ratedMicrocredits,
    sourceType: 'prepaid_wallet_debit', sourceId: params.reservationId,
    occurredAt: params.occurredAt,
  } });
  await tx.billingCreditBudgetDispatch.update({ where: { dispatchId: hold.dispatchId },
    data: { status: 'SETTLED', terminalAt: new Date() },
  });
  return row;
}
