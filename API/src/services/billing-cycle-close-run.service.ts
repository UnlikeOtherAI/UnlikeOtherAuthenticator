import { randomUUID } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { collectStripeClosingSeatInvoice } from './billing-stripe-closing-seat-invoice.service.js';
import { prepareBillingCycleClose } from './billing-cycle-close.service.js';
import { prepareBillingTeamUsageCycle } from './billing-cycle-team-usage.service.js';
import { fetchLedgerHistoricalBillingTeams } from './billing-ledger-team-discovery.service.js';
import { billingCycleSnapshotDigest } from './billing-cycle-read.service.js';
import { finalizePrepaidBillingCycle } from './billing-cycle-prepaid-correction.service.js';

const BATCH_SIZE = 50;
type Claimed = { id: string; sourceKind: string; sourceId: string;
  serviceId: string; orgId: string; teamId: string | null;
  billingMonth: string; priority: number; generation: bigint;
  leaseToken: string; attempts: number };

function errorCode(error: unknown): string {
  return error instanceof AppError && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.message) ?
    error.message : 'BILLING_CYCLE_CLOSE_FAILED';
}

async function claim(prisma: PrismaClient): Promise<Claimed[]> {
  const token = randomUUID();
  return prisma.$queryRaw<Claimed[]>(Prisma.sql`
    WITH due AS (
      SELECT id FROM billing_cycle_close_watches
      WHERE next_check_at <= now()
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      ORDER BY priority, next_check_at, id
      FOR UPDATE SKIP LOCKED LIMIT ${BATCH_SIZE}
    )
    UPDATE billing_cycle_close_watches AS watch
    SET lease_token = ${token}::uuid,
      lease_expires_at = now() + interval '3 minutes',
      generation = generation + 1, attempts = attempts + 1, updated_at = now()
    FROM due WHERE watch.id = due.id
    RETURNING watch.id, watch.source_kind AS "sourceKind",
      watch.source_id AS "sourceId", watch.service_id AS "serviceId",
      watch.org_id AS "orgId", watch.team_id AS "teamId",
      watch.billing_month AS "billingMonth", watch.priority, watch.generation,
      watch.lease_token::text AS "leaseToken", watch.attempts
  `);
}

async function complete(prisma: PrismaClient, row: Claimed,
  cycleId: string | null, now: Date): Promise<void> {
  const monthStart = new Date(`${row.billingMonth}-01T00:00:00.000Z`);
  const recent = monthStart >= new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  await prisma.$executeRaw(Prisma.sql`
    UPDATE billing_cycle_close_watches
    SET next_check_at = now() + ${recent ? 6 : 168} * interval '1 hour',
      lease_token = NULL, lease_expires_at = NULL,
      last_cycle_id = ${cycleId}, last_error_code = NULL,
      last_checked_at = now(), updated_at = now()
    WHERE id = ${row.id} AND generation = ${row.generation}
      AND lease_token = ${row.leaseToken}::uuid
  `);
}

async function retry(prisma: PrismaClient, row: Claimed,
  code: string): Promise<void> {
  const seconds = Math.min(3600, 30 * 2 ** Math.min(row.attempts, 7));
  await prisma.$executeRaw(Prisma.sql`
    UPDATE billing_cycle_close_watches
    SET next_check_at = now() + ${seconds} * interval '1 second',
      lease_token = NULL, lease_expires_at = NULL,
      last_error_code = ${code}, last_checked_at = now(), updated_at = now()
    WHERE id = ${row.id} AND generation = ${row.generation}
      AND lease_token = ${row.leaseToken}::uuid
  `);
}

