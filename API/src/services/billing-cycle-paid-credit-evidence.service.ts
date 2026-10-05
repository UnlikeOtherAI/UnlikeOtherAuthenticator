import { createHash } from 'node:crypto';

import {
  BillingAssignmentScope, BillingCreditEntryDirection, BillingCreditEntryKind,
  BillingPrepaidReservationStatus, BillingUsagePaymentMode, Prisma,
  type BillingTariff, type PrismaClient,
} from '@prisma/client';

import { AppError } from '../utils/errors.js';
import type { RawMeteringLine } from './billing-metering.types.js';
import {
  matchUoaPaidReceiptSet, type LedgerPaidReceiptSet, type PaidReceiptScope,
} from './billing-ledger-paid-receipt-proof.service.js';
import { compareBillingCycleUtf8 } from './billing-cycle-binary-order.service.js';

type Reader = PrismaClient | Prisma.TransactionClient;

export type VerifiedCycleCreditEvidence = {
  team_id: string;
  source: 'verified_paid_receipts';
  covered: true;
  consumed_microcredits: string;
  funded_debit_microcredits: string | null;
  waived_microcredits: string;
  source_ids: string[];
  receipt_count: number;
  paid_receipt_sha256: string;
  fingerprint: string;
};

/** Existing commercial exchange is 1 USD = 1,000,000,000 microcredits. */
export function usdFromRatedMicrocredits(microcredits: bigint): string {
  if (microcredits < 0n) hold('BILLING_CYCLE_CREDIT_SOURCE_CONFLICT');
  const digits = microcredits.toString().padStart(10, '0');
  const whole = digits.slice(0, -9);
  const fraction = digits.slice(-9).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

function correctPayer(account: { orgId: string; teamId: string | null;
  scope: BillingAssignmentScope }, scope: PaidReceiptScope,
  payer: BillingAssignmentScope): boolean {
  return account.orgId === scope.organisationId && account.scope === payer &&
    account.teamId === (payer === BillingAssignmentScope.TEAM ? scope.teamId : null);
}

/** Gross customer credit usage is the immutable UOA receipt delta, never a
 * monthly rerating. Funded wallet debit and operator waiver are independent. */
export async function readVerifiedCycleCreditEvidence(reader: Reader,
  params: { scope: PaidReceiptScope; proof: LedgerPaidReceiptSet;
    payer: BillingAssignmentScope; tariff: BillingTariff; rawLines: RawMeteringLine[] },
): Promise<VerifiedCycleCreditEvidence> {
  const { scope, proof, tariff } = params;
  if (proof.scope.billing_product !== scope.product ||
    proof.scope.organization_id !== scope.organisationId ||
    proof.scope.team_id !== scope.teamId ||
    proof.scope.billing_month !== scope.billingMonth ||
    proof.unresolved_paid_attempts !== '0' || !proof.snapshot.immutable) {
    hold('BILLING_CYCLE_PAID_PROOF_SCOPE_INVALID');
  }
  if (tariff.currency !== 'USD') hold('BILLING_CYCLE_FX_RECONCILIATION_REQUIRED');
  const matched = await matchUoaPaidReceiptSet(reader, scope, proof);
  const meteredRaw = params.rawLines.filter((line) => line.billingDisposition === 'paid')
    .reduce((sum, line) => {
      if (line.selectedProviderCost === null || line.currency !== 'USD') {
        hold('BILLING_CYCLE_PAID_COST_MISSING');
      }
      return sum.add(new Prisma.Decimal(line.selectedProviderCost));
    }, new Prisma.Decimal(0));
  if (meteredRaw.toFixed(18) !== matched.rawCostTotal) {
    hold('BILLING_CYCLE_METERING_RECEIPT_COST_MISMATCH');
  }
  const where = { serviceId: scope.serviceId, orgId: scope.organisationId,
    teamId: scope.teamId, billingMonth: scope.billingMonth };
  const [forward, legacy] = await Promise.all([
    reader.billingPaidUsageLiability.findMany({ where,
      select: { dispatchId: true, receiptId: true, tariffId: true,
        paymentMode: true, creditAccountId: true, ratedMicrocredits: true } }),
    reader.billingCreditBudgetLegacyLiability.findMany({ where,
      select: { dispatchId: true, sourceId: true } }),
  ]);
  const exceptions = await reader.billingPaidUsageException.findMany({ where: {
    dispatchId: { in: forward.map((row) => row.dispatchId) },
  }, select: { dispatchId: true, receiptId: true, status: true,
    grossRatedMicrocredits: true, collectibleMicrocredits: true,
    waivedMicrocredits: true } });
  const byException = new Map(exceptions.map((row) => [row.dispatchId, row]));
  let waived = 0n;
  for (const row of forward) {
    if (row.tariffId !== tariff.id || row.paymentMode !== tariff.usagePaymentMode ||
      row.ratedMicrocredits < 0n ||
      (row.paymentMode === BillingUsagePaymentMode.PREPAID) !==
        (row.creditAccountId !== null)) hold('BILLING_CYCLE_PAID_LIABILITY_TERMS_CONFLICT');
    const exception = byException.get(row.dispatchId);
    if (!exception) continue;
    if (exception.status !== 'WRITTEN_OFF' || exception.receiptId !== row.receiptId ||
      exception.grossRatedMicrocredits !== row.ratedMicrocredits ||
      exception.collectibleMicrocredits === null || exception.waivedMicrocredits === null ||
      exception.collectibleMicrocredits < 0n || exception.waivedMicrocredits < 0n ||
      exception.collectibleMicrocredits + exception.waivedMicrocredits !==
        row.ratedMicrocredits) hold('BILLING_CYCLE_PAID_WAIVER_UNRESOLVED');
    waived += exception.waivedMicrocredits;
  }

  const sourceIds: string[] = [];
  let fundedDebit: bigint | null = null;
  if (tariff.usagePaymentMode === BillingUsagePaymentMode.PREPAID) {
    const reservations = await reader.billingPrepaidReservation.findMany({ where,
      include: { creditAccount: { select: { orgId: true, teamId: true, scope: true } },
        creditEntry: { select: { id: true, direction: true, kind: true,
          amountMicrocredits: true } } } });
    const byDispatch = new Map(reservations.map((row) => [row.dispatchId, row]));
    const expected = [...forward.map((row) => row.dispatchId),
      ...legacy.map((row) => row.dispatchId)];
    if (reservations.length !== expected.length) hold('BILLING_CYCLE_PREPAID_COVERAGE_MISMATCH');
    fundedDebit = 0n;
    for (const dispatchId of expected) {
      const row = byDispatch.get(dispatchId);
      if (!row || row.status !== BillingPrepaidReservationStatus.SETTLED ||
        row.rawCostActual === null || row.debitedMicrocredits === null ||
        row.debitedMicrocredits < 0n || row.tariffId !== tariff.id ||
        !correctPayer(row.creditAccount, scope, params.payer) ||
        (row.debitedMicrocredits > 0n && (!row.creditEntry ||
          row.creditEntry.direction !== BillingCreditEntryDirection.DEBIT ||
          row.creditEntry.kind !== BillingCreditEntryKind.PREPAID_USAGE ||
          row.creditEntry.amountMicrocredits !== row.debitedMicrocredits)) ||
        (row.debitedMicrocredits === 0n && row.creditEntry)) {
        hold('BILLING_CYCLE_PREPAID_DEBIT_UNPROVEN');
      }
      const liability = forward.find((item) => item.dispatchId === dispatchId);
      const exception = byException.get(dispatchId);
      const expectedDebit = liability ?
        exception?.collectibleMicrocredits ?? liability.ratedMicrocredits :
        matched.legacyMicrocredits;
      if (liability && row.debitedMicrocredits !== expectedDebit) {
        hold('BILLING_CYCLE_PREPAID_DEBIT_UNPROVEN');
      }
      fundedDebit += row.debitedMicrocredits;
      sourceIds.push(row.id);
    }
    if (fundedDebit !== matched.ratedMicrocredits - waived) {
      hold('BILLING_CYCLE_PREPAID_DEBIT_UNPROVEN');
    }
  } else if (legacy.length !== 0) {
    hold('BILLING_CYCLE_LEGACY_PAYMENT_MODE_CONFLICT');
  } else {
    const settlements = await reader.billingCreditUsageSettlement.findMany({ where: {
      serviceId: scope.serviceId, teamId: scope.teamId,
      billingMonth: scope.billingMonth,
      creditAccount: { orgId: scope.organisationId },
    }, include: { creditAccount: { select: { orgId: true, teamId: true, scope: true } },
      adjustments: { orderBy: { sequence: 'desc' }, take: 1,
        select: { id: true, cumulativeCreditsConsumedMicrocredits: true } } } });
    if (settlements.length > 1) hold('BILLING_CYCLE_PAYG_SETTLEMENT_CONFLICT');
    const row = settlements[0];
    if (row) {
      const adjustment = row.adjustments[0];
      if (!correctPayer(row.creditAccount, scope, params.payer) ||
        row.tariffId !== tariff.id || row.currency !== 'USD' ||
        row.cumulativeCreditsConsumedMicrocredits < 0n ||
        row.cumulativeCreditsConsumedMicrocredits > matched.ratedMicrocredits - waived ||
        row.status !== 'APPLIED' ||
        adjustment?.cumulativeCreditsConsumedMicrocredits !==
          row.cumulativeCreditsConsumedMicrocredits) {
        hold('BILLING_CYCLE_PAYG_SETTLEMENT_UNPROVEN');
      }
      if (!adjustment) hold('BILLING_CYCLE_PAYG_SETTLEMENT_UNPROVEN');
      fundedDebit = row.cumulativeCreditsConsumedMicrocredits;
      // A zero-delta portfolio observation can append a new adjustment ID
      // without changing a customer's financial facts or cycle identity.
      sourceIds.push(row.id);
    } else if (matched.ratedMicrocredits === 0n) fundedDebit = 0n;
  }

  sourceIds.sort(compareBillingCycleUtf8);
  const facts = { scope, paid_receipt_count: proof.paid_receipt_count,
    paid_receipt_sha256: proof.paid_receipt_sha256,
    rated_microcredits: matched.ratedMicrocredits.toString(),
    waived_microcredits: waived.toString(),
    funded_debit_microcredits: fundedDebit?.toString() ?? null, source_ids: sourceIds };
  return { team_id: scope.teamId, source: 'verified_paid_receipts', covered: true,
    consumed_microcredits: matched.ratedMicrocredits.toString(),
    funded_debit_microcredits: fundedDebit?.toString() ?? null,
    waived_microcredits: waived.toString(), source_ids: sourceIds,
    receipt_count: matched.receiptCount, paid_receipt_sha256: proof.paid_receipt_sha256,
    fingerprint: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
}
