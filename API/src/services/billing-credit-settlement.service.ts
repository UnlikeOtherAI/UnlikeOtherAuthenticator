import { Prisma, type PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  rateCreditPortfolio,
  type CreditRatingService,
  type PreviousCreditAllocation,
} from './billing-credit-rating.service.js';
import {
  applyRatedCreditService,
  type LatestCreditAllocation,
} from './billing-credit-settlement-write.service.js';
import type { NormalizedMeteringPortfolio } from './billing-metering.types.js';
import { runBillingSerializableTransaction } from './billing-serializable-transaction.service.js';
import { assertUnambiguousCreditPayer } from './billing-credit-payer-period.service.js';
import {
  lockTariffHistoryService,
  resolveBillingTariffForMonth,
} from './billing-tariff-history.service.js';

function sameInstant(left: Date, right: string): boolean {
  return left.getTime() === Date.parse(right);
}

function assertExistingSnapshot(
  snapshot: Prisma.BillingCreditPortfolioSnapshotGetPayload<Record<string, never>>,
  params: {
    accountId: string;
    creditAccountId: string;
    organisationId: string;
    teamId: string;
    perspectiveServiceId: string;
    portfolio: NormalizedMeteringPortfolio;
  },
): void {
  const portfolio = params.portfolio;
  if (
    snapshot.accountId !== params.accountId ||
    snapshot.creditAccountId !== params.creditAccountId ||
    snapshot.orgId !== params.organisationId ||
    snapshot.teamId !== params.teamId ||
    snapshot.perspectiveServiceId !== params.perspectiveServiceId ||
    snapshot.perspectiveProduct !== portfolio.perspectiveProduct ||
    snapshot.billingMonth !== portfolio.scope.month ||
    snapshot.contract !== 'metering-portfolio-v1' ||
    snapshot.groupBy !== 'user' ||
    snapshot.ledgerSnapshotId !== portfolio.snapshot.id ||
    snapshot.ledgerSnapshotCursor !== portfolio.snapshot.cursor ||
    snapshot.sha256 !== portfolio.snapshot.sha256 ||
    !sameInstant(snapshot.capturedAt, portfolio.snapshot.capturedAt)
  ) {
    throw new AppError('INTERNAL', 502, 'LEDGER_CREDIT_SNAPSHOT_MUTATED');
  }
}

function latestAllocationMap(
  rows: Array<{
    settlementId: string;
    serviceId: string;
    attributedUserId: string | null;
    cumulativeRatedUsageAmountMicroMinor: bigint;
    cumulativeCreditsConsumedMicrocredits: bigint;
    cumulativeRemainingUsageAmountMicroMinor: bigint;
    adjustment: { sequence: number };
  }>,
): Map<string, LatestCreditAllocation> {
  const latest = new Map<string, LatestCreditAllocation>();
  for (const row of rows) {
    const key = `${row.settlementId}\0${row.attributedUserId ?? '\uffff'}`;
    if (latest.has(key)) continue;
    latest.set(key, {
      serviceId: row.serviceId,
      userId: row.attributedUserId,
      ratedMicroMinor: row.cumulativeRatedUsageAmountMicroMinor,
      consumedMicrocredits: row.cumulativeCreditsConsumedMicrocredits,
      remainingMicroMinor: row.cumulativeRemainingUsageAmountMicroMinor,
    });
  }
  return latest;
}

