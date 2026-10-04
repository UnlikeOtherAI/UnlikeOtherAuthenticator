import { randomUUID } from 'node:crypto';

import {
  BillingAssignmentScope, BillingTariffSource, Prisma, type PrismaClient,
} from '@prisma/client';

import type { BillingCycleDetailV2 } from '../contracts/billing-statement-v1.js';
import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { assertUnambiguousCreditPayer } from './billing-credit-payer-period.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { decimalCredits, readCycleCreditEvidence } from './billing-cycle-credit-evidence.service.js';
import {
  cycleUsageContentFingerprint, projectCycleUsage, type CycleUsageEvidence,
} from './billing-cycle-usage-projection.service.js';
import { fetchLedgerMeteringUsage } from './billing-ledger-collector.service.js';
import { fetchLedgerHistoricalBillingTeams } from './billing-ledger-team-discovery.service.js';
import { resolveBillingTariffForMonth } from './billing-tariff-history.service.js';

function hold(code: string): never {
  throw new AppError('INTERNAL', 409, code);
}

function period(month: string): { startsAt: Date; endsAt: Date } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) hold('BILLING_MONTH_INVALID');
  const startsAt = new Date(`${month}-01T00:00:00.000Z`);
  return { startsAt, endsAt: new Date(Date.UTC(startsAt.getUTCFullYear(),
    startsAt.getUTCMonth() + 1, 1)) };
}

async function historicalPayer(
  reader: PrismaClient | Prisma.TransactionClient, orgId: string, month: string,
): Promise<BillingAssignmentScope> {
  try {
    await assertUnambiguousCreditPayer(reader, {
      orgId, scope: BillingAssignmentScope.TEAM, billingMonth: month,
    });
    return BillingAssignmentScope.TEAM;
  } catch (error) {
    if (!(error instanceof AppError) ||
      error.message !== 'BILLING_CREDIT_HISTORICAL_PAYER_MISMATCH') throw error;
  }
  await assertUnambiguousCreditPayer(reader, {
    orgId, scope: BillingAssignmentScope.ORGANISATION, billingMonth: month,
  });
  return BillingAssignmentScope.ORGANISATION;
}

/**
 * Freezes one selected team's measured usage even when its payer is an
 * organisation or its subscription fee is in a separate organisation cycle.
 * No current roster or current responsibility is used as historical evidence.
 */
