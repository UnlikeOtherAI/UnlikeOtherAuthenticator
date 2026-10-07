import { createHash } from 'node:crypto';
import {
  BillingCreditEntryDirection, BillingCreditEntryKind, BillingPrepaidReservationStatus,
  Prisma, type PrismaClient,
} from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { lockCreditBalance } from './billing-credit-balance-lock.service.js';
import { lockBudgetOrganisation } from './billing-credit-budget-dispatch.service.js';
import { verifyLedgerRuntimeKey } from './billing-ledger-runtime-key.service.js';
import { recordPaidUsageLiability } from './billing-paid-liability.service.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const RAW = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
const DIGEST = /^[a-f0-9]{64}$/;

function rawActual(value: string): Prisma.Decimal {
  if (!RAW.test(value)) throw new AppError('BAD_REQUEST', 400, 'PAID_EXCEPTION_COST_INVALID');
  const actual = new Prisma.Decimal(value);
  if (!actual.isFinite() || actual.isNegative()) {
    throw new AppError('BAD_REQUEST', 400, 'PAID_EXCEPTION_COST_INVALID');
  }
  return actual;
}

export function paidExceptionEvidenceDigest(input: {
  dispatchId: string; receiptId: string; actual: Prisma.Decimal; currency: string;
  requestFingerprint: string; rawCostBound: Prisma.Decimal; contextDigest: string;
}) {
  return createHash('sha256').update(JSON.stringify([
    input.dispatchId, input.receiptId, input.actual.toFixed(18), input.currency,
    input.requestFingerprint, input.rawCostBound.toFixed(18), input.contextDigest,
  ])).digest('hex');
}

async function lockDispatch(tx: Prisma.TransactionClient, dispatchId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT pg_catalog.pg_advisory_xact_lock(
    481602, pg_catalog.hashtext(${dispatchId}))::text`);
}

async function lockRuntimeKey(tx: Prisma.TransactionClient, keyId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT id FROM billing_ledger_runtime_keys
    WHERE id = ${keyId} AND revoked_at IS NULL FOR SHARE`);
  if (rows.length !== 1) throw new AppError('UNAUTHORIZED', 401, 'INVALID_LEDGER_RUNTIME_KEY');
}

function serialize(row: {
  dispatchId: string; receiptId: string; status: string; evidenceDigest: string;
  grossRatedMicrocredits: bigint | null; collectibleMicrocredits: bigint | null;
  waivedMicrocredits: bigint | null;
}) {
  return { dispatch_id: row.dispatchId, receipt_id: row.receiptId,
    status: row.status === 'HELD' ? 'HELD_OPERATOR_RECONCILIATION' : 'WRITTEN_OFF',
    evidence_digest: row.evidenceDigest,
    gross_rated_microcredits: row.grossRatedMicrocredits?.toString() ?? null,
    collectible_microcredits: row.collectibleMicrocredits?.toString() ?? null,
    waived_microcredits: row.waivedMicrocredits?.toString() ?? null };
}

export async function registerPaidUsageException(params: {
  runtimeSecret: string; dispatchId: string; receiptId: string;
  rawCostActual: string; currency: string; evidenceDigest: string;
}, deps?: { prisma?: PrismaClient }) {
  if (!ID.test(params.dispatchId) || !ID.test(params.receiptId)
    || !DIGEST.test(params.evidenceDigest) || params.currency !== 'USD') {
    throw new AppError('BAD_REQUEST', 400, 'PAID_EXCEPTION_EVIDENCE_INVALID');
  }
  const actual = rawActual(params.rawCostActual);
  const prisma = deps?.prisma ?? getAdminPrisma();
  const key = await verifyLedgerRuntimeKey(params.runtimeSecret, { prisma });
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockDispatch(tx, params.dispatchId);
    await lockRuntimeKey(tx, key.id);
    const prior = await tx.billingPaidUsageException.findUnique({
      where: { dispatchId: params.dispatchId },
    });
    if (prior) {
      if (prior.receiptId !== params.receiptId
        || prior.evidenceDigest !== params.evidenceDigest
        || !prior.rawCostActual.eq(actual) || prior.runtimeKeyId !== key.id) {
        throw new AppError('BAD_REQUEST', 409, 'PAID_EXCEPTION_EVIDENCE_CONFLICT');
      }
      return serialize(prior);
    }
    const hold = await tx.billingCreditBudgetDispatch.findUnique({
      where: { dispatchId: params.dispatchId },
    });
    const reservation = await tx.billingPrepaidReservation.findUnique({
      where: { dispatchId: params.dispatchId },
    });
    const decision = reservation ? null : await tx.billingLedgerDispatchDecision.findUnique({
      where: { dispatchId: params.dispatchId },
    });
    const bound = reservation?.rawCostBound ?? decision?.rawCostBound;
    const fingerprint = reservation?.requestFingerprint ?? decision?.requestFingerprint;
    if (!hold || hold.isLegacy || hold.reservedMicrocredits === null
      || hold.serviceId !== key.serviceId || hold.status !== 'ACTIVE'
      || (reservation && (reservation.appKeyId !== key.id
        || reservation.status !== BillingPrepaidReservationStatus.ACTIVE
        || hold.paymentMode !== 'PREPAID'))
      || (decision && (decision.runtimeKeyId !== key.id || decision.status !== 'PAY_AS_YOU_GO'
        || hold.paymentMode !== 'PAY_AS_YOU_GO'))
      || (!reservation && !decision) || !bound || !fingerprint
      || hold.currency !== params.currency || !actual.greaterThan(bound)) {
      throw new AppError('BAD_REQUEST', 409, 'PAID_EXCEPTION_NOT_ELIGIBLE');
    }
    const digest = paidExceptionEvidenceDigest({ dispatchId: params.dispatchId,
      receiptId: params.receiptId, actual, currency: params.currency,
      requestFingerprint: fingerprint, rawCostBound: bound,
      contextDigest: hold.contextDigest });
    if (digest !== params.evidenceDigest) {
      throw new AppError('BAD_REQUEST', 409, 'PAID_EXCEPTION_EVIDENCE_MISMATCH');
    }
    const created = await tx.billingPaidUsageException.create({ data: {
      dispatchId: params.dispatchId, receiptId: params.receiptId,
      runtimeKeyId: key.id, evidenceDigest: digest, rawCostActual: actual,
      currency: params.currency,
    } });
    return serialize(created);
  }, 'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED');
}

