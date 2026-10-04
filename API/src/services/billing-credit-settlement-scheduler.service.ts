import { BillingAppKeyPurpose, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import { resolveCanonicalPortfolioProduct } from './billing-credit-account.service.js';
import { settleCreditPortfolio } from './billing-credit-settlement.service.js';
import { fetchLedgerMeteringPortfolio } from './billing-ledger-collector.service.js';
import { assertUnambiguousCreditPayer, billingMonthKey } from './billing-credit-payer-period.service.js';

const CYCLE_INTERVAL_MS = 5 * 60_000;
const WATCH_BATCH_SIZE = 100;
const CLAIM_LEASE_MS = 10 * 60_000;

function monthDates(first: Date, last: Date): string[] {
  const months: string[] = [];
  for (let date = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
    date <= last;
    date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))) {
    months.push(billingMonthKey(date));
  }
  return months;
}

async function seedSettlementWatches(prisma: PrismaClient, now: Date): Promise<number> {
  const accounts = await prisma.billingCreditAccount.findMany({
    select: { id: true, orgId: true, teamId: true, scope: true, createdAt: true },
    orderBy: { id: 'asc' },
  });
  let count = 0;
  for (const account of accounts) {
    const teams = account.teamId
      ? await prisma.team.findMany({ where: { id: account.teamId, orgId: account.orgId }, select: { id: true, createdAt: true } })
      : await prisma.team.findMany({ where: { orgId: account.orgId }, select: { id: true, createdAt: true } });
    for (const team of teams) {
      // A payer account may be opened only after a prior month's provider
      // receipt arrives. Its team creation is the earliest attributable month;
      // payer-history checks below decide which account owned each period.
      const startsAt = team.createdAt;
      const rows = monthDates(startsAt, now).map((billingMonth) => ({
        creditAccountId: account.id,
        teamId: team.id,
        billingMonth,
      }));
      if (rows.length) {
        const inserted = await prisma.billingCreditSettlementWatch.createMany({ data: rows, skipDuplicates: true });
        count += inserted.count;
      }
    }
  }
  return count;
}