export async function prepareBillingTeamUsageCycle(
  params: { serviceId: string; organisationId: string; teamId: string;
    billingMonth: string; organisationCycleId?: string },
  deps?: { prisma?: PrismaClient; now?: () => Date;
    fetchMetering?: typeof fetchLedgerMeteringUsage;
    discoverTeams?: typeof fetchLedgerHistoricalBillingTeams },
): Promise<{ cycleId: string; snapshotSha256: string }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const { startsAt, endsAt } = period(params.billingMonth);
  if (endsAt > (deps?.now?.() ?? new Date())) hold('BILLING_MONTH_NOT_CLOSED');
  const [service, terms, payer] = await Promise.all([
    prisma.billingService.findUnique({ where: { id: params.serviceId },
      select: { id: true, identifier: true, name: true } }),
    resolveBillingTariffForMonth(prisma, params),
    historicalPayer(prisma, params.organisationId, params.billingMonth),
  ]);
  if (!service) hold('BILLING_CYCLE_SERVICE_MISSING');
  const discovery = await (deps?.discoverTeams ?? fetchLedgerHistoricalBillingTeams)({
    product: service.identifier, organisationId: params.organisationId,
    billingMonth: params.billingMonth,
  });
  if (!discovery.teamIds.includes(params.teamId)) hold('BILLING_CYCLE_TEAM_SCOPE_MISSING');
  const organisationSubscription = terms.tariff.monthlyAmountMinor !== 0n &&
    terms.source === BillingTariffSource.ORGANISATION &&
    Boolean(params.organisationCycleId);
  if (terms.tariff.monthlyAmountMinor !== 0n && !organisationSubscription) {
    hold('BILLING_CYCLE_MONTHLY_SOURCE_REQUIRED');
  }
  const usage = await (deps?.fetchMetering ?? fetchLedgerMeteringUsage)({
    product: service.identifier, organisationId: params.organisationId,
    teamId: params.teamId, billingMonth: params.billingMonth, groupBy: 'user',
  });
  const projected = projectCycleUsage(usage, { serviceIdentifier: service.identifier,
    organisationId: params.organisationId, teamId: params.teamId,
    billingMonth: params.billingMonth, startsAt, endsAt,
    currency: terms.tariff.currency }, terms.tariff);
  const ratedAmount = projected.lines[0]?.customer_charge?.amount ?? '0';
  const creditEvidence = await readCycleCreditEvidence(prisma, {
    orgId: params.organisationId, teamId: params.teamId, serviceId: params.serviceId,
    billingMonth: params.billingMonth, payer, tariff: terms.tariff,
    ratedAmount, rawLines: projected.evidence.raw_lines,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id FROM organisations WHERE id = ${params.organisationId} FOR UPDATE
        `);
        if (locked.length !== 1) hold('BILLING_CYCLE_ORGANISATION_MISSING');
        const [frozenTerms, frozenPayer] = await Promise.all([
          resolveBillingTariffForMonth(tx, params),
          historicalPayer(tx, params.organisationId, params.billingMonth),
        ]);
        if (frozenTerms.tariff.id !== terms.tariff.id ||
          frozenTerms.assignmentId !== terms.assignmentId || frozenPayer !== payer) {
          hold('BILLING_CYCLE_HISTORICAL_TERMS_CHANGED');
        }
        const lockedCredits = await readCycleCreditEvidence(tx, {
          orgId: params.organisationId, teamId: params.teamId, serviceId: params.serviceId,
          billingMonth: params.billingMonth, payer, tariff: terms.tariff,
          ratedAmount, rawLines: projected.evidence.raw_lines,
        });
        if (lockedCredits.fingerprint !== creditEvidence.fingerprint) {
          hold('BILLING_CYCLE_CREDIT_SOURCE_CHANGED');
        }
        if (organisationSubscription) {
          const orgCycleId = params.organisationCycleId;
          if (!orgCycleId) hold('BILLING_CYCLE_ORGANISATION_SOURCE_RECONCILIATION_REQUIRED');
          if (payer !== BillingAssignmentScope.ORGANISATION) {
            hold('BILLING_CYCLE_ORGANISATION_PAYER_REQUIRED');
          }
          const organisationCycle = await tx.billingCustomerCycle.findUnique({
            where: { id: orgCycleId },
          });
          const orgEvidence = organisationCycle?.privateEvidence as
            Record<string, unknown> | undefined;
          const orgQuote = orgEvidence?.quote as Record<string, unknown> | undefined;
          const orgSnapshots = orgEvidence?.ledger_snapshots;
          if (!organisationCycle || organisationCycle.serviceId !== params.serviceId ||
            organisationCycle.orgId !== params.organisationId ||
            organisationCycle.teamId !== null ||
            organisationCycle.billingMonth !== params.billingMonth ||
            organisationCycle.payerScope !== BillingAssignmentScope.ORGANISATION ||
            orgQuote?.tariff_id !== terms.tariff.id ||
            billingCycleSnapshotDigest(organisationCycle.publicSnapshot,
              organisationCycle.privateEvidence) !== organisationCycle.snapshotSha256 ||
            !Array.isArray(orgSnapshots) || !orgSnapshots.some((row) => row &&
              row.team_id === params.teamId &&
              row.content_sha256 === projected.evidence.content_sha256)) {
            hold('BILLING_CYCLE_ORGANISATION_SOURCE_RECONCILIATION_REQUIRED');
          }
        }
        const existing = await tx.billingCustomerCycle.findFirst({ where: {
          serviceId: params.serviceId, orgId: params.organisationId,
          teamId: params.teamId, billingMonth: params.billingMonth,
        }, orderBy: { revision: 'desc' } });
        if (existing) {
          const prior = existing.privateEvidence as Record<string, unknown>;
          const snapshots = prior.ledger_snapshots;
          if (prior.source !== 'team_usage_only' || prior.tariff_id !== terms.tariff.id ||
            (prior.organisation_cycle_id ?? null) !== (params.organisationCycleId ?? null) ||
            existing.payerScope !== payer ||
            billingCycleSnapshotDigest(existing.publicSnapshot, existing.privateEvidence) !==
              existing.snapshotSha256 || !Array.isArray(snapshots) ||
            snapshots.some((row) => !row || typeof row.team_id !== 'string' ||
              typeof row.content_sha256 !== 'string')) {
            hold('BILLING_CYCLE_EXISTING_RECONCILIATION_REQUIRED');
          }
          if (cycleUsageContentFingerprint(snapshots as CycleUsageEvidence[]) ===
            cycleUsageContentFingerprint([projected.evidence]) &&
            prior.credit_fingerprint === creditEvidence.fingerprint) {
            return { cycleId: existing.id, snapshotSha256: existing.snapshotSha256 };
          }
          if (existing.state !== 'pending_reconciliation') {
            hold('BILLING_CYCLE_FINALIZED_RECEIPT_ADJUSTMENT_REQUIRED');
          }
        }
        const id = randomUUID();
        const publicSnapshot: BillingCycleDetailV2 = {
          schema_version: 2, cycle_id: id,
          period: { month: params.billingMonth, starts_at: startsAt.toISOString(),
            ends_at: endsAt.toISOString() },
          state: 'pending_reconciliation',
          scope: { organisation_id: params.organisationId, team_id: params.teamId,
            cycle_scope: 'team', payer_scope: payer.toLowerCase() as 'team' | 'organisation' },
          product: service, totals: [], document_available: false,
          subscription_lines: [], usage_lines: projected.lines.map((line) => ({
            ...line, credits_consumed: creditEvidence.covered ?
              decimalCredits(BigInt(creditEvidence.consumed_microcredits ?? '0')) : null,
          })),
          credits: { consumed: creditEvidence.covered ?
            decimalCredits(BigInt(creditEvidence.consumed_microcredits ?? '0')) : null,
            opening_balance: null, closing_balance: null,
            status: 'pending_reconciliation' },
          documents: [], adjustments: [],
        };
        const privateEvidence = { source: 'team_usage_only', tariff_id: terms.tariff.id,
          tariff_source: terms.source, assignment_id: terms.assignmentId,
          organisation_cycle_id: params.organisationCycleId ?? null,
          team_discovery: discovery.snapshot,
          previous_cycle_id: existing?.id ?? null,
          ledger_snapshots: [projected.evidence],
          credit_evidence: [creditEvidence], credit_fingerprint: creditEvidence.fingerprint };
        const digest = billingCycleSnapshotDigest(publicSnapshot, privateEvidence);
        await tx.billingCustomerCycle.create({ data: {
          id, serviceId: params.serviceId, orgId: params.organisationId,
          teamId: params.teamId, billingMonth: params.billingMonth,
          revision: (existing?.revision ?? 0) + 1,
          state: 'pending_reconciliation', payerScope: payer,
          publicSnapshot: publicSnapshot as unknown as Prisma.InputJsonValue,
          privateEvidence: privateEvidence as unknown as Prisma.InputJsonValue,
          snapshotSha256: digest,
        } });
        return { cycleId: id, snapshotSha256: digest };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2034' || attempt === 2) throw error;
    }
  }
  return hold('BILLING_CYCLE_TRANSACTION_RETRY_EXHAUSTED');
}
