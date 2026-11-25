import { assignmentCutoffs } from './billing-tariff-history.service.js';
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
import { assertPaidFinancialSources } from './billing-financial-source-binding.service.js';

type Reader = PrismaClient | Prisma.TransactionClient;

export type VerifiedCycleCreditEvidence = {
  team_id: string;
  source: 'verified_paid_receipts';
  covered: true;
  consumed_microcredits: string;
  funded_debit_microcredits: string | null;
  mixed_usage?: { prepaid: string; payg: string; paygWaived: string };
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
  scope: BillingAssignmentScope;accountId?:string }, scope: PaidReceiptScope,
  payer: BillingAssignmentScope,accountId?:string): boolean {
  return account.orgId === scope.organisationId && account.scope === payer &&
    account.teamId === (payer === BillingAssignmentScope.TEAM ? scope.teamId : null) &&
    (accountId===undefined||account.accountId===accountId);
}

/** Gross customer credit usage is the immutable UOA receipt delta, never a
 * monthly rerating. Funded wallet debit and operator waiver are independent. */
export async function readVerifiedCycleCreditEvidence(reader: Reader,
  params: { scope: PaidReceiptScope; proof: LedgerPaidReceiptSet;
    payer: BillingAssignmentScope; tariff: BillingTariff; rawLines: RawMeteringLine[];accountId?:string;allowUnsettled?:boolean;
    organisationSettlementCurrency?:'USD' },
): Promise<VerifiedCycleCreditEvidence> {
  const { scope, proof, tariff } = params;
  if (proof.scope.billing_product !== scope.product ||
    proof.scope.organization_id !== scope.organisationId ||
    proof.scope.team_id !== scope.teamId ||
    proof.scope.billing_month !== scope.billingMonth ||
    proof.unresolved_paid_attempts !== '0' || !proof.snapshot.immutable) {
    hold('BILLING_CYCLE_PAID_PROOF_SCOPE_INVALID');
  }
  // Retained organisation receipts already freeze their USD credit liability separately.
  const orgUsd=params.organisationSettlementCurrency==='USD'&&params.payer===BillingAssignmentScope.ORGANISATION&&Boolean(params.accountId);
  if (tariff.usageCurrency !== 'USD'&&!orgUsd) hold('BILLING_CYCLE_FX_RECONCILIATION_REQUIRED');
  if(params.accountId)await assertPaidFinancialSources(reader,scope,params.accountId);
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
        paymentMode: true, creditAccountId: true, ratedMicrocredits: true,currency:true } }),
    reader.billingCreditBudgetLegacyLiability.findMany({ where,
      select: { dispatchId: true, sourceId: true } }),
  ]);
  const exceptions = await reader.billingPaidUsageException.findMany({ where: {
    dispatchId: { in: forward.map((row) => row.dispatchId) },
  }, select: { dispatchId: true, receiptId: true, status: true,
    grossRatedMicrocredits: true, collectibleMicrocredits: true,
    waivedMicrocredits: true } });
  const byException = new Map(exceptions.map((row) => [row.dispatchId, row]));
  if (forward.some(row => row.currency !== 'USD')) hold('BILLING_CYCLE_PAID_LIABILITY_TERMS_CONFLICT');
  const mixed = forward.some(row => row.tariffId !== tariff.id);
  if (mixed) {
    const cutoffs = await assignmentCutoffs(reader, { ...scope });
    if (!cutoffs.length) hold('BILLING_CYCLE_PAID_LIABILITY_TERMS_CONFLICT');
    const holds = await reader.billingCreditBudgetDispatch.findMany({
      where: { ...where, dispatchId: { in: forward.map(row => row.dispatchId) } },
      select: { dispatchId: true, tariffId: true, paymentMode: true },
    });
    const frozen = new Map(holds.map(row => [row.dispatchId, row]));
    if (forward.some(row => frozen.get(row.dispatchId)?.tariffId !== row.tariffId ||
      frozen.get(row.dispatchId)?.paymentMode !== row.paymentMode)) hold('BILLING_CYCLE_PAID_LIABILITY_TERMS_CONFLICT');
  }
  let waived = 0n;
  let prepaidWaived = 0n;
  const prepaid = forward.filter(row => row.paymentMode === BillingUsagePaymentMode.PREPAID);
  const prepaidGross = prepaid.reduce((sum, row) => sum + row.ratedMicrocredits, matched.legacyMicrocredits);
  const paygGross = matched.ratedMicrocredits - prepaidGross;
  for (const row of forward) {
    if ((!mixed && row.paymentMode !== tariff.usagePaymentMode) ||
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
    if (row.paymentMode === BillingUsagePaymentMode.PREPAID) prepaidWaived += exception.waivedMicrocredits;
  }

  const sourceIds: string[] = [];
  let fundedDebit: bigint | null = null;
  if (tariff.usagePaymentMode === BillingUsagePaymentMode.PREPAID || prepaid.length || (mixed && legacy.length)) {
    const reservations = await reader.billingPrepaidReservation.findMany({ where,
      include: { creditAccount: { select: { orgId: true, teamId: true, scope: true,accountId:true } },
        creditEntry: { select: { id: true, direction: true, kind: true,
          amountMicrocredits: true } } } });
    const byDispatch = new Map(reservations.map((row) => [row.dispatchId, row]));
    const expected = [...prepaid.map((row) => row.dispatchId),
      ...legacy.map((row) => row.dispatchId)];
    if (reservations.length !== expected.length) hold('BILLING_CYCLE_PREPAID_COVERAGE_MISMATCH');
    fundedDebit = 0n;
    for (const dispatchId of expected) {
      const row = byDispatch.get(dispatchId);
      if (!row || row.status !== BillingPrepaidReservationStatus.SETTLED ||
        row.rawCostActual === null || row.debitedMicrocredits === null ||
        row.debitedMicrocredits < 0n || row.tariffId !== (prepaid.find(item => item.dispatchId === dispatchId)?.tariffId ?? tariff.id) ||
        !correctPayer(row.creditAccount, scope, params.payer,params.accountId) ||
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
    if (fundedDebit !== prepaidGross - prepaidWaived) {
      hold('BILLING_CYCLE_PREPAID_DEBIT_UNPROVEN');
    }
  } else if (legacy.length !== 0) {
    hold('BILLING_CYCLE_LEGACY_PAYMENT_MODE_CONFLICT');
  }
  if (tariff.usagePaymentMode !== BillingUsagePaymentMode.PREPAID || (mixed && forward.length > prepaid.length)) {
    const prepaidDebit = fundedDebit ?? 0n;
    const settlements = await reader.billingCreditUsageSettlement.findMany({ where: {
      serviceId: scope.serviceId, teamId: scope.teamId,
      billingMonth: scope.billingMonth,
      creditAccount: { orgId: scope.organisationId },
    }, include: { creditAccount: { select: { orgId: true, teamId: true, scope: true,accountId:true } },
      adjustments: { orderBy: { sequence: 'desc' }, take: 1,
        select: { id: true, cumulativeCreditsConsumedMicrocredits: true } } } });
    if (settlements.length > 1) hold('BILLING_CYCLE_PAYG_SETTLEMENT_CONFLICT');
    const row = settlements[0];
    if (row) {
      const adjustment = row.adjustments[0];
      if (!correctPayer(row.creditAccount, scope, params.payer,params.accountId) ||
        (row.tariffId !== tariff.id && !forward.some(liability =>
          liability.paymentMode === BillingUsagePaymentMode.PAY_AS_YOU_GO && liability.tariffId === row.tariffId)) ||
        row.currency !== 'USD' ||
        row.cumulativeCreditsConsumedMicrocredits < 0n ||
        row.cumulativeCreditsConsumedMicrocredits > paygGross - (waived - prepaidWaived) ||
        row.status !== 'APPLIED' ||
        adjustment?.cumulativeCreditsConsumedMicrocredits !==
          row.cumulativeCreditsConsumedMicrocredits) {
        hold('BILLING_CYCLE_PAYG_SETTLEMENT_UNPROVEN');
      }
      if (!adjustment) hold('BILLING_CYCLE_PAYG_SETTLEMENT_UNPROVEN');
      fundedDebit = prepaidDebit + row.cumulativeCreditsConsumedMicrocredits;
      // A zero-delta portfolio observation can append a new adjustment ID
      // without changing a customer's financial facts or cycle identity.
      sourceIds.push(row.id);
    } else fundedDebit = paygGross === 0n || params.allowUnsettled ? prepaidDebit : null;
  }

  sourceIds.sort(compareBillingCycleUtf8);
  // A remaining cash liability under a non-USD tariff still needs captured FX
  // collection evidence. Only fully funded USD credit consumption can bypass
  // the cycle's single-currency representation restriction.
  if(orgUsd&&tariff.currency!=='USD'&&(fundedDebit===null||fundedDebit<matched.ratedMicrocredits-waived))
    hold('BILLING_CYCLE_FX_RECONCILIATION_REQUIRED');
  const facts = { scope, paid_receipt_count: proof.paid_receipt_count,
    paid_receipt_sha256: proof.paid_receipt_sha256,
    rated_microcredits: matched.ratedMicrocredits.toString(),
    waived_microcredits: waived.toString(),
    funded_debit_microcredits: fundedDebit?.toString() ?? null, source_ids: sourceIds };
  return { team_id: scope.teamId, source: 'verified_paid_receipts', covered: true,
    ...(mixed ? { mixed_usage: { prepaid: prepaidGross.toString(), payg: paygGross.toString(),
      paygWaived: (waived - prepaidWaived).toString() } } : {}),
    consumed_microcredits: matched.ratedMicrocredits.toString(),
    funded_debit_microcredits: fundedDebit?.toString() ?? null,
    waived_microcredits: waived.toString(), source_ids: sourceIds,
    receipt_count: matched.receiptCount, paid_receipt_sha256: proof.paid_receipt_sha256,
    fingerprint: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
}
