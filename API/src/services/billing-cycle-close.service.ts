import { randomUUID } from 'node:crypto';

import { BillingAssignmentScope, Prisma, type PrismaClient } from '@prisma/client';

import type { BillingCycleDetailV2, BillingCycleUsageLine } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { exactMoney } from './billing-money.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import {
  decimalCredits,
} from './billing-cycle-credit-evidence.service.js';
import {
  readVerifiedCycleCreditEvidence, usdFromRatedMicrocredits,
  type VerifiedCycleCreditEvidence,
} from './billing-cycle-paid-credit-evidence.service.js';
import {
  monthlyFinancialQuoteEvidence, privateMonthlyQuoteEvidence,
  projectMonthlySubscriptionLine,
} from './billing-cycle-quote-projection.service.js';
import {
  aggregateOrganisationCycleUsage, cycleUsageContentFingerprint, projectCycleUsage,
  type CycleUsageEvidence,
} from './billing-cycle-usage-projection.service.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import {
  fetchVerifiedLedgerPaidReceiptSet, type LedgerPaidReceiptSet,
} from './billing-ledger-paid-receipt-proof.service.js';
import { fetchLedgerHistoricalBillingTeams } from './billing-ledger-team-discovery.service.js';
import { readCycleWalletBoundary } from './billing-cycle-wallet-boundary.service.js';
import {
  quoteSubscriptionMonthlyCharge, type MonthlyChargeSource,
} from './billing-monthly-subscription-quote.service.js';

type MonthlyQuote = Awaited<ReturnType<typeof quoteSubscriptionMonthlyCharge>>;

export type PreparedBillingCycleClose = {
  cycleId: string;
  amountMinor: bigint;
  currency: string;
  snapshotSha256: string;
};

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

function monthPeriod(month: string) {
  const startsAt = new Date(`${month}-01T00:00:00.000Z`);
  const endsAt = new Date(Date.UTC(startsAt.getUTCFullYear(), startsAt.getUTCMonth() + 1, 1));
  return { startsAt, endsAt };
}

function quoteFingerprint(quote: MonthlyQuote, startsAt: Date, endsAt: Date): string {
  return billingCycleSnapshotDigest(monthlyFinancialQuoteEvidence(quote, startsAt, endsAt), {});
}

/**
 * Freezes a closed month's contractual subscription liability and complete
 * Ledger coverage. It is a pending customer cycle until an actual payment
 * authority supplies invoice-line allocation and verified document bytes.
 */