async function settleInTransaction(
  tx: Prisma.TransactionClient,
  params: {
    creditAccountId: string;
    portfolio: NormalizedMeteringPortfolio;
    credential: VerifiedBillingAppKey;
  },
) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "billing_credit_accounts"
    WHERE "id" = ${params.creditAccountId}
    FOR UPDATE
  `);
  if (locked.length !== 1) throw new AppError('NOT_FOUND', 404, 'BILLING_CREDIT_ACCOUNT_MISSING');
  const account = await tx.billingCreditAccount.findUnique({
    where: { id: params.creditAccountId },
  });
  if (!account) throw new AppError('NOT_FOUND', 404, 'BILLING_CREDIT_ACCOUNT_MISSING');
  await assertUnambiguousCreditPayer(tx, {
    orgId: account.orgId,
    scope: account.scope,
    billingMonth: params.portfolio.scope.month,
  });
  // The paying account may be the organisation's (Docs/plans/2026-08-15-org-billing-override.md
  // §2), in which case every team's portfolio settles against it. The team the
  // usage belongs to still drives rating, attribution and the snapshot row —
  // only where the credits are drawn from changes.
  const settlementTeamId = params.portfolio.scope.teamId;
  const portfolioTeam =
    account.teamId === null
      ? await tx.team.findFirst({
          where: { id: params.portfolio.scope.teamId, orgId: account.orgId },
          select: { id: true },
        })
      : null;
  if (
    account.orgId !== params.portfolio.scope.organizationId ||
    (account.teamId === null ? portfolioTeam === null : account.teamId !== params.portfolio.scope.teamId) ||
    account.currency !== 'USD'
  ) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_PORTFOLIO_SCOPE_MISMATCH');
  }
  // A pre-migration organisation row may contain adjustments from several
  // teams. Its prior debit cannot be apportioned without financial evidence.
  // Hold this payer/month for reconciliation instead of debiting it again.
  const legacy = await tx.billingCreditUsageSettlement.findFirst({
    where: {
      creditAccountId: account.id,
      teamId: null,
      billingMonth: params.portfolio.scope.month,
    },
    select: { id: true },
  });
  if (legacy) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_LEGACY_RECONCILIATION_REQUIRED');
  }

  const perspectiveService = await tx.billingService.findUnique({
    where: { identifier: params.portfolio.perspectiveProduct },
  });
  if (!perspectiveService) {
    throw new AppError('INTERNAL', 502, 'LEDGER_CREDIT_PERSPECTIVE_UNKNOWN');
  }
  let snapshot = await tx.billingCreditPortfolioSnapshot.findUnique({
    where: {
      creditAccountId_teamId_ledgerSnapshotCursor: {
        creditAccountId: account.id,
        teamId: settlementTeamId,
        ledgerSnapshotCursor: params.portfolio.snapshot.cursor,
      },
    },
  });
  if (snapshot) {
    assertExistingSnapshot(snapshot, {
      accountId: account.accountId,
      creditAccountId: account.id,
      organisationId: account.orgId,
      teamId: settlementTeamId,
      perspectiveServiceId: perspectiveService.id,
      portfolio: params.portfolio,
    });
  } else {
    const capturedAt = new Date(params.portfolio.snapshot.capturedAt);
    const latestSnapshot = await tx.billingCreditPortfolioSnapshot.findFirst({
      where: {
        creditAccountId: account.id,
        teamId: settlementTeamId,
        billingMonth: params.portfolio.scope.month,
      },
      orderBy: [{ capturedAt: 'desc' }, { ledgerSnapshotCursor: 'desc' }],
    });
    if (latestSnapshot && capturedAt.getTime() <= latestSnapshot.capturedAt.getTime()) {
      return {
        snapshotId: latestSnapshot.id,
        replayed: false,
        superseded: true,
      };
    }
    snapshot = await tx.billingCreditPortfolioSnapshot.create({
      data: {
        accountId: account.accountId,
        creditAccountId: account.id,
        orgId: account.orgId,
        teamId: settlementTeamId,
        perspectiveServiceId: perspectiveService.id,
        perspectiveProduct: params.portfolio.perspectiveProduct,
        billingMonth: params.portfolio.scope.month,
        contract: 'metering-portfolio-v1',
        groupBy: 'user',
        ledgerSnapshotId: params.portfolio.snapshot.id,
        ledgerSnapshotCursor: params.portfolio.snapshot.cursor,
        capturedAt,
        sha256: params.portfolio.snapshot.sha256,
      },
    });
  }

  const existingSettlements = await tx.billingCreditUsageSettlement.findMany({
    where: {
      creditAccountId: account.id,
      teamId: settlementTeamId,
      billingMonth: params.portfolio.scope.month,
    },
    include: {
      service: true,
      tariff: true,
      adjustments: { orderBy: { sequence: 'desc' }, take: 1 },
    },
  });
  const portfolioProducts = new Set(params.portfolio.lines.map((line) => line.billingProduct));
  const services = await tx.billingService.findMany({
    where: {
      OR: [
        { identifier: { in: [...portfolioProducts] } },
        { id: { in: existingSettlements.map((settlement) => settlement.serviceId) } },
      ],
    },
  });
  if (
    services.length !==
    new Set([
      ...portfolioProducts,
      ...existingSettlements.map((settlement) => settlement.service.identifier),
    ]).size
  ) {
    throw new AppError('INTERNAL', 502, 'LEDGER_CREDIT_SERVICE_UNKNOWN');
  }
  for (const service of services) {
    if (!service.active && portfolioProducts.has(service.identifier)) {
      throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_SERVICE_INACTIVE');
    }
  }
  for (const serviceId of services.map((service) => service.id).sort()) {
    await lockTariffHistoryService(tx, serviceId);
  }

  const newServiceIds = services
    .filter((service) => !existingSettlements.some((row) => row.serviceId === service.id))
    .map((service) => service.id);
  const teamMembers = await tx.teamMember.findMany({
    where: { teamId: settlementTeamId }, select: { userId: true },
  });
  const resolvedTariffs = new Map();
  for (const serviceId of newServiceIds) {
    const resolved = await resolveBillingTariffForMonth(tx, {
      serviceId,
      organisationId: account.orgId,
      teamId: settlementTeamId,
      billingMonth: params.portfolio.scope.month,
    });
    resolvedTariffs.set(serviceId, resolved.tariff);
  }
  const ratingServices: CreditRatingService[] = services.map((service) => {
    const existing = existingSettlements.find((row) => row.serviceId === service.id);
    const tariff = existing?.tariff ?? resolvedTariffs.get(service.id);
    if (!tariff) throw new AppError('INTERNAL', 500, 'BILLING_DEFAULT_TARIFF_MISSING');
    return {
      id: service.id,
      identifier: service.identifier,
      name: service.name,
      tariff: {
        id: tariff.id,
        mode: tariff.mode,
        markupBps: tariff.markupBps,
        currency: tariff.currency,
      },
    };
  });

  const allocations = existingSettlements.length
    ? await tx.billingCreditUsageAllocation.findMany({
        where: { settlementId: { in: existingSettlements.map((row) => row.id) } },
        orderBy: [{ adjustment: { sequence: 'desc' } }, { id: 'desc' }],
        include: { adjustment: { select: { sequence: true } } },
      })
    : [];
  const latest = latestAllocationMap(allocations);
  const previousAllocations: PreviousCreditAllocation[] = [...latest.values()].map((row) => ({
    serviceId: row.serviceId,
    userId: row.userId,
    consumedMicrocredits: row.consumedMicrocredits,
  }));
  const reservedExports = await tx.billingStripeUsageExport.findMany({
    where: {
      accountId: account.accountId,
      billingMonth: params.portfolio.scope.month,
      subscription: {
        orgId: account.orgId,
        ...(account.teamId ? { OR: [{ teamId: settlementTeamId }, { teamId: null }] } : {}),
      },
    },
    select: { deltaMeterQuantity: true, subscription: { select: { serviceId: true } } },
  });
  const otherSettlements = await tx.billingCreditUsageSettlement.findMany({
    where: {
      creditAccountId: account.id,
      teamId: { not: settlementTeamId },
      billingMonth: params.portfolio.scope.month,
    },
    select: {
      serviceId: true,
      cumulativeRatedUsageAmountMicroMinor: true,
      cumulativeCreditsConsumedMicrocredits: true,
    },
  });
  const gross = rateCreditPortfolio({
    portfolio: params.portfolio,
    services: ratingServices,
    previousAllocations: [],
    balanceMicrocredits: 0n,
    validTeamUserIds: new Set(teamMembers.map((member) => member.userId)),
  });
  const maxAdditionalCreditsByService = new Map<string, bigint>();
  for (const service of gross) {
    const reserved = reservedExports
      .filter((row) => row.subscription.serviceId === service.service.id)
      .reduce((sum, row) => sum + row.deltaMeterQuantity, 0n);
    if (reserved === 0n) continue;
    const other = otherSettlements.filter((row) => row.serviceId === service.service.id);
    const otherGross = other.reduce((sum, row) => sum + row.cumulativeRatedUsageAmountMicroMinor, 0n);
    const otherCredits = other.reduce((sum, row) => sum + row.cumulativeCreditsConsumedMicrocredits / 10n, 0n);
    const currentCredits = previousAllocations
      .filter((row) => row.serviceId === service.service.id)
      .reduce((sum, row) => sum + row.consumedMicrocredits / 10n, 0n);
    const unreserved = service.ratedMicroMinor + otherGross - reserved - otherCredits - currentCredits;
    maxAdditionalCreditsByService.set(service.service.id, unreserved > 0n ? unreserved / 100_000n : 0n);
  }
  const rated = rateCreditPortfolio({
    portfolio: params.portfolio,
    services: ratingServices,
    previousAllocations,
    balanceMicrocredits: account.balanceMicrocredits,
    validTeamUserIds: new Set(teamMembers.map((member) => member.userId)),
    maxAdditionalCreditsByService,
  });

  const settlements = [...existingSettlements];
  for (const service of ratingServices) {
    if (settlements.some((settlement) => settlement.serviceId === service.id)) continue;
    const created = await tx.billingCreditUsageSettlement.create({
      data: {
        accountId: account.accountId,
        creditAccountId: account.id,
        teamId: settlementTeamId,
        tariffId: service.tariff.id,
        serviceId: service.id,
        appKeyId: params.credential.id,
        billingMonth: params.portfolio.scope.month,
        currency: 'USD',
      },
      include: {
        service: true,
        tariff: true,
        adjustments: { orderBy: { sequence: 'desc' }, take: 1 },
      },
    });
    settlements.push(created);
  }

  const replays = await tx.billingCreditUsageSettlementAdjustment.findMany({
    where: {
      portfolioSnapshotId: snapshot.id,
      settlementId: { in: settlements.map((settlement) => settlement.id) },
    },
  });
  if (replays.length !== 0 && replays.length !== settlements.length) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_PARTIAL_SNAPSHOT');
  }
  if (replays.length === settlements.length) {
    for (const replay of replays) {
      const target = rated.find((row) => row.service.id === replay.serviceId);
      if (!target || replay.cumulativeRatedUsageAmountMicroMinor !== target.ratedMicroMinor) {
        throw new AppError('INTERNAL', 502, 'LEDGER_CREDIT_SNAPSHOT_MUTATED');
      }
    }
    return { snapshotId: snapshot.id, replayed: true, superseded: false };
  }

  const work = rated.map((target) => {
    const settlement = settlements.find((row) => row.serviceId === target.service.id);
    if (!settlement) throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_SETTLEMENT_MISSING');
    return { target, settlement };
  });
  work.sort((left, right) => {
    const leftDelta =
      left.target.consumedMicrocredits - left.settlement.cumulativeCreditsConsumedMicrocredits;
    const rightDelta =
      right.target.consumedMicrocredits - right.settlement.cumulativeCreditsConsumedMicrocredits;
    if (leftDelta < 0n !== rightDelta < 0n) return leftDelta < 0n ? -1 : 1;
    return left.target.service.identifier.localeCompare(right.target.service.identifier);
  });
  let balance = account.balanceMicrocredits;
  for (const item of work) {
    balance = await applyRatedCreditService(tx, {
      accountId: account.accountId,
      creditAccountId: account.id,
      snapshotId: snapshot.id,
      capturedAt: snapshot.capturedAt,
      credential: params.credential,
      settlement: item.settlement,
      rated: item.target,
      previous: latest,
      balanceMicrocredits: balance,
    });
  }
  return { snapshotId: snapshot.id, replayed: false, superseded: false };
}

export async function settleCreditPortfolio(
  params: {
    creditAccountId: string;
    portfolio: NormalizedMeteringPortfolio;
    credential: VerifiedBillingAppKey;
  },
  deps?: { prisma?: PrismaClient },
) {
  const prisma = deps?.prisma ?? getAdminPrisma();
  return runBillingSerializableTransaction(
    prisma,
    (tx) => settleInTransaction(tx, params),
    'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED',
  );
}
