import {
  BillingCreditEntryDirection, BillingCreditEntryKind, BillingPrepaidReservationStatus,
  BillingTariffMode,
  BillingUsagePaymentMode, MembershipStatus, Prisma, type PrismaClient,
} from '@prisma/client';

import { getPublicBaseUrl } from '../config/env.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { resolveCreditAccount, resolveCreditCollectionContext } from './billing-credit-account.service.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import { verifyChainedSubjectAccessToken } from './confidential-chained-token-exchange.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { resolveBillingTariffForMonth, utcBillingMonth } from './billing-tariff-history.service.js';
import { verifyLedgerRuntimeKey } from './billing-ledger-runtime-key.service.js';
import { assertLiveJobComputeDispatch, type JobComputeDispatchIdentity } from './billing-job-compute-renewal.service.js';
import { assertLedgerBudgetContext, attachLegacyBudgetDispatch,
  lockBudgetOrganisation, releaseBudgetDispatch, reserveBudgetDispatch,
  type VerifiedBudgetContext } from './billing-credit-budget-dispatch.service.js';
import { recordLegacyPrepaidLiability,
  recordPaidUsageLiability } from './billing-paid-liability.service.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;

function validId(value: string): string {
  if (!ID_PATTERN.test(value)) throw new AppError('BAD_REQUEST', 400, 'PREPAID_DISPATCH_ID_INVALID');
  return value;
}

function rawCost(value: string): Prisma.Decimal {
  if (!DECIMAL_PATTERN.test(value)) throw new AppError('BAD_REQUEST', 400, 'PREPAID_COST_INVALID');
  const decimal = new Prisma.Decimal(value);
  if (decimal.decimalPlaces() > 18 || !decimal.isFinite() || decimal.isNegative()) {
    throw new AppError('BAD_REQUEST', 400, 'PREPAID_COST_INVALID');
  }
  return decimal;
}

