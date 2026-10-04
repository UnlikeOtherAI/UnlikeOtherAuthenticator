import { randomUUID } from 'node:crypto';

import { BillingAssignmentScope, Prisma, type PrismaClient } from '@prisma/client';

import type { BillingCycleDetailV2, BillingCycleUsageLine } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import {
  privateMonthlyQuoteEvidence, projectMonthlySubscriptionLine,
} from './billing-cycle-quote-projection.service.js';
import { projectCycleUsage } from './billing-cycle-usage-projection.service.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import {
  quoteSubscriptionMonthlyCharge, type MonthlyChargeSource,
} from './billing-monthly-subscription-quote.service.js';

type MonthlyQuote = Awaited<ReturnType<typeof quoteSubscriptionMonthlyCharge>>;
type UsageEvidence = ReturnType<typeof projectCycleUsage>['evidence'];

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

function sameQuote(left: MonthlyQuote, right: MonthlyQuote): boolean {
  return billingCycleSnapshotDigest(privateMonthlyQuoteEvidence(left), {}) ===
    billingCycleSnapshotDigest(privateMonthlyQuoteEvidence(right), {});
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
    fetchMetering?: typeof fetchLedgerMeteringUsage },
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
  const [service, tariff, teams] = await Promise.all([
    prisma.billingService.findUnique({ where: { id: initial.serviceId },
      select: { id: true, identifier: true, name: true } }),
    prisma.billingTariff.findUnique({ where: { id: initial.tariffId } }),
    initial.teamId ? Promise.resolve([{ id: initial.teamId }]) :
      prisma.team.findMany({ where: { orgId: initial.organisationId },
        select: { id: true }, orderBy: { id: 'asc' } }),
  ]);
  if (!service || !tariff || tariff.serviceId !== service.id ||
    tariff.currency !== initial.currency) hold('BILLING_CYCLE_SOURCE_TERMS_INVALID');

  const ledgerSnapshots: UsageEvidence[] = [];
  let usageLines: BillingCycleUsageLine[] = [];
  for (const team of teams) {
    const usage = await (deps?.fetchMetering ?? fetchLedgerMeteringUsage)({
      product: service.identifier, organisationId: initial.organisationId,
      teamId: team.id, billingMonth: params.billingMonth, groupBy: 'user',
    });
    const projected = projectCycleUsage(usage, {
      serviceIdentifier: service.identifier, organisationId: initial.organisationId,
      teamId: team.id, billingMonth: params.billingMonth, startsAt, endsAt,
      currency: initial.currency,
    }, tariff);
    ledgerSnapshots.push(projected.evidence);
    if (initial.teamId !== null) usageLines = projected.lines;
  }

  const closeInTransaction = () => prisma.$transaction(async (tx) => {
    // Seat admission and financial source changes share the organisation lock.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM organisations WHERE id = ${initial.organisationId} FOR UPDATE
    `);
    if (locked.length !== 1) hold('BILLING_CYCLE_ORGANISATION_MISSING');
    const quote = await quoteFn(params, { prisma: tx as unknown as PrismaClient,
      now: deps?.now });
    if (!sameQuote(initial, quote)) hold('BILLING_CYCLE_QUOTE_CHANGED');
    const fingerprint = billingCycleSnapshotDigest(privateMonthlyQuoteEvidence(quote), {});
    const existing = await tx.billingCustomerCycle.findFirst({ where: {
      serviceId: quote.serviceId, orgId: quote.organisationId,
      teamId: quote.teamId, billingMonth: params.billingMonth,
    }, orderBy: { revision: 'desc' } });
    if (existing) {
      const evidence = existing.privateEvidence as Record<string, unknown>;
      if (evidence.quote_fingerprint !== fingerprint ||
        billingCycleSnapshotDigest(existing.publicSnapshot, existing.privateEvidence) !==
          existing.snapshotSha256) hold('BILLING_CYCLE_EXISTING_RECONCILIATION_REQUIRED');
      return { cycleId: existing.id, amountMinor: quote.amountMinor,
        currency: quote.currency, snapshotSha256: existing.snapshotSha256 };
    }
    const id = randomUUID();
    const subscription = projectMonthlySubscriptionLine(quote, startsAt, endsAt);
    const publicSnapshot: BillingCycleDetailV2 = {
      schema_version: 2, cycle_id: id,
      period: { month: params.billingMonth, starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString() },
      state: 'pending_reconciliation',
      scope: { organisation_id: quote.organisationId, team_id: quote.teamId,
        cycle_scope: quote.teamId === null ? 'organisation' : 'team',
        payer_scope: quote.scope.toLowerCase() as 'team' | 'organisation' },
      product: { id: service.id, identifier: service.identifier, name: service.name },
      totals: [], document_available: false, subscription_lines: [subscription],
      usage_lines: usageLines,
      credits: { consumed: null, opening_balance: null, closing_balance: null,
        status: 'pending_reconciliation' },
      documents: [], adjustments: [],
    };
    const privateEvidence = { source: quote.source, quote_fingerprint: fingerprint,
      quote: privateMonthlyQuoteEvidence(quote), ledger_snapshots: ledgerSnapshots };
    const digest = billingCycleSnapshotDigest(publicSnapshot, privateEvidence);
    await tx.billingCustomerCycle.create({ data: {
      id, serviceId: quote.serviceId, orgId: quote.organisationId,
      teamId: quote.teamId, billingMonth: params.billingMonth, revision: 1,
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