export async function getPaidUsageException(params: {
  runtimeSecret: string; dispatchId: string;
}, deps?: { prisma?: PrismaClient }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const key = await verifyLedgerRuntimeKey(params.runtimeSecret, { prisma });
  const row = await prisma.billingPaidUsageException.findUnique({
    where: { dispatchId: params.dispatchId },
  });
  if (!row || row.runtimeKeyId !== key.id) {
    throw new AppError('NOT_FOUND', 404, 'PAID_EXCEPTION_NOT_FOUND');
  }
  return serialize(row);
}

export async function listPaidUsageExceptions(deps?: { prisma?: PrismaClient }) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const rows = await prisma.billingPaidUsageException.findMany({
    where: { status: 'HELD' }, orderBy: [{ createdAt: 'asc' }, { dispatchId: 'asc' }],
    take: 101, include: { runtimeKey: { include: { service: {
      select: { identifier: true },
    } } } },
  });
  const visible = rows.slice(0, 100);
  const dispatchIds = visible.map((row) => row.dispatchId);
  const [holds, reservations, decisions] = await Promise.all([
    prisma.billingCreditBudgetDispatch.findMany({ where: {
      dispatchId: { in: dispatchIds },
    } }),
    prisma.billingPrepaidReservation.findMany({ where: {
      dispatchId: { in: dispatchIds },
    } }),
    prisma.billingLedgerDispatchDecision.findMany({ where: {
      dispatchId: { in: dispatchIds },
    } }),
  ]);
  const holdById = new Map(holds.map((row) => [row.dispatchId, row]));
  const reservationById = new Map(reservations.map((row) => [row.dispatchId, row]));
  const decisionById = new Map(decisions.map((row) => [row.dispatchId, row]));
  return { exceptions: visible.map((row) => ({ ...serialize(row),
    product: row.runtimeKey.service.identifier,
    raw_cost_actual: row.rawCostActual.toFixed(18), currency: row.currency,
    raw_cost_bound: (reservationById.get(row.dispatchId)?.rawCostBound
      ?? decisionById.get(row.dispatchId)?.rawCostBound)?.toFixed(18) ?? null,
    max_collectible_microcredits:
      holdById.get(row.dispatchId)?.reservedMicrocredits?.toString() ?? null,
    created_at: row.createdAt.toISOString() })), has_more: rows.length > 100 };
}

