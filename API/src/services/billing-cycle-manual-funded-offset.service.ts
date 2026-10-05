import { BillingAssignmentScope, BillingCreditUsageSettlementStatus,
  BillingInvoiceStatus, type Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { allocateInvoiceCreditReferenceMinor } from
  './billing-invoice-line-credit-allocation.service.js';

type CapturedCredits = Array<{ source_ids?: string[];
  funded_debit_microcredits?: string | null }>;

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

/** The original issued invoice is the only authority for prior applied cents;
 * the latest UOA settlement is the authority for the new cumulative debit. */
export async function verifiedManualFundedOffset(
  tx: Prisma.TransactionClient,
  params: { orgId: string; teamId: string | null; serviceId: string;
    month: string; contractId: string; payer: BillingAssignmentScope;
    creditEvidence: CapturedCredits; originalInvoiceId: string },
): Promise<{ creditMinor: bigint; currentMicrocredits: bigint;
  references: Array<{ id: string; settlementId: string; adjustmentId: string;
    serviceId: string; creditsAppliedMicrocredits: bigint;
    priorCreditsAppliedMicrocredits: bigint }> }> {
  const expectedIds = params.creditEvidence.flatMap((row) => row.source_ids ?? []);
  if (new Set(expectedIds).size !== expectedIds.length ||
    params.creditEvidence.some((row) => row.funded_debit_microcredits === null ||
      row.funded_debit_microcredits === undefined)) {
    hold('BILLING_CYCLE_MANUAL_FUNDED_SOURCE_UNPROVEN');
  }
  const expectedTotal = params.creditEvidence.reduce((sum, row) =>
    sum + BigInt(row.funded_debit_microcredits ?? '0'), 0n);
  const prior = await tx.billingInvoiceCreditSettlementReference.findMany({ where: {
    serviceId: params.serviceId,
    invoice: { contractId: params.contractId, billingMonth: params.month,
      status: BillingInvoiceStatus.ISSUED },
  }, include: { invoice: { select: { id: true, orgId: true } } } });
  if (prior.some((row) => row.invoice.orgId !== params.orgId ||
    !expectedIds.includes(row.settlementId))) {
    hold('BILLING_CYCLE_MANUAL_FUNDED_HISTORY_CONFLICT');
  }
  const originalOtherProduct = await tx.billingInvoiceCreditSettlementReference.findFirst({
    where: { invoiceId: params.originalInvoiceId,
      serviceId: { not: params.serviceId } }, select: { id: true },
  });
  if (originalOtherProduct) hold('BILLING_CYCLE_MANUAL_FUNDED_MIXED_CARRY_UNPROVEN');
  const settlements = await tx.billingCreditUsageSettlement.findMany({ where: {
    id: { in: expectedIds }, serviceId: params.serviceId, billingMonth: params.month,
    teamId: params.teamId === null ? undefined : params.teamId,
  }, include: { creditAccount: { select: { orgId: true, teamId: true,
    scope: true } }, adjustments: { orderBy: { sequence: 'desc' }, take: 1 } } });
  if (settlements.length !== expectedIds.length) {
    hold('BILLING_CYCLE_MANUAL_FUNDED_SETTLEMENT_MISSING');
  }
  const references = settlements.map((settlement) => {
    const latest = settlement.adjustments[0];
    if (!latest || settlement.status !== BillingCreditUsageSettlementStatus.APPLIED ||
      settlement.currency !== 'USD' || settlement.creditAccount.orgId !== params.orgId ||
      settlement.creditAccount.scope !== params.payer ||
      settlement.creditAccount.teamId !== (params.payer === BillingAssignmentScope.TEAM ?
        params.teamId : null) ||
      latest.cumulativeCreditsConsumedMicrocredits !==
        settlement.cumulativeCreditsConsumedMicrocredits) {
      hold('BILLING_CYCLE_MANUAL_FUNDED_SETTLEMENT_CHANGED');
    }
    const previous = prior.filter((row) => row.settlementId === settlement.id)
      .reduce((max, row) => row.creditsAppliedMicrocredits > max ?
        row.creditsAppliedMicrocredits : max, 0n);
    if (previous > settlement.cumulativeCreditsConsumedMicrocredits) {
      hold('BILLING_CYCLE_MANUAL_FUNDED_DEBIT_DECLINED');
    }
    return { id: randomUUID(),
      settlementId: settlement.id, adjustmentId: latest.id,
      serviceId: params.serviceId,
      creditsAppliedMicrocredits: settlement.cumulativeCreditsConsumedMicrocredits,
      priorCreditsAppliedMicrocredits: previous };
  });
  const currentMicrocredits = references.reduce((sum, row) =>
    sum + row.creditsAppliedMicrocredits, 0n);
  if (currentMicrocredits !== expectedTotal) {
    hold('BILLING_CYCLE_MANUAL_FUNDED_TOTAL_CHANGED');
  }
  const creditMinor = allocateInvoiceCreditReferenceMinor(references)
    .reduce((sum, row) => sum + row.amountMinor, 0n);
  return { creditMinor, currentMicrocredits, references };
}
import { randomUUID } from 'node:crypto';
