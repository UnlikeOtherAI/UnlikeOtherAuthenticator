import { type Prisma, type PrismaClient } from '@prisma/client';

import type { BillingCycleDetailV2 } from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import { readVerifiedCycleCreditEvidence,
  type VerifiedCycleCreditEvidence } from './billing-cycle-paid-credit-evidence.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { monthlyFinancialQuoteEvidence } from './billing-cycle-quote-projection.service.js';
import { quoteSubscriptionMonthlyCharge } from './billing-monthly-subscription-quote.service.js';
import { readCycleWalletBoundary } from './billing-cycle-wallet-boundary.service.js';
import type { CycleUsageEvidence } from './billing-cycle-usage-projection.service.js';
import type { LedgerPaidReceiptSet } from './billing-ledger-paid-receipt-proof.service.js';

type Cycle = Prisma.BillingCustomerCycleGetPayload<object>;
export type FinancialCycleEvidence = Record<string, unknown> & {
  quote: { source: { kind: 'stripe' | 'manual'; id: string }; tariff_id: string;
    currency: string; amount_minor: string };
  credit_evidence: VerifiedCycleCreditEvidence[];
  ledger_snapshots: CycleUsageEvidence[];
  paid_receipt_proofs: LedgerPaidReceiptSet[];
};

export function financialCycleEvidence(cycle: Cycle): FinancialCycleEvidence {
  const evidence = cycle.privateEvidence as unknown as FinancialCycleEvidence;
  const detail = cycle.publicSnapshot as unknown as BillingCycleDetailV2;
  if (billingCycleSnapshotDigest(cycle.publicSnapshot, cycle.privateEvidence) !==
    cycle.snapshotSha256 || detail.cycle_id !== cycle.id ||
    detail.period.month !== cycle.billingMonth || detail.product.id !== cycle.serviceId ||
    detail.scope.organisation_id !== cycle.orgId || detail.scope.team_id !== cycle.teamId ||
    !evidence.quote || !Array.isArray(evidence.credit_evidence) ||
    !Array.isArray(evidence.ledger_snapshots) || !Array.isArray(evidence.paid_receipt_proofs) ||
    evidence.credit_evidence.length !== evidence.ledger_snapshots.length ||
    evidence.credit_evidence.length !== evidence.paid_receipt_proofs.length ||
    evidence.credit_evidence.some((row) => !row.covered)) {
    throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_FINANCIAL_PROOF_INVALID');
  }
  return evidence;
}

/** Recheck the same financial authority under the seat/wallet organisation lock. */
export async function verifyFinancialCycleProof(tx: Prisma.TransactionClient, cycle: Cycle) {
  const evidence = financialCycleEvidence(cycle);
  const detail = cycle.publicSnapshot as unknown as BillingCycleDetailV2;
  const startsAt = new Date(detail.period.starts_at);
  const endsAt = new Date(detail.period.ends_at);
  const quote = await quoteSubscriptionMonthlyCharge({ source: evidence.quote.source,
    billingMonth: cycle.billingMonth }, { prisma: tx as unknown as PrismaClient });
  if (billingCycleSnapshotDigest(monthlyFinancialQuoteEvidence(quote, startsAt, endsAt), {}) !==
    evidence.quote_fingerprint) {
    throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_QUOTE_CHANGED');
  }
  const tariff = await tx.billingTariff.findUniqueOrThrow({
    where: { id: evidence.quote.tariff_id } });
  for (let index = 0; index < evidence.credit_evidence.length; index += 1) {
    const captured = evidence.credit_evidence[index];
    const snapshot = evidence.ledger_snapshots[index];
    const proof = evidence.paid_receipt_proofs[index];
    if (!captured || !snapshot || !proof || captured.team_id !== snapshot.team_id ||
      proof.scope.team_id !== snapshot.team_id) {
      throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_RECEIPT_SCOPE_INVALID');
    }
    const fresh = await readVerifiedCycleCreditEvidence(tx, {
      scope: { product: detail.product.identifier, organisationId: cycle.orgId,
        teamId: snapshot.team_id, billingMonth: cycle.billingMonth, serviceId: cycle.serviceId },
      proof, payer: cycle.payerScope, tariff, rawLines: snapshot.raw_lines,
    });
    if (fresh.fingerprint !== captured.fingerprint) {
      throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_CREDIT_SOURCE_CHANGED');
    }
  }
  const wallet = await readCycleWalletBoundary(tx, { orgId: cycle.orgId, teamId: cycle.teamId,
    payer: cycle.payerScope, startsAt, endsAt });
  if (wallet.fingerprint !== (evidence.wallet_boundary as { fingerprint?: string })?.fingerprint) {
    throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_WALLET_BOUNDARY_CHANGED');
  }
}
