import { BillingAssignmentScope, Prisma, type PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';

export function billingMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Monthly Ledger aggregates cannot be assigned across a mid-month payer switch. */
export async function assertUnambiguousCreditPayer(
  prisma: PrismaClient | Prisma.TransactionClient,
  params: { orgId: string; scope: BillingAssignmentScope; billingMonth: string },
): Promise<void> {
  const responsibility = await prisma.billingOrgResponsibility.findUnique({
    where: { orgId: params.orgId },
    select: {
      createdAt: true,
      transitions: { select: { kind: true, effectiveAt: true, source: true },
        orderBy: [{ effectiveAt: 'asc' }, { id: 'asc' }] },
    },
  });
  const transitions = responsibility?.transitions ?? [];
  if (responsibility && transitions.length === 0) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_PAYER_HISTORY_MISSING');
  }
  if (transitions.some((row, index) => index > 0 && (
    row.effectiveAt.getTime() === transitions[index - 1]?.effectiveAt.getTime() ||
    row.kind === transitions[index - 1]?.kind
  ))) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_PAYER_HISTORY_MISSING');
  }
  if (transitions.some((row) => billingMonthKey(row.effectiveAt) === params.billingMonth)) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_PAYER_TRANSITION_RECONCILIATION_REQUIRED');
  }
  const prior = transitions.filter((row) => billingMonthKey(row.effectiveAt) < params.billingMonth).at(-1);
  const first = transitions[0];
  const createdMonth = responsibility ? billingMonthKey(responsibility.createdAt) : null;
  if (responsibility && first && createdMonth &&
      params.billingMonth >= createdMonth &&
      params.billingMonth < billingMonthKey(first.effectiveAt)) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_PAYER_PREHISTORY_UNCERTAIN');
  }
  if (responsibility && first?.source === 'legacy_backfill' && createdMonth &&
      first.effectiveAt < responsibility.createdAt && params.billingMonth <= createdMonth && prior) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_PAYER_PREHISTORY_UNCERTAIN');
  }
  const orgPays = prior?.kind === 'ASSUMED';
  if (orgPays !== (params.scope === BillingAssignmentScope.ORGANISATION)) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_HISTORICAL_PAYER_MISMATCH');
  }
}
