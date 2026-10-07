import type { Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { lockBudgetOrganisation, releaseBudgetDispatch } from
  './billing-credit-budget-dispatch.service.js';
import { recordPaidUsageLiability } from './billing-paid-liability.service.js';

/** The caller holds the dispatch mutation lock for this transaction. Admission
 * stays immutable; terminal receipts and the budget hold commit together. */
export async function finalizeUnreservedLedgerDispatch(tx: Prisma.TransactionClient,
  key: { id: string; serviceId: string }, params: {
    dispatchId: string; receiptId: string; kind: 'settle' | 'release';
  }, actual: Prisma.Decimal | null) {
  const prior = await tx.billingLedgerDispatchDecision.findUnique({
    where: { dispatchId: params.dispatchId }, include: { release: true },
  });
  const matchesKey = prior?.serviceId === key.serviceId && prior.runtimeKeyId === key.id;
  if (params.kind === 'settle') {
    if (!prior || prior.status !== 'PAY_AS_YOU_GO' || !matchesKey || !actual) {
      throw new AppError('NOT_FOUND', 404, 'PAID_DISPATCH_NOT_FOUND');
    }
    if (prior.release) throw new AppError('BAD_REQUEST', 409, 'PAID_RECEIPT_CONFLICT');
    if (prior.rawCostBound && actual.greaterThan(prior.rawCostBound)) {
      throw new AppError('BAD_REQUEST', 409, 'PAID_RECEIPT_EXCEEDS_BOUND');
    }
    if (!prior.orgId) throw new AppError('BAD_REQUEST', 409, 'PAID_DISPATCH_EVIDENCE_MISSING');
    await lockBudgetOrganisation(tx, prior.orgId);
    if (!await tx.billingCreditBudgetDispatch.findUnique({
      where: { dispatchId: params.dispatchId }, select: { dispatchId: true },
    })) {
      // Never rate pre-cutover usage with today's tariff.
      throw new AppError('BAD_REQUEST', 409, 'LEGACY_PAYG_RECONCILIATION_REQUIRED');
    }
    const liability = await recordPaidUsageLiability(tx, {
      dispatchId: params.dispatchId, receiptId: params.receiptId, actual,
    });
    return { dispatch_id: params.dispatchId, receipt_id: params.receiptId,
      status: 'SETTLED', debited_microcredits: '0',
      rated_microcredits: liability.ratedMicrocredits.toString() };
  }
  if (prior?.status === 'PAY_AS_YOU_GO' && matchesKey) {
    const liability = await tx.billingPaidUsageLiability.findUnique({
      where: { dispatchId: params.dispatchId }, select: { receiptId: true },
    });
    if (liability || (prior.release && prior.release.receiptId !== params.receiptId)) {
      throw new AppError('BAD_REQUEST', 409, 'PAID_RECEIPT_CONFLICT');
    }
    if (!prior.release) {
      await releaseBudgetDispatch(tx, params.dispatchId);
      await tx.billingLedgerDispatchRelease.create({ data: {
        dispatchId: params.dispatchId, receiptId: params.receiptId,
      } });
    }
  } else {
    if (prior && (prior.status !== 'CANCELLED' || prior.receiptId !== params.receiptId || !matchesKey)) {
      throw new AppError('BAD_REQUEST', 409, 'PREPAID_RECEIPT_CONFLICT');
    }
    if (!prior) await tx.billingLedgerDispatchDecision.create({ data: {
      dispatchId: params.dispatchId, runtimeKeyId: key.id, serviceId: key.serviceId,
      status: 'CANCELLED', receiptId: params.receiptId,
    } });
  }
  return { dispatch_id: params.dispatchId, receipt_id: params.receiptId,
    status: 'RELEASED', debited_microcredits: '0' };
}