async function runOne(prisma: PrismaClient, row: Claimed,
  deps: { close?: typeof prepareBillingCycleClose;
    team?: typeof prepareBillingTeamUsageCycle;
    finalizePrepaid?: typeof finalizePrepaidBillingCycle;
    discover?: typeof fetchLedgerHistoricalBillingTeams }): Promise<string | null> {
  const service = await prisma.billingService.findUnique({ where: { id: row.serviceId },
    select: { identifier: true } });
  if (!service) throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_SOURCE_SERVICE_MISSING');
  if (row.sourceKind === 'stripe' || row.sourceKind === 'manual') {
    if (row.sourceKind === 'stripe') await collectStripeClosingSeatInvoice({
      subscriptionId: row.sourceId, billingMonth: row.billingMonth,
    }, { prisma });
    const result = await (deps.close ?? prepareBillingCycleClose)({
      source: { kind: row.sourceKind, id: row.sourceId }, billingMonth: row.billingMonth,
    }, { prisma });
    const cycle = await prisma.billingCustomerCycle.findUnique({ where: { id: result.cycleId },
      select: { serviceId: true, orgId: true, teamId: true, billingMonth: true } });
    if (!cycle || cycle.serviceId !== row.serviceId || cycle.orgId !== row.orgId ||
      cycle.teamId !== row.teamId || cycle.billingMonth !== row.billingMonth) {
      throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_WATCH_SOURCE_REBOUND');
    }
    const finalized = await (deps.finalizePrepaid ?? finalizePrepaidBillingCycle)(
      { cycleId: result.cycleId }, { prisma });
    return finalized?.cycleId ?? result.cycleId;
  }
  if (row.sourceKind === 'team_discovery') {
    if (row.teamId !== null || row.sourceId !== `${row.serviceId}:${row.orgId}`) {
      throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_WATCH_SOURCE_REBOUND');
    }
    const discovery = await (deps.discover ?? fetchLedgerHistoricalBillingTeams)({
      product: service.identifier, organisationId: row.orgId,
      billingMonth: row.billingMonth,
    });
    await prisma.$transaction(async (tx) => {
      const lease = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM billing_cycle_close_watches
        WHERE id = ${row.id} AND generation = ${row.generation}
          AND lease_token = ${row.leaseToken}::uuid AND lease_expires_at > now()
        FOR UPDATE
      `);
      if (lease.length !== 1) {
        throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_WATCH_LEASE_LOST');
      }
      await tx.billingCycleCloseWatch.createMany({ data: discovery.teamIds.map((teamId) => ({
        sourceKind: 'team_usage', sourceId: `${row.serviceId}:${row.orgId}:${teamId}`,
        serviceId: row.serviceId, orgId: row.orgId, teamId,
        billingMonth: row.billingMonth, priority: row.priority,
        nextCheckAt: new Date(),
      })), skipDuplicates: true });
    });
    return null;
  }
  if (row.sourceKind === 'team_usage') {
    if (!row.teamId || row.sourceId !== `${row.serviceId}:${row.orgId}:${row.teamId}`) {
      throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_WATCH_SOURCE_REBOUND');
    }
    const orgCycle = await prisma.billingCustomerCycle.findFirst({ where: {
      serviceId: row.serviceId, orgId: row.orgId, teamId: null,
      billingMonth: row.billingMonth,
    }, orderBy: { revision: 'desc' }, select: { id: true } });
    try {
      const result = await (deps.team ?? prepareBillingTeamUsageCycle)({
        serviceId: row.serviceId, organisationId: row.orgId,
        teamId: row.teamId, billingMonth: row.billingMonth,
        organisationCycleId: orgCycle?.id,
      }, { prisma });
      const cycle = await prisma.billingCustomerCycle.findUnique({ where: { id: result.cycleId },
        select: { serviceId: true, orgId: true, teamId: true, billingMonth: true } });
      if (!cycle || cycle.serviceId !== row.serviceId || cycle.orgId !== row.orgId ||
        cycle.teamId !== row.teamId || cycle.billingMonth !== row.billingMonth) {
        throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_WATCH_SOURCE_REBOUND');
      }
      const finalized = await (deps.finalizePrepaid ?? finalizePrepaidBillingCycle)(
        { cycleId: result.cycleId }, { prisma });
      return finalized?.cycleId ?? result.cycleId;
    } catch (error) {
      if (!(error instanceof AppError) ||
        error.message !== 'BILLING_CYCLE_MONTHLY_SOURCE_REQUIRED') throw error;
      // A team-scoped paid subscription has its own financial source watch.
      const paidCycle = await prisma.billingCustomerCycle.findFirst({ where: {
        serviceId: row.serviceId, orgId: row.orgId, teamId: row.teamId,
        billingMonth: row.billingMonth,
      }, orderBy: { revision: 'desc' }, select: { id: true, privateEvidence: true,
        publicSnapshot: true, snapshotSha256: true } });
      const evidence = paidCycle?.privateEvidence as Record<string, unknown> | undefined;
      const quote = evidence?.quote as Record<string, unknown> | undefined;
      const source = quote?.source as Record<string, unknown> | undefined;
      if (!paidCycle || source?.kind !== 'stripe' || typeof source.id !== 'string' ||
        billingCycleSnapshotDigest(paidCycle.publicSnapshot, paidCycle.privateEvidence) !==
          paidCycle.snapshotSha256) throw error;
      const paidWatch = await prisma.billingCycleCloseWatch.findUnique({ where: {
        sourceKind_sourceId_billingMonth: { sourceKind: 'stripe', sourceId: source.id,
          billingMonth: row.billingMonth },
      }, select: { serviceId: true, orgId: true, teamId: true, lastCycleId: true } });
      if (!paidWatch || paidWatch.serviceId !== row.serviceId ||
        paidWatch.orgId !== row.orgId || paidWatch.teamId !== row.teamId ||
        paidWatch.lastCycleId !== paidCycle.id) throw error;
      return paidCycle?.id ?? null;
    }
  }
  throw new AppError('INTERNAL', 409, 'BILLING_CYCLE_WATCH_KIND_UNKNOWN');
}

/** Multi-instance workers claim disjoint due jobs; failures remain retryable. */
export async function runBillingCycleCloseBatch(deps?: {
  prisma?: PrismaClient; now?: Date;
  close?: typeof prepareBillingCycleClose;
  team?: typeof prepareBillingTeamUsageCycle;
  finalizePrepaid?: typeof finalizePrepaidBillingCycle;
  discover?: typeof fetchLedgerHistoricalBillingTeams;
}): Promise<{ checked: number; held: number; backlog: number;
  failures: Array<{ id: string; code: string }> }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now ?? new Date();
  const claimed = await claim(prisma);
  const failures: Array<{ id: string; code: string }> = [];
  for (const row of claimed) {
    try {
      const cycleId = await runOne(prisma, row, deps ?? {});
      await complete(prisma, row, cycleId, now);
    } catch (error) {
      const code = errorCode(error);
      await retry(prisma, row, code);
      failures.push({ id: row.id, code });
    }
  }
  const backlog = await prisma.billingCycleCloseWatch.count({ where: {
    nextCheckAt: { lte: now }, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
  } });
  return { checked: claimed.length, held: failures.length, backlog, failures };
}
