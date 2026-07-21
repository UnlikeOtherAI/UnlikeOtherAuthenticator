import {
  BillingAssignmentScope,
  Prisma,
  type PrismaClient,
} from '@prisma/client';

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

function isRetryableTransactionError(error: unknown): boolean {
  const candidate = error as { code?: unknown; meta?: { code?: unknown } } | null;
  return (
    candidate?.code === 'P2034' ||
    (candidate?.code === 'P2010' && candidate.meta?.code === '40001')
  );
}

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

function assignmentTariffs(
  services: Array<{ id: string }>,
  assignments: Array<
    Prisma.BillingTariffAssignmentGetPayload<{ include: { tariff: true } }>
  >,
  defaults: Prisma.BillingTariffGetPayload<Record<string, never>>[],
): Map<string, Prisma.BillingTariffGetPayload<Record<string, never>>> {
  const selected = new Map<string, Prisma.BillingTariffGetPayload<Record<string, never>>>();
  for (const service of services) {
    const team = assignments.find(
      (assignment) =>
        assignment.serviceId === service.id && assignment.scope === BillingAssignmentScope.TEAM,
    );
    const organisation = assignments.find(
      (assignment) =>
        assignment.serviceId === service.id &&
        assignment.scope === BillingAssignmentScope.ORGANISATION,
    );
    const tariff = team?.tariff ?? organisation?.tariff ?? defaults.find(
      (candidate) => candidate.serviceId === service.id,
    );
    if (!tariff) throw new AppError('INTERNAL', 500, 'BILLING_DEFAULT_TARIFF_MISSING');
    selected.set(service.id, tariff);
  }
  return selected;
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
  if (
    account.orgId !== params.portfolio.scope.organizationId ||
    account.teamId !== params.portfolio.scope.teamId ||
    account.currency !== 'USD'
  ) {
    throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_PORTFOLIO_SCOPE_MISMATCH');
  }

  const perspectiveService = await tx.billingService.findUnique({
    where: { identifier: params.portfolio.perspectiveProduct },
  });
  if (!perspectiveService) {
    throw new AppError('INTERNAL', 502, 'LEDGER_CREDIT_PERSPECTIVE_UNKNOWN');
  }
  let snapshot = await tx.billingCreditPortfolioSnapshot.findUnique({
    where: {
      creditAccountId_ledgerSnapshotCursor: {
        creditAccountId: account.id,
        ledgerSnapshotCursor: params.portfolio.snapshot.cursor,
      },
    },
  });
  if (snapshot) {
    assertExistingSnapshot(snapshot, {
      accountId: account.accountId,
      creditAccountId: account.id,
      organisationId: account.orgId,
      teamId: account.teamId,
      perspectiveServiceId: perspectiveService.id,
      portfolio: params.portfolio,
    });
  } else {
    snapshot = await tx.billingCreditPortfolioSnapshot.create({
      data: {
        accountId: account.accountId,
        creditAccountId: account.id,
        orgId: account.orgId,
        teamId: account.teamId,
        perspectiveServiceId: perspectiveService.id,
        perspectiveProduct: params.portfolio.perspectiveProduct,
        billingMonth: params.portfolio.scope.month,
        contract: 'metering-portfolio-v1',
        groupBy: 'user',
        ledgerSnapshotId: params.portfolio.snapshot.id,
        ledgerSnapshotCursor: params.portfolio.snapshot.cursor,
        capturedAt: new Date(params.portfolio.snapshot.capturedAt),
        sha256: params.portfolio.snapshot.sha256,
      },
    });
  }

  const existingSettlements = await tx.billingCreditUsageSettlement.findMany({
    where: { creditAccountId: account.id, billingMonth: params.portfolio.scope.month },
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
  if (services.length !== new Set([...portfolioProducts, ...existingSettlements.map(
    (settlement) => settlement.service.identifier,
  )]).size) {
    throw new AppError('INTERNAL', 502, 'LEDGER_CREDIT_SERVICE_UNKNOWN');
  }
  for (const service of services) {
    if (!service.active && portfolioProducts.has(service.identifier)) {
      throw new AppError('INTERNAL', 409, 'BILLING_CREDIT_SERVICE_INACTIVE');
    }
  }

  const newServiceIds = services
    .filter((service) => !existingSettlements.some((row) => row.serviceId === service.id))
    .map((service) => service.id);
  const [assignments, defaults, teamMembers] = await Promise.all([
    tx.billingTariffAssignment.findMany({
      where: {
        serviceId: { in: newServiceIds },
        orgId: account.orgId,
        OR: [
          {
            scope: BillingAssignmentScope.TEAM,
            teamId: account.teamId,
            scopeKey: `${account.orgId}:${account.teamId}`,
          },
          {
            scope: BillingAssignmentScope.ORGANISATION,
            teamId: null,
            scopeKey: account.orgId,
          },
        ],
      },
      include: { tariff: true },
    }),
    tx.billingTariff.findMany({
      where: { serviceId: { in: newServiceIds }, isDefault: true },
    }),
    tx.teamMember.findMany({ where: { teamId: account.teamId }, select: { userId: true } }),
  ]);
  const resolvedTariffs = assignmentTariffs(
    services.filter((service) => newServiceIds.includes(service.id)),
    assignments,
    defaults,
  );
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
  const rated = rateCreditPortfolio({
    portfolio: params.portfolio,
    services: ratingServices,
    previousAllocations,
    balanceMicrocredits: account.balanceMicrocredits,
    validTeamUserIds: new Set(teamMembers.map((member) => member.userId)),
  });

  const settlements = [...existingSettlements];
  for (const service of ratingServices) {
    if (settlements.some((settlement) => settlement.serviceId === service.id)) continue;
    const created = await tx.billingCreditUsageSettlement.create({
      data: {
        accountId: account.accountId,
        creditAccountId: account.id,
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
    return { snapshotId: snapshot.id, replayed: true };
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
    if ((leftDelta < 0n) !== (rightDelta < 0n)) return leftDelta < 0n ? -1 : 1;
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
  return { snapshotId: snapshot.id, replayed: false };
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction((tx) => settleInTransaction(tx, params), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      if (!isRetryableTransactionError(error) || attempt === 2) throw error;
    }
  }
  throw new AppError('INTERNAL', 503, 'BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED');
}
