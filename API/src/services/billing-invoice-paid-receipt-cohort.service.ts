import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { fetchLedgerHistoricalBillingTeams } from './billing-ledger-team-discovery.service.js';
import { fetchVerifiedLedgerPaidReceiptSet, matchUoaPaidReceiptSet,
  type LedgerPaidReceiptSet, type PaidReceiptScope } from
  './billing-ledger-paid-receipt-proof.service.js';

export type ManualPaidCohort = Array<{ scope: PaidReceiptScope;
  proof: LedgerPaidReceiptSet }>;

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

export async function collectManualInvoicePaidCohort(params: {
  serviceId: string; product: string; orgId: string; billingMonth: string;
}, deps?: { discoverTeams?: typeof fetchLedgerHistoricalBillingTeams;
  fetchPaidReceiptSet?: typeof fetchVerifiedLedgerPaidReceiptSet }):
Promise<ManualPaidCohort> {
  const teams = await (deps?.discoverTeams ?? fetchLedgerHistoricalBillingTeams)({
    product: params.product, organisationId: params.orgId,
    billingMonth: params.billingMonth,
  });
  if (new Set(teams.teamIds).size !== teams.teamIds.length) {
    hold('BILLING_INVOICE_RECEIPT_TEAM_COHORT_INVALID');
  }
  const scopes = [...teams.teamIds]
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map((teamId) => ({ serviceId: params.serviceId,
    product: params.product, organisationId: params.orgId,
      teamId, billingMonth: params.billingMonth }));
  const proofs = await Promise.all(scopes.map((scope) =>
    (deps?.fetchPaidReceiptSet ?? fetchVerifiedLedgerPaidReceiptSet)(scope)));
  return scopes.map((scope, index) => ({ scope,
    proof: proofs[index] ?? hold('BILLING_INVOICE_RECEIPT_PROOF_MISSING') }));
}

/** Rechecks the signed cohort against immutable UOA receipts inside the draft
 * transaction, then freezes exactly which dispatches the invoice charges. */
export async function writeManualInvoicePaidCohort(
  tx: Prisma.TransactionClient,
  invoice: { id: string; orgId: string; billingMonth: string; currency: string },
  service: { id: string; product: string; usageMinor: bigint; proofs: ManualPaidCohort;
    excludeDispatchIds?: ReadonlySet<string> },
): Promise<void> {
  if (service.usageMinor === 0n) return;
  if (invoice.currency !== 'USD' || service.proofs.length === 0 ||
    service.proofs.some((row) => row.scope.serviceId !== service.id ||
      row.scope.product !== service.product || row.scope.organisationId !== invoice.orgId ||
      row.scope.billingMonth !== invoice.billingMonth)) {
    hold('BILLING_INVOICE_RECEIPT_PROOF_SCOPE_INVALID');
  }
  const rows: Array<{ dispatchId: string; receiptId: string; teamId: string;
    ratedMicrocredits: bigint; proofSha256: string }> = [];
  for (const { scope, proof } of service.proofs) {
    const matched = await matchUoaPaidReceiptSet(tx, scope, proof);
    if (matched.legacyMicrocredits !== 0n ||
      matched.forwardReceipts.some((row) => row.paymentMode !== 'PAY_AS_YOU_GO')) {
      hold('BILLING_INVOICE_RECEIPT_PAYMENT_MODE_INVALID');
    }
    rows.push(...matched.forwardReceipts.filter((row) =>
      !service.excludeDispatchIds?.has(row.dispatchId)).map((row) => ({
      dispatchId: row.dispatchId, receiptId: row.receiptId,
      teamId: scope.teamId, ratedMicrocredits: row.ratedMicrocredits,
      proofSha256: proof.paid_receipt_sha256,
    })));
  }
  const rated = rows.reduce((sum, row) => sum + row.ratedMicrocredits, 0n);
  // One USD cent is ten million UOA microcredits. Customer currency rounds
  // once over the complete issuer line, never once per dispatch or team.
  if (rows.length === 0 || (rated + 5_000_000n) / 10_000_000n !== service.usageMinor ||
    new Set(rows.map((row) => row.dispatchId)).size !== rows.length) {
    hold('BILLING_INVOICE_RECEIPT_AMOUNT_MISMATCH');
  }
  const existing = await tx.billingInvoicePaidReceipt.findMany({ where: {
    invoiceId: invoice.id, serviceId: service.id,
  } });
  if (existing.length > 0) {
    const prior = new Map(existing.map((row) => [row.dispatchId, row]));
    if (prior.size !== rows.length || rows.some((row) => {
      const frozen = prior.get(row.dispatchId);
      return !frozen || frozen.receiptId !== row.receiptId ||
        frozen.teamId !== row.teamId ||
        frozen.ratedMicrocredits !== row.ratedMicrocredits ||
        frozen.proofSha256 !== row.proofSha256;
    })) hold('BILLING_INVOICE_RECEIPT_COHORT_CHANGED');
    return;
  }
  await tx.billingInvoicePaidReceipt.createMany({ data: rows.map((row) => ({
    id: randomUUID(), invoiceId: invoice.id, serviceId: service.id,
    orgId: invoice.orgId, teamId: row.teamId, billingMonth: invoice.billingMonth,
    dispatchId: row.dispatchId, receiptId: row.receiptId,
    ratedMicrocredits: row.ratedMicrocredits, proofSha256: row.proofSha256,
  })) });
}