export async function writeOffPaidUsageException(params: {
  dispatchId: string; evidenceDigest: string; idempotencyKey: string;
  reason: string; actorUserId: string; actorTokenVersion: number; adminDomain: string;
}, deps?: { prisma?: PrismaClient }) {
  if (!ID.test(params.dispatchId) || !DIGEST.test(params.evidenceDigest)
    || !DIGEST.test(params.idempotencyKey) || params.reason.trim().length < 12
    || params.reason.length > 500) {
    throw new AppError('BAD_REQUEST', 400, 'PAID_EXCEPTION_DECISION_INVALID');
  }
  const prisma = deps?.prisma ?? getAdminPrisma();
  return runBillingSerializableTransaction(prisma, async (tx) => {
    await lockDispatch(tx, params.dispatchId);
    const exception = await tx.billingPaidUsageException.findUnique({
      where: { dispatchId: params.dispatchId },
    });
    if (!exception || exception.evidenceDigest !== params.evidenceDigest) {
      throw new AppError('BAD_REQUEST', 409, 'PAID_EXCEPTION_EVIDENCE_CONFLICT');
    }
    if (exception.status === 'WRITTEN_OFF') {
      if (exception.idempotencyKey !== params.idempotencyKey) {
        throw new AppError('BAD_REQUEST', 409, 'PAID_EXCEPTION_DECISION_CONFLICT');
      }
      return serialize(exception);
    }
    const userRows = await tx.$queryRaw<{ tokenVersion: number; lifecycleStatus: string }[]>(
      Prisma.sql`SELECT token_version AS "tokenVersion", lifecycle_status AS "lifecycleStatus"
        FROM users WHERE id = ${params.actorUserId} FOR SHARE`);
    const roleRows = await tx.$queryRaw<{ role: string }[]>(Prisma.sql`
      SELECT role FROM domain_roles WHERE domain = ${params.adminDomain}
      AND user_id = ${params.actorUserId} FOR SHARE`);
    if (userRows[0]?.tokenVersion !== params.actorTokenVersion
      || userRows[0]?.lifecycleStatus !== 'ACTIVE' || roleRows[0]?.role !== 'SUPERUSER') {
      throw new AppError('FORBIDDEN', 403, 'PAID_EXCEPTION_OPERATOR_REVOKED');
    }
    const hold = await tx.billingCreditBudgetDispatch.findUnique({
      where: { dispatchId: params.dispatchId },
    });
    if (!hold || hold.status !== 'ACTIVE' || hold.isLegacy
      || hold.reservedMicrocredits === null) {
      throw new AppError('BAD_REQUEST', 409, 'PAID_EXCEPTION_NOT_ELIGIBLE');
    }
    await lockBudgetOrganisation(tx, hold.orgId);
    const reservation = await tx.billingPrepaidReservation.findUnique({
      where: { dispatchId: params.dispatchId },
    });
    const decision = reservation ? null : await tx.billingLedgerDispatchDecision.findUnique({
      where: { dispatchId: params.dispatchId },
    });
    if ((reservation && (reservation.status !== BillingPrepaidReservationStatus.ACTIVE
      || reservation.appKeyId !== exception.runtimeKeyId))
      || (decision && (decision.status !== 'PAY_AS_YOU_GO'
        || decision.runtimeKeyId !== exception.runtimeKeyId))
      || (!reservation && !decision)) {
      throw new AppError('BAD_REQUEST', 409, 'PAID_EXCEPTION_NOT_ELIGIBLE');
    }
    const balance = reservation ? await lockCreditBalance(tx, reservation.creditAccountId) : null;
    const liability = await recordPaidUsageLiability(tx, {
      dispatchId: params.dispatchId, receiptId: exception.receiptId,
      actual: exception.rawCostActual,
      ...(reservation ? { creditAccountId: reservation.creditAccountId } : {}),
      operatorWaiver: true,
    });
    const gross = liability.ratedMicrocredits;
    const collectible = gross < hold.reservedMicrocredits ? gross : hold.reservedMicrocredits;
    const waived = gross - collectible;
    if (reservation) {
      await tx.billingPrepaidReservation.update({ where: { id: reservation.id }, data: {
        status: BillingPrepaidReservationStatus.SETTLED, receiptId: exception.receiptId,
        rawCostActual: exception.rawCostActual, debitedMicrocredits: collectible,
        terminalAt: new Date(),
      } });
      if (collectible > 0n && balance !== null) {
        await tx.billingCreditEntry.create({ data: {
          creditAccountId: reservation.creditAccountId, serviceId: reservation.serviceId,
          ledgerRuntimeKeyId: reservation.appKeyId,
          prepaidReservationId: reservation.id, attributedUserId: reservation.userId,
          direction: BillingCreditEntryDirection.DEBIT,
          kind: BillingCreditEntryKind.PREPAID_USAGE,
          amountMicrocredits: collectible,
          balanceAfterMicrocredits: balance - collectible,
          currency: reservation.currency,
          idempotencyKey: `prepaid:${reservation.dispatchId}`,
          sourceType: 'prepaid_provider_receipt', sourceId: reservation.id,
          occurredAt: new Date(),
        } });
      }
      await tx.billingPrepaidReservationEvent.create({ data: {
        reservationId: reservation.id, kind: 'SETTLED',
        receiptId: exception.receiptId, amountMicrocredits: collectible,
      } });
    }
    const written = await tx.billingPaidUsageException.update({
      where: { dispatchId: params.dispatchId }, data: {
        status: 'WRITTEN_OFF', grossRatedMicrocredits: gross,
        collectibleMicrocredits: collectible, waivedMicrocredits: waived,
        operatorUserId: params.actorUserId, operatorReason: params.reason.trim(),
        idempotencyKey: params.idempotencyKey, terminalAt: new Date(),
      },
    });
    await tx.adminAuditLog.create({ data: {
      actorEmail: params.actorUserId, action: 'billing.paid_usage_exception_written_off',
      metadata: { dispatch_id: params.dispatchId, receipt_id: exception.receiptId,
        evidence_digest: exception.evidenceDigest,
        gross_microcredits: gross.toString(), collectible_microcredits: collectible.toString(),
        waived_microcredits: waived.toString(), reason: params.reason.trim() },
    } });
    return serialize(written);
  }, 'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED');
}