export async function runCreditSettlementCycle(deps?: {
  prisma?: PrismaClient;
  now?: () => Date;
  fetchPortfolio?: typeof fetchLedgerMeteringPortfolio;
  settlePortfolio?: typeof settleCreditPortfolio;
  seed?: boolean;
}): Promise<{ seeded: number; checked: number; settled: number; held: number; backlog: number }> {
  const prisma = deps?.prisma ?? getAdminPrisma();
  const now = deps?.now?.() ?? new Date();
  const seeded = deps?.seed === false ? 0 : await seedSettlementWatches(prisma, now);
  const recentMonths = [billingMonthKey(now), billingMonthKey(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
  )];
  const due = { nextCheckAt: { lte: now } };
  const recent = await prisma.billingCreditSettlementWatch.findMany({
    where: { ...due, billingMonth: { in: recentMonths } },
    orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
    take: WATCH_BATCH_SIZE,
    include: { creditAccount: true, team: true },
  });
  const historical = await prisma.billingCreditSettlementWatch.findMany({
    where: { ...due, billingMonth: { notIn: recentMonths } },
    orderBy: [{ nextCheckAt: 'asc' }, { id: 'asc' }],
    take: WATCH_BATCH_SIZE,
    include: { creditAccount: true, team: true },
  });
  const watches = [...recent, ...historical];
  let settled = 0;
  let held = 0;
  let checked = 0;
  for (const watch of watches) {
    const claimed = await prisma.billingCreditSettlementWatch.updateMany({
      where: { id: watch.id, nextCheckAt: { lte: now } },
      data: { nextCheckAt: new Date(now.getTime() + CLAIM_LEASE_MS) },
    });
    if (claimed.count !== 1) continue;
    checked += 1;
    try {
      await assertUnambiguousCreditPayer(prisma, {
        orgId: watch.creditAccount.orgId,
        scope: watch.creditAccount.scope,
        billingMonth: watch.billingMonth,
      });
      const fallbackKey = await prisma.billingAppKey.findFirst({
        where: {
          service: { active: true },
          purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        include: { service: { select: { id: true, identifier: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      if (!fallbackKey) throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_SETTLEMENT_KEY_MISSING');
      const product = await resolveCanonicalPortfolioProduct({
        creditAccountId: watch.creditAccountId,
        teamId: watch.teamId,
        billingMonth: watch.billingMonth,
        fallbackProduct: fallbackKey.service.identifier,
      }, { prisma });
      const key = product === fallbackKey.service.identifier ? fallbackKey : await prisma.billingAppKey.findFirst({
        where: {
          service: { identifier: product },
          purpose: BillingAppKeyPurpose.CUSTOMER_LIFECYCLE,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        include: { service: { select: { id: true, identifier: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      if (!key) throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_SETTLEMENT_KEY_MISSING');
      const portfolio = await (deps?.fetchPortfolio ?? fetchLedgerMeteringPortfolio)({
        product,
        organisationId: watch.creditAccount.orgId,
        teamId: watch.teamId,
        billingMonth: watch.billingMonth,
        groupBy: 'user',
      });
      await (deps?.settlePortfolio ?? settleCreditPortfolio)({
        creditAccountId: watch.creditAccountId,
        portfolio,
        credential: {
          id: key.id,
          purpose: key.purpose,
          actorIssuer: key.actorIssuer,
          actorAudience: key.actorAudience,
          actorKeyId: key.actorKeyId,
          actorPublicJwk: key.actorPublicJwk,
          checkoutReturnOrigins: key.checkoutReturnOrigins,
          service: key.service,
        },
      }, { prisma });
      await prisma.billingCreditSettlementWatch.update({
        where: { id: watch.id },
        data: {
          lastCheckedAt: now,
          nextCheckAt: new Date(now.getTime() + (
            recentMonths.includes(watch.billingMonth) ? CYCLE_INTERVAL_MS : CYCLE_INTERVAL_MS * 12
          )),
          lastCursor: portfolio.snapshot.cursor,
          lastError: null,
        },
      });
      settled += 1;
    } catch (error) {
      if (error instanceof AppError && error.message === 'BILLING_CREDIT_HISTORICAL_PAYER_MISMATCH') {
        // Another account owned this period. Its watch carries the liability;
        // this account has no unsettled charge to surface to its customer.
        await prisma.billingCreditSettlementWatch.update({
          where: { id: watch.id },
          data: {
            lastCheckedAt: now,
            nextCheckAt: new Date(now.getTime() + 24 * 60 * 60_000),
            lastError: null,
          },
        });
        continue;
      }
      await prisma.billingCreditSettlementWatch.update({
        where: { id: watch.id },
        data: {
          lastCheckedAt: now,
          nextCheckAt: new Date(now.getTime() + CYCLE_INTERVAL_MS * 3),
          lastError: error instanceof Error ? error.message.slice(0, 160) : 'UNKNOWN_SETTLEMENT_FAILURE',
        },
      });
      held += 1;
    }
  }
  const backlog = await prisma.billingCreditSettlementWatch.count({
    where: { nextCheckAt: { lte: now } },
  });
  return { seeded, checked, settled, held, backlog };
}

export function startCreditSettlementScheduler(params: {
  log: { info: (details: object, message: string) => void; error: (details: object, message: string) => void };
  runCycle?: typeof runCreditSettlementCycle;
}): { stop: () => void } {
  let running = false;
  let nextSeedAt = 0;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const seed = Date.now() >= nextSeedAt;
      params.log.info(await (params.runCycle ?? runCreditSettlementCycle)({ seed }), 'credit settlement catch-up cycle');
      if (seed) nextSeedAt = Date.now() + 24 * 60 * 60_000;
    } catch (error) {
      params.log.error({ error }, 'credit settlement catch-up cycle failed');
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, CYCLE_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