export async function prepareBillingCycleClose(
  params: { source: MonthlyChargeSource; billingMonth: string },
  deps?: { prisma?: PrismaClient; now?: () => Date;
    quote?: typeof quoteSubscriptionMonthlyCharge;
    fetchMetering?: typeof fetchLedgerMeteringUsage;
    fetchPaidReceiptSet?: typeof fetchVerifiedLedgerPaidReceiptSet;
    discoverTeams?: typeof fetchLedgerHistoricalBillingTeams },
): Promise<PreparedBillingCycleClose> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const quoteFn = deps?.quote ?? quoteSubscriptionMonthlyCharge;
  const initial = await quoteFn(params, { prisma, now: deps?.now });
  const { startsAt, endsAt } = monthPeriod(params.billingMonth);
  if (endsAt > (deps?.now?.() ?? new Date())) hold('BILLING_MONTH_NOT_CLOSED');
  if (initial.billingMonth !== params.billingMonth || initial.amountMinor < 0n ||
    (initial.teamId === null && initial.scope !== BillingAssignmentScope.ORGANISATION) ||
    (initial.teamId !== null && initial.scope !== BillingAssignmentScope.TEAM)) {
    hold('BILLING_CYCLE_SOURCE_SCOPE_INVALID');
  }
  const [service, tariff] = await Promise.all([
    prisma.billingService.findUnique({ where: { id: initial.serviceId },
      select: { id: true, identifier: true, name: true } }),
    prisma.billingTariff.findUnique({ where: { id: initial.tariffId } }),
  ]);
  if (!service || !tariff || tariff.serviceId !== service.id ||
    tariff.currency !== initial.currency) hold('BILLING_CYCLE_SOURCE_TERMS_INVALID');
  const discovery = initial.teamId === null ?
    await (deps?.discoverTeams ?? fetchLedgerHistoricalBillingTeams)({
      product: service.identifier, organisationId: initial.organisationId,
      billingMonth: params.billingMonth,
    }) : null;
  const teams = initial.teamId ? [initial.teamId] : discovery?.teamIds ?? [];

  const ledgerSnapshots: CycleUsageEvidence[] = [];
  const creditEvidence: VerifiedCycleCreditEvidence[] = [];
  const proofs = new Map<string, LedgerPaidReceiptSet>();
  let usageLines: BillingCycleUsageLine[] = [];
  const organisationUsageLines: BillingCycleUsageLine[] = [];
  for (const teamId of teams) {
    const usage = await (deps?.fetchMetering ?? fetchLedgerMeteringUsage)({
      product: service.identifier, organisationId: initial.organisationId,
      teamId, billingMonth: params.billingMonth, groupBy: 'user',
    });
    const projected = projectCycleUsage(usage, {
      serviceIdentifier: service.identifier, organisationId: initial.organisationId,
      teamId, billingMonth: params.billingMonth, startsAt, endsAt,
      currency: initial.currency,
    }, tariff);
    ledgerSnapshots.push(projected.evidence);
    const scope = { product: service.identifier, organisationId: initial.organisationId,
      teamId, billingMonth: params.billingMonth, serviceId: service.id };
    const proof = await (deps?.fetchPaidReceiptSet ?? fetchVerifiedLedgerPaidReceiptSet)(scope);
    proofs.set(teamId, proof);
    const teamCreditEvidence = await readVerifiedCycleCreditEvidence(prisma, {
      scope, proof, payer: initial.scope, tariff,
      rawLines: projected.evidence.raw_lines,
    });
    const collectible = BigInt(teamCreditEvidence.consumed_microcredits) -
      BigInt(teamCreditEvidence.waived_microcredits);
    const line = projected.lines.map((item) => ({ ...item,
      customer_charge: item.usage_payment_mode === 'prepaid' ? null :
        exactMoney(usdFromRatedMicrocredits(collectible), initial.currency) }));
    creditEvidence.push(teamCreditEvidence);
    if (initial.teamId !== null) usageLines = line;
    else organisationUsageLines.push(...line.map((item) => ({ ...item,
      credits_consumed: teamCreditEvidence.covered ?
        decimalCredits(BigInt(teamCreditEvidence.consumed_microcredits ?? '0')) : null,
    })));
  }
  const consumedMicrocredits = creditEvidence.every((row) => row.covered) ?
    creditEvidence.reduce((sum, row) => sum + BigInt(row.consumed_microcredits ?? '0'), 0n) : null;
  const waivedMicrocredits = creditEvidence.reduce((sum, row) =>
    sum + BigInt(row.waived_microcredits), 0n);
  const walletBoundary = await readCycleWalletBoundary(prisma, {
    orgId: initial.organisationId, teamId: initial.teamId, payer: initial.scope,
    startsAt, endsAt,
  });
  if (initial.teamId === null) {
    usageLines = aggregateOrganisationCycleUsage(organisationUsageLines);
  }
  if (initial.teamId !== null) {
    usageLines = usageLines.map((line) => ({ ...line,
      credits_consumed: consumedMicrocredits === null ? null : decimalCredits(consumedMicrocredits) }));
  }

  const closeInTransaction = () => prisma.$transaction(async (tx) => {
    // Seat admission and financial source changes share the organisation lock.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM organisations WHERE id = ${initial.organisationId} FOR UPDATE
    `);
    if (locked.length !== 1) hold('BILLING_CYCLE_ORGANISATION_MISSING');
    const quote = await quoteFn(params, { prisma: tx as unknown as PrismaClient,
      now: deps?.now });
    if (quoteFingerprint(initial, startsAt, endsAt) !==
      quoteFingerprint(quote, startsAt, endsAt)) hold('BILLING_CYCLE_QUOTE_CHANGED');
    const fingerprint = quoteFingerprint(quote, startsAt, endsAt);
    const lockedCreditEvidence = await Promise.all(teams.map((teamId) => {
      const raw = ledgerSnapshots.find((row) => row.team_id === teamId)?.raw_lines;
      const proof = proofs.get(teamId);
      if (!raw || !proof) hold('BILLING_CYCLE_LEDGER_SCOPE_MISMATCH');
      return readVerifiedCycleCreditEvidence(tx, {
        scope: { product: service.identifier, organisationId: quote.organisationId,
          teamId, billingMonth: params.billingMonth, serviceId: service.id },
        proof, payer: quote.scope, tariff, rawLines: raw,
      });
    }));
    if (lockedCreditEvidence.some((row, index) =>
      row.fingerprint !== creditEvidence[index]?.fingerprint)) {
      hold('BILLING_CYCLE_CREDIT_SOURCE_CHANGED');
    }
    const lockedWallet = await readCycleWalletBoundary(tx, {
      orgId: quote.organisationId, teamId: quote.teamId, payer: quote.scope,
      startsAt, endsAt,
    });
    if (lockedWallet.fingerprint !== walletBoundary.fingerprint) {
      hold('BILLING_CYCLE_WALLET_BOUNDARY_CHANGED');
    }
    const creditFingerprint = billingCycleSnapshotDigest(creditEvidence.map((row) => ({
      team_id: row.team_id, fingerprint: row.fingerprint,
    })), { wallet_boundary: walletBoundary.fingerprint });
    const existing = await tx.billingCustomerCycle.findFirst({ where: {
      serviceId: quote.serviceId, orgId: quote.organisationId,
      teamId: quote.teamId, billingMonth: params.billingMonth,
    }, orderBy: { revision: 'desc' } });
    if (existing) {
      const evidence = existing.privateEvidence as Record<string, unknown>;
      if (evidence.quote_fingerprint !== fingerprint ||
        billingCycleSnapshotDigest(existing.publicSnapshot, existing.privateEvidence) !==
          existing.snapshotSha256) hold('BILLING_CYCLE_EXISTING_RECONCILIATION_REQUIRED');
      const oldEvidence = evidence.ledger_snapshots;
      if (!Array.isArray(oldEvidence) || oldEvidence.some((row) => !row ||
        typeof row.team_id !== 'string' || typeof row.content_sha256 !== 'string')) {
        hold('BILLING_CYCLE_EXISTING_RECONCILIATION_REQUIRED');
      }
      const oldLedgerFingerprint = cycleUsageContentFingerprint(oldEvidence as CycleUsageEvidence[]);
      const newLedgerFingerprint = cycleUsageContentFingerprint(ledgerSnapshots);
      if (oldLedgerFingerprint === newLedgerFingerprint &&
        evidence.credit_fingerprint === creditFingerprint) {
        return { cycleId: existing.id, amountMinor: quote.amountMinor,
          currency: quote.currency, snapshotSha256: existing.snapshotSha256 };
      }
      // A late immutable receipt changes the customer view. Keep the issued
      // cycle untouched and append a pending correction; only a separately
      // verified financial effect may finalize this new revision.
    }
    const id = randomUUID();
    const subscription = projectMonthlySubscriptionLine(quote, startsAt, endsAt);
    const publicSnapshot: BillingCycleDetailV2 = {
      schema_version: 2, cycle_id: id,
      ...(existing?.state === 'pending_reconciliation' ?
        ((existing.publicSnapshot as { correction_of_cycle_id?: string })
          .correction_of_cycle_id ?
          { correction_of_cycle_id: (existing.publicSnapshot as {
            correction_of_cycle_id: string }).correction_of_cycle_id } : {}) :
        existing ? { correction_of_cycle_id: existing.id } : {}),
      period: { month: params.billingMonth, starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString() },
      state: 'pending_reconciliation',
      scope: { organisation_id: quote.organisationId, team_id: quote.teamId,
        cycle_scope: quote.teamId === null ? 'organisation' : 'team',
        payer_scope: quote.scope.toLowerCase() as 'team' | 'organisation' },
      product: { id: service.id, identifier: service.identifier, name: service.name },
      totals: [], document_available: false, subscription_lines: [subscription],
      usage_lines: usageLines,
      credits: { consumed: consumedMicrocredits === null ? null :
        decimalCredits(consumedMicrocredits), waived: decimalCredits(waivedMicrocredits),
        opening_balance: walletBoundary.opening_microcredits === null ? null :
          decimalCredits(BigInt(walletBoundary.opening_microcredits)),
        closing_balance: walletBoundary.closing_microcredits === null ? null :
          decimalCredits(BigInt(walletBoundary.closing_microcredits)),
        status: walletBoundary.status },
      documents: [], adjustments: [],
    };
    const privateEvidence = { source: quote.source, quote_fingerprint: fingerprint,
      previous_cycle_id: existing?.id ?? null,
      team_discovery: discovery,
      quote: privateMonthlyQuoteEvidence(quote), ledger_snapshots: ledgerSnapshots,
      paid_receipt_proofs: [...proofs.values()],
      wallet_boundary: walletBoundary,
      credit_evidence: creditEvidence, credit_fingerprint: creditFingerprint };
    const digest = billingCycleSnapshotDigest(publicSnapshot, privateEvidence);
    await tx.billingCustomerCycle.create({ data: {
      id, serviceId: quote.serviceId, orgId: quote.organisationId,
      teamId: quote.teamId, billingMonth: params.billingMonth,
      revision: (existing?.revision ?? 0) + 1,
      state: 'pending_reconciliation', payerScope: quote.scope,
      publicSnapshot: publicSnapshot as unknown as Prisma.InputJsonValue,
      privateEvidence: privateEvidence as unknown as Prisma.InputJsonValue,
      snapshotSha256: digest,
    } });
    return { cycleId: id, amountMinor: quote.amountMinor,
      currency: quote.currency, snapshotSha256: digest };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await closeInTransaction();
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2034' || attempt === 2) throw error;
    }
  }
  return hold('BILLING_CYCLE_TRANSACTION_RETRY_EXHAUSTED');
}