function scaledRaw(value: Prisma.Decimal): bigint {
  const [whole, fraction = ''] = value.toFixed(18).split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

function ratedMicrocreditsScaled(scaled: bigint, markupBps: number): bigint {
  const denominator = 10_000n * 10n ** 18n;
  const numerator = scaled * BigInt(10_000 + markupBps) * 1_000_000_000n;
  const credits = (numerator + denominator - 1n) / denominator;
  if (credits > MAX_INT64) throw new AppError('BAD_REQUEST', 400, 'PREPAID_COST_TOO_LARGE');
  return credits;
}

function ratedMicrocreditsFromQuanta(quanta: bigint): bigint {
  const denominator = 10_000n * 10n ** 18n;
  const credits = (quanta * 1_000_000_000n + denominator - 1n) / denominator;
  if (credits > MAX_INT64) throw new AppError('BAD_REQUEST', 400, 'PREPAID_COST_TOO_LARGE');
  return credits;
}

function ratedMicrocredits(value: Prisma.Decimal, markupBps: number): bigint {
  return ratedMicrocreditsScaled(scaledRaw(value), markupBps);
}

export type ReservePrepaidDispatchInput = {
  dispatchId: string;
  requestFingerprint: string;
  dispatchStartedAt: string;
  product: string;
  providerServiceId: string;
  organisationId: string;
  teamId: string;
  userId: string;
  rawCostBound: string | null;
  currency: string;
  jobCompute?: JobComputeDispatchIdentity | null;
  billingContext?: VerifiedBudgetContext | null;
};

async function assertActiveSubject(
  tx: Prisma.TransactionClient,
  input: ReservePrepaidDispatchInput,
  tokenVersion: number,
): Promise<void> {
  // Admission serializes against token-epoch and membership revocation writers.
  // Every reserve, including an idempotent replay, reacquires these row locks.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${input.userId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id = ${input.organisationId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM org_members
    WHERE org_id = ${input.organisationId} AND user_id = ${input.userId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM teams WHERE id = ${input.teamId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM team_members
    WHERE team_id = ${input.teamId} AND user_id = ${input.userId} FOR SHARE`);
  const [user, orgMember, team] = await Promise.all([
    tx.user.findUnique({ where: { id: input.userId },
      select: { id: true, lifecycleStatus: true, tokenVersion: true } }),
    tx.orgMember.findUnique({ where: { orgId_userId: {
      orgId: input.organisationId, userId: input.userId } }, select: { status: true } }),
    tx.team.findFirst({ where: { id: input.teamId, orgId: input.organisationId,
      lifecycleStatus: 'ACTIVE', org: { lifecycleStatus: 'ACTIVE' },
      members: { some: { userId: input.userId, status: MembershipStatus.ACTIVE } } },
    select: { id: true } }),
  ]);
  if (!user || user.lifecycleStatus !== 'ACTIVE' || user.tokenVersion !== tokenVersion ||
    orgMember?.status !== MembershipStatus.ACTIVE || !team) {
    throw new AppError('FORBIDDEN', 403, 'PREPAID_SUBJECT_NOT_ENTITLED');
  }
}

async function lockDispatchId(tx: Prisma.TransactionClient, dispatchId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(481602, hashtext(${dispatchId}))::text`);
}

async function assertActiveRuntimeKey(tx: Prisma.TransactionClient, keyId: string): Promise<void> {
  const keys = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM billing_ledger_runtime_keys
    WHERE id = ${keyId} AND revoked_at IS NULL FOR SHARE
  `);
  if (keys.length !== 1) throw new AppError('UNAUTHORIZED', 401, 'INVALID_LEDGER_RUNTIME_KEY');
}

async function withBudgetContextDigest<T extends { dispatch_id: string }>(
  prisma: PrismaClient, decision: T,
) {
  const hold = await prisma.billingCreditBudgetDispatch.findUnique({
    where: { dispatchId: decision.dispatch_id }, select: { contextDigest: true },
  });
  return { ...decision, context_digest: hold?.contextDigest ?? null };
}

export async function reservePrepaidDispatch(
  params: { runtimeSecret: string; delegation: string; input: ReservePrepaidDispatchInput },
  deps?: { prisma?: PrismaClient; now?: Date },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const key = await verifyLedgerRuntimeKey(params.runtimeSecret, { prisma });
  const input = params.input;
  validId(input.dispatchId);
  if (!/^[a-f0-9]{64}$/.test(input.requestFingerprint)) {
    throw new AppError('BAD_REQUEST', 400, 'PREPAID_REQUEST_FINGERPRINT_INVALID');
  }
  validId(input.providerServiceId);
  if (input.product !== key.service.identifier || !/^[A-Z]{3}$/.test(input.currency)) {
    throw new AppError('FORBIDDEN', 403, 'PREPAID_PRODUCT_OR_CURRENCY_MISMATCH');
  }
  const actor = await verifyChainedSubjectAccessToken({
    subjectToken: params.delegation,
    callerAudience: key.ledgerAudience,
    issuer: getPublicBaseUrl(),
  });
  if (actor.product !== input.product || actor.source_domain !== key.sourceDomain ||
    !actor.scope.split(' ').includes('ai.invoke') ||
    actor.sub !== input.userId || actor.active.orgId !== input.organisationId ||
    actor.active.teamId !== input.teamId) {
    throw new AppError('FORBIDDEN', 403, 'PREPAID_DELEGATION_MISMATCH');
  }
  const bound = input.rawCostBound === null ? null : rawCost(input.rawCostBound);
  const dispatchStartedAt = new Date(input.dispatchStartedAt);
  const now = deps?.now ?? new Date();
  if (!Number.isFinite(dispatchStartedAt.getTime()) ||
    dispatchStartedAt.toISOString() !== input.dispatchStartedAt) {
    throw new AppError('BAD_REQUEST', 400, 'PREPAID_DISPATCH_TIME_INVALID');
  }
  const billingMonth = utcBillingMonth(dispatchStartedAt);
  const decision = await runBillingSerializableTransaction(prisma, async (tx) => {
    await lockDispatchId(tx, input.dispatchId);
    await assertActiveRuntimeKey(tx, key.id);
    await assertActiveSubject(tx, input, actor.tv);
    await assertLiveJobComputeDispatch(tx, { claim: actor.job_compute,
      identity: input.jobCompute ?? null, runtimeKeyId: key.id,
      subjectId: input.userId, orgId: input.organisationId,
      teamId: input.teamId, tokenVersion: actor.tv, now });
    await assertLedgerBudgetContext(tx, { product: input.product,
      sourceDomain: actor.source_domain, context: input.billingContext ?? null,
      jobGrantId: input.jobCompute?.grantId ?? null,
      originInvocationId: input.jobCompute?.originInvocationId ?? null });
    const previous = await tx.billingLedgerDispatchDecision.findUnique({
      where: { dispatchId: input.dispatchId },
    });
    if (previous) {
      if (previous.status !== 'PAY_AS_YOU_GO' || previous.runtimeKeyId !== key.id ||
        previous.requestFingerprint !== input.requestFingerprint ||
        previous.serviceId !== key.serviceId ||
        previous.providerServiceId !== input.providerServiceId ||
        previous.orgId !== input.organisationId || previous.teamId !== input.teamId ||
        previous.userId !== input.userId || previous.billingMonth !== billingMonth ||
        previous.dispatchStartedAt?.getTime() !== dispatchStartedAt.getTime() ||
        previous.currency !== input.currency ||
        (bound === null ? previous.rawCostBound !== null :
          !previous.rawCostBound?.eq(bound))) {
        throw new AppError('BAD_REQUEST', 409, 'PREPAID_DISPATCH_CONFLICT');
      }
      return { payment_mode: 'pay_as_you_go' as const, reservation_id: null,
        dispatch_id: input.dispatchId, request_fingerprint: input.requestFingerprint,
        billing_month: billingMonth, currency: input.currency };
    }
    const existing = await tx.billingPrepaidReservation.findUnique({
      where: { dispatchId: input.dispatchId },
    });
    if (existing) {
      if (existing.appKeyId !== key.id || existing.serviceId !== key.serviceId ||
        existing.requestFingerprint !== input.requestFingerprint ||
        existing.providerServiceId !== input.providerServiceId ||
        existing.orgId !== input.organisationId || existing.teamId !== input.teamId ||
        existing.userId !== input.userId || existing.currency !== input.currency ||
        existing.billingMonth !== billingMonth ||
        existing.dispatchStartedAt.getTime() !== dispatchStartedAt.getTime() ||
        bound === null || !existing.rawCostBound.eq(bound) || existing.status !== 'ACTIVE') {
        throw new AppError('BAD_REQUEST', 409, 'PREPAID_DISPATCH_CONFLICT');
      }
      return { payment_mode: 'prepaid' as const, reservation_id: existing.id,
        dispatch_id: existing.dispatchId, request_fingerprint: existing.requestFingerprint,
        reserved_microcredits: existing.reservedMicrocredits.toString(),
        billing_month: existing.billingMonth, currency: existing.currency };
    }
    if (Math.abs(now.getTime() - dispatchStartedAt.getTime()) > 5 * 60_000) {
      throw new AppError('BAD_REQUEST', 400, 'PREPAID_DISPATCH_TIME_INVALID');
    }
    const tariff = (await resolveBillingTariffForMonth(tx, {
      serviceId: key.serviceId, organisationId: input.organisationId,
      teamId: input.teamId, billingMonth,
    })).tariff;
    if (tariff.usagePaymentMode === BillingUsagePaymentMode.PAY_AS_YOU_GO ||
      tariff.mode === BillingTariffMode.FREE) {
      await reserveBudgetDispatch(tx, { dispatchId: input.dispatchId, startedAt: dispatchStartedAt,
        product: input.product, serviceId: key.serviceId,
        providerServiceId: input.providerServiceId,
        orgId: input.organisationId, teamId: input.teamId, userId: input.userId,
        billingMonth, currency: input.currency, tariffId: tariff.id,
        tariffMode: tariff.mode, markupBps: tariff.markupBps,
        paymentMode: 'PAY_AS_YOU_GO', rawCostBound: bound,
        context: input.billingContext ?? null });
      await tx.billingLedgerDispatchDecision.create({ data: {
        dispatchId: input.dispatchId, requestFingerprint: input.requestFingerprint,
        runtimeKeyId: key.id, serviceId: key.serviceId,
        providerServiceId: input.providerServiceId, orgId: input.organisationId,
        teamId: input.teamId, userId: input.userId, billingMonth,
        dispatchStartedAt, currency: input.currency, rawCostBound: bound,
        status: 'PAY_AS_YOU_GO',
      } });
      return { payment_mode: 'pay_as_you_go' as const, reservation_id: null,
        dispatch_id: input.dispatchId, request_fingerprint: input.requestFingerprint,
        billing_month: billingMonth, currency: input.currency };
    }
    if (tariff.currency !== input.currency) {
      throw new AppError('BAD_REQUEST', 409, 'PREPAID_CURRENCY_UNSUPPORTED');
    }
    return null;
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
  if (decision) return withBudgetContextDigest(prisma, decision);
  if (bound === null) throw new AppError('BAD_REQUEST', 422, 'PREPAID_BOUND_REQUIRED');
  if (input.currency !== 'USD') {
    throw new AppError('BAD_REQUEST', 409, 'PREPAID_CURRENCY_UNSUPPORTED');
  }
  const collection = await resolveCreditCollectionContext({
    organisationId: input.organisationId, teamId: input.teamId,
  }, { prisma });
  const creditAccount = await resolveCreditAccount({
    account: collection.account,
    organisationId: input.organisationId, teamId: input.teamId,
  }, { prisma });

  const prepaid = await runBillingSerializableTransaction(prisma, async (tx) => {
    await lockDispatchId(tx, input.dispatchId);
    await assertActiveRuntimeKey(tx, key.id);
    await assertActiveSubject(tx, input, actor.tv);
    await assertLiveJobComputeDispatch(tx, { claim: actor.job_compute,
      identity: input.jobCompute ?? null, runtimeKeyId: key.id,
      subjectId: input.userId, orgId: input.organisationId,
      teamId: input.teamId, tokenVersion: actor.tv, now });
    await assertLedgerBudgetContext(tx, { product: input.product,
      sourceDomain: actor.source_domain, context: input.billingContext ?? null,
      jobGrantId: input.jobCompute?.grantId ?? null,
      originInvocationId: input.jobCompute?.originInvocationId ?? null });
    const cancelled = await tx.billingLedgerDispatchDecision.findUnique({
      where: { dispatchId: input.dispatchId }, select: { status: true },
    });
    if (cancelled) throw new AppError('BAD_REQUEST', 409, 'PREPAID_DISPATCH_CONFLICT');
    const existing = await tx.billingPrepaidReservation.findUnique({
      where: { dispatchId: input.dispatchId },
    });
    if (existing) {
      if (existing.appKeyId !== key.id || existing.serviceId !== key.serviceId ||
        existing.requestFingerprint !== input.requestFingerprint ||
        existing.providerServiceId !== input.providerServiceId ||
        existing.creditAccountId !== creditAccount.id ||
        existing.orgId !== input.organisationId || existing.teamId !== input.teamId ||
        existing.userId !== input.userId || existing.currency !== input.currency ||
        existing.billingMonth !== billingMonth ||
        existing.dispatchStartedAt.getTime() !== dispatchStartedAt.getTime() ||
        !existing.rawCostBound.eq(bound) || existing.status !== 'ACTIVE') {
        throw new AppError('BAD_REQUEST', 409, 'PREPAID_DISPATCH_CONFLICT');
      }
      return { payment_mode: 'prepaid' as const,
        reservation_id: existing.id, dispatch_id: existing.dispatchId,
        request_fingerprint: existing.requestFingerprint,
        reserved_microcredits: existing.reservedMicrocredits.toString(),
        billing_month: existing.billingMonth, currency: existing.currency };
    }
    const tariff = (await resolveBillingTariffForMonth(tx, {
      serviceId: key.serviceId, organisationId: input.organisationId,
      teamId: input.teamId, billingMonth,
    })).tariff;
    if (tariff.usagePaymentMode !== BillingUsagePaymentMode.PREPAID ||
      tariff.mode === BillingTariffMode.FREE ||
      tariff.currency !== input.currency) {
      throw new AppError('FORBIDDEN', 403, 'PREPAID_TARIFF_REQUIRED');
    }
    const reserved = ratedMicrocredits(bound, tariff.markupBps);
    await reserveBudgetDispatch(tx, { dispatchId: input.dispatchId, startedAt: dispatchStartedAt,
      product: input.product, serviceId: key.serviceId,
      providerServiceId: input.providerServiceId,
      orgId: input.organisationId, teamId: input.teamId, userId: input.userId,
      billingMonth, currency: input.currency, tariffId: tariff.id,
      tariffMode: tariff.mode, markupBps: tariff.markupBps,
      paymentMode: 'PREPAID', rawCostBound: bound,
      context: input.billingContext ?? null });
    const balance = await lockCreditBalance(tx, creditAccount.id);
    const held = await tx.billingPrepaidReservation.aggregate({
      where: { creditAccountId: creditAccount.id, status: BillingPrepaidReservationStatus.ACTIVE },
      _sum: { reservedMicrocredits: true },
    });
    if (balance - (held._sum.reservedMicrocredits ?? 0n) < reserved) {
      throw new AppError('FORBIDDEN', 402, 'PREPAID_CREDIT_EXHAUSTED');
    }
    const reservation = await tx.billingPrepaidReservation.create({
      data: { dispatchId: input.dispatchId,
        requestFingerprint: input.requestFingerprint, creditAccountId: creditAccount.id,
        tariffId: tariff.id, serviceId: key.serviceId, providerServiceId: input.providerServiceId,
        appKeyId: key.id, orgId: input.organisationId, teamId: input.teamId,
        userId: input.userId, billingMonth, dispatchStartedAt, currency: input.currency,
        rawCostBound: bound, reservedMicrocredits: reserved,
        events: { create: { kind: 'RESERVED', amountMicrocredits: reserved } } },
    });
    return { payment_mode: 'prepaid' as const, reservation_id: reservation.id, dispatch_id: reservation.dispatchId,
      request_fingerprint: reservation.requestFingerprint,
      reserved_microcredits: reserved.toString(), billing_month: billingMonth,
      currency: reservation.currency };
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
  return withBudgetContextDigest(prisma, prepaid);
}

export async function getLedgerDispatchDecision(
  params: { runtimeSecret: string; dispatchId: string },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const key = await verifyLedgerRuntimeKey(params.runtimeSecret, { prisma });
  validId(params.dispatchId);
  const reservation = await prisma.billingPrepaidReservation.findUnique({
    where: { dispatchId: params.dispatchId },
    include: { runtimeKey: { select: { ledgerAudience: true, sourceDomain: true } } },
  });
  if (reservation) {
    if (reservation.serviceId !== key.serviceId ||
      reservation.runtimeKey.ledgerAudience !== key.ledgerAudience ||
      reservation.runtimeKey.sourceDomain !== key.sourceDomain) {
      throw new AppError('NOT_FOUND', 404, 'LEDGER_DISPATCH_DECISION_NOT_FOUND');
    }
    return withBudgetContextDigest(prisma, { payment_mode: 'prepaid', reservation_id: reservation.id,
      dispatch_id: reservation.dispatchId,
      request_fingerprint: reservation.requestFingerprint, status: reservation.status,
      receipt_id: reservation.receiptId,
      reserved_microcredits: reservation.reservedMicrocredits.toString(),
      debited_microcredits: reservation.debitedMicrocredits?.toString() ?? null,
      billing_month: reservation.billingMonth, currency: reservation.currency });
  }
  const decision = await prisma.billingLedgerDispatchDecision.findUnique({
    where: { dispatchId: params.dispatchId },
    include: { runtimeKey: { select: { ledgerAudience: true, sourceDomain: true } } },
  });
  if (!decision || decision.serviceId !== key.serviceId ||
    decision.runtimeKey.ledgerAudience !== key.ledgerAudience ||
    decision.runtimeKey.sourceDomain !== key.sourceDomain) {
    throw new AppError('NOT_FOUND', 404, 'LEDGER_DISPATCH_DECISION_NOT_FOUND');
  }
  return withBudgetContextDigest(prisma, {
    payment_mode: decision.status === 'PAY_AS_YOU_GO' ? 'pay_as_you_go' : 'cancelled',
    reservation_id: null, dispatch_id: decision.dispatchId,
    request_fingerprint: decision.requestFingerprint,
    status: decision.status === 'PAY_AS_YOU_GO' && decision.receiptId ? 'SETTLED' : decision.status,
    receipt_id: decision.receiptId,
    billing_month: decision.billingMonth, currency: decision.currency });
}

export async function finalizePrepaidDispatch(params: {
  runtimeSecret: string; dispatchId: string; receiptId: string;
  kind: 'settle' | 'release'; rawCostActual?: string; currency?: string;
}, deps?: { prisma?: PrismaClient }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const key = await verifyLedgerRuntimeKey(params.runtimeSecret, { prisma });
  validId(params.dispatchId);
  validId(params.receiptId);
  const actual = params.kind === 'settle' && params.rawCostActual !== undefined
    ? rawCost(params.rawCostActual) : null;
  if (params.kind === 'settle' && (!actual || params.currency !== 'USD')) {
    throw new AppError('BAD_REQUEST', 400, 'PREPAID_RECEIPT_INVALID');
  }
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockDispatchId(tx, params.dispatchId);
    const reservation = await tx.billingPrepaidReservation.findUnique({
      where: { dispatchId: params.dispatchId },
      include: { tariff: { select: { markupBps: true, mode: true } },
        runtimeKey: { select: { serviceId: true, ledgerAudience: true, sourceDomain: true } } },
    });
    if (!reservation && params.kind === 'settle') {
      const prior = await tx.billingLedgerDispatchDecision.findUnique({
        where: { dispatchId: params.dispatchId },
      });
      if (!prior || prior.status !== 'PAY_AS_YOU_GO' || prior.serviceId !== key.serviceId
        || prior.runtimeKeyId !== key.id || !actual) {
        throw new AppError('NOT_FOUND', 404, 'PAID_DISPATCH_NOT_FOUND');
      }
      if (prior.receiptId && prior.receiptId !== params.receiptId) {
        throw new AppError('BAD_REQUEST', 409, 'PAID_RECEIPT_CONFLICT');
      }
      if (prior.rawCostBound && actual.greaterThan(prior.rawCostBound)) {
        throw new AppError('BAD_REQUEST', 409, 'PAID_RECEIPT_EXCEEDS_BOUND');
      }
      if (!prior.orgId) throw new AppError('BAD_REQUEST', 409, 'PAID_DISPATCH_EVIDENCE_MISSING');
      await lockBudgetOrganisation(tx, prior.orgId);
      if (!await tx.billingCreditBudgetDispatch.findUnique({
        where: { dispatchId: params.dispatchId }, select: { dispatchId: true },
      })) {
        // A pre-cutover PAYG dispatch has no frozen per-receipt UOA rating.
        // It enters the explicit historical reconciliation queue; applying
        // today's tariff would rewrite an earlier customer's liability.
        throw new AppError('BAD_REQUEST', 409, 'LEGACY_PAYG_RECONCILIATION_REQUIRED');
      }
      const liability = await recordPaidUsageLiability(tx, {
        dispatchId: params.dispatchId, receiptId: params.receiptId, actual,
      });
      if (!prior.receiptId) await tx.billingLedgerDispatchDecision.update({
        where: { dispatchId: params.dispatchId }, data: { receiptId: params.receiptId },
      });
      return { dispatch_id: params.dispatchId, receipt_id: params.receiptId,
        status: 'SETTLED', debited_microcredits: '0',
        rated_microcredits: liability.ratedMicrocredits.toString() };
    }
    if (!reservation && params.kind === 'release') {
      const prior = await tx.billingLedgerDispatchDecision.findUnique({
        where: { dispatchId: params.dispatchId },
      });
      if (prior?.status === 'PAY_AS_YOU_GO' && prior.serviceId === key.serviceId &&
        prior.runtimeKeyId === key.id) {
        if (prior.receiptId) throw new AppError('BAD_REQUEST', 409, 'PAID_RECEIPT_CONFLICT');
        await releaseBudgetDispatch(tx, params.dispatchId);
        await tx.billingLedgerDispatchDecision.update({ where: { dispatchId: params.dispatchId },
          data: { status: 'CANCELLED', receiptId: params.receiptId } });
        return { dispatch_id: params.dispatchId, receipt_id: params.receiptId,
          status: 'RELEASED', debited_microcredits: '0' };
      }
      if (prior && (prior.status !== 'CANCELLED' || prior.receiptId !== params.receiptId ||
        prior.serviceId !== key.serviceId || prior.runtimeKeyId !== key.id)) {
        throw new AppError('BAD_REQUEST', 409, 'PREPAID_RECEIPT_CONFLICT');
      }
      if (!prior) await tx.billingLedgerDispatchDecision.create({ data: {
        dispatchId: params.dispatchId, runtimeKeyId: key.id, serviceId: key.serviceId,
        status: 'CANCELLED', receiptId: params.receiptId,
      } });
      return { dispatch_id: params.dispatchId, receipt_id: params.receiptId,
        status: 'RELEASED', debited_microcredits: '0' };
    }
    if (!reservation || reservation.serviceId !== key.serviceId ||
      reservation.runtimeKey.ledgerAudience !== key.ledgerAudience ||
      reservation.runtimeKey.sourceDomain !== key.sourceDomain) {
      throw new AppError('NOT_FOUND', 404, 'PREPAID_RESERVATION_NOT_FOUND');
    }
    if (reservation.status !== BillingPrepaidReservationStatus.ACTIVE) {
      if (reservation.receiptId !== params.receiptId ||
        reservation.status !== (params.kind === 'settle' ? 'SETTLED' : 'RELEASED') ||
        (actual !== null && !reservation.rawCostActual?.eq(actual))) {
        throw new AppError('BAD_REQUEST', 409, 'PREPAID_RECEIPT_CONFLICT');
      }
      return { dispatch_id: reservation.dispatchId, receipt_id: params.receiptId,
        status: reservation.status,
        debited_microcredits: (reservation.debitedMicrocredits ?? 0n).toString() };
    }
    await lockBudgetOrganisation(tx, reservation.orgId);
    const balance = await lockCreditBalance(tx, reservation.creditAccountId);
    if (actual !== null && actual.greaterThan(reservation.rawCostBound)) {
      throw new AppError('BAD_REQUEST', 409, 'PREPAID_RECEIPT_EXCEEDS_BOUND');
    }
    let budgetDispatch = await tx.billingCreditBudgetDispatch.findUnique({
      where: { dispatchId: params.dispatchId },
    });
    if (!budgetDispatch) {
      await attachLegacyBudgetDispatch(tx, { dispatchId: reservation.dispatchId,
        startedAt: reservation.dispatchStartedAt, product: key.service.identifier,
        serviceId: reservation.serviceId, providerServiceId: reservation.providerServiceId,
        orgId: reservation.orgId, teamId: reservation.teamId, userId: reservation.userId,
        billingMonth: reservation.billingMonth, currency: reservation.currency,
        tariffId: reservation.tariffId, tariffMode: reservation.tariff.mode,
        markupBps: reservation.tariff.markupBps, paymentMode: 'PREPAID',
        reservedMicrocredits: reservation.reservedMicrocredits });
      budgetDispatch = await tx.billingCreditBudgetDispatch.findUnique({
        where: { dispatchId: params.dispatchId },
      });
    }
    let debited: bigint | null = null;
    let legacyQuanta: bigint | null = null;
    let legacyTarget: bigint | null = null;
    if (actual !== null && budgetDispatch?.isLegacy) {
      const bucket = await tx.billingPrepaidRatingBucket.findUnique({
        where: { creditAccountId: reservation.creditAccountId },
      });
      if (bucket && bucket.currency !== reservation.currency) {
        throw new AppError('BAD_REQUEST', 409, 'PREPAID_CURRENCY_UNSUPPORTED');
      }
      const oldQuanta = bucket ? BigInt(bucket.cumulativeRatedQuanta.toFixed(0)) : 0n;
      legacyQuanta = reservation.tariff.mode === BillingTariffMode.FREE
        ? oldQuanta : oldQuanta + scaledRaw(actual) * BigInt(10_000 + reservation.tariff.markupBps);
      legacyTarget = ratedMicrocreditsFromQuanta(legacyQuanta);
      debited = legacyTarget - (bucket?.debitedMicrocredits ?? 0n);
      if (debited > reservation.reservedMicrocredits) {
        throw new AppError('BAD_REQUEST', 409, 'PREPAID_RECEIPT_EXCEEDS_BOUND');
      }
      await recordLegacyPrepaidLiability(tx, { dispatchId: params.dispatchId,
        receiptId: params.receiptId, reservationId: reservation.id,
        ratedMicrocredits: debited, occurredAt: reservation.dispatchStartedAt });
    } else if (actual !== null) {
      const liability = await recordPaidUsageLiability(tx, {
        dispatchId: params.dispatchId, receiptId: params.receiptId, actual,
        creditAccountId: reservation.creditAccountId,
      });
      debited = liability.ratedMicrocredits;
      if (debited > reservation.reservedMicrocredits) {
        throw new AppError('BAD_REQUEST', 409, 'PREPAID_RECEIPT_EXCEEDS_BOUND');
      }
    } else await releaseBudgetDispatch(tx, params.dispatchId);
    const status = actual === null
      ? BillingPrepaidReservationStatus.RELEASED : BillingPrepaidReservationStatus.SETTLED;
    await tx.billingPrepaidReservation.update({
      where: { id: reservation.id },
      data: { status, receiptId: params.receiptId, terminalAt: new Date(),
        rawCostActual: actual, debitedMicrocredits: debited },
    });
    if (legacyQuanta !== null && legacyTarget !== null) {
      await tx.billingPrepaidRatingBucket.upsert({
        where: { creditAccountId: reservation.creditAccountId },
        create: { creditAccountId: reservation.creditAccountId, currency: reservation.currency,
          cumulativeRatedQuanta: legacyQuanta.toString(), debitedMicrocredits: legacyTarget },
        update: { cumulativeRatedQuanta: legacyQuanta.toString(), debitedMicrocredits: legacyTarget },
      });
    }
    if (debited !== null && debited > 0n) {
      await tx.billingCreditEntry.create({
        data: { creditAccountId: reservation.creditAccountId, serviceId: reservation.serviceId,
          ledgerRuntimeKeyId: reservation.appKeyId,
          prepaidReservationId: reservation.id,
          attributedUserId: reservation.userId, direction: BillingCreditEntryDirection.DEBIT,
          kind: BillingCreditEntryKind.PREPAID_USAGE, amountMicrocredits: debited,
          balanceAfterMicrocredits: balance - debited, currency: reservation.currency,
          idempotencyKey: `prepaid:${reservation.dispatchId}`,
          sourceType: 'prepaid_provider_receipt', sourceId: reservation.id,
          occurredAt: new Date() },
      });
    }
    await tx.billingPrepaidReservationEvent.create({
      data: { reservationId: reservation.id, kind: status, receiptId: params.receiptId,
        amountMicrocredits: debited },
    });
    return { dispatch_id: reservation.dispatchId, receipt_id: params.receiptId, status,
      debited_microcredits: (debited ?? 0n).toString() };
  }, 'BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED');
}
