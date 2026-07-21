import {
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';

import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import type { RatedCreditService } from './billing-credit-rating.service.js';

type SettlementRow = Prisma.BillingCreditUsageSettlementGetPayload<{
  include: { service: true; tariff: true; adjustments: true };
}>;

export type LatestCreditAllocation = {
  serviceId: string;
  userId: string | null;
  ratedMicroMinor: bigint;
  consumedMicrocredits: bigint;
  remainingMicroMinor: bigint;
};

export async function applyRatedCreditService(
  tx: Prisma.TransactionClient,
  params: {
    accountId: string;
    creditAccountId: string;
    snapshotId: string;
    capturedAt: Date;
    credential: VerifiedBillingAppKey;
    settlement: SettlementRow;
    rated: RatedCreditService;
    previous: Map<string, LatestCreditAllocation>;
    balanceMicrocredits: bigint;
  },
): Promise<bigint> {
  const settlement = params.settlement;
  const deltaRated = params.rated.ratedMicroMinor - settlement.cumulativeRatedUsageAmountMicroMinor;
  const deltaCredits =
    params.rated.consumedMicrocredits - settlement.cumulativeCreditsConsumedMicrocredits;
  const deltaRemaining =
    params.rated.remainingMicroMinor - settlement.cumulativeRemainingUsageAmountMicroMinor;
  const adjustmentId = `bcsa_${randomUUID()}`;
  const previousSequence = settlement.adjustments[0]?.sequence ?? 0;
  let balance = params.balanceMicrocredits;
  let creditEntryId: string | null = null;

  if (deltaCredits !== 0n) {
    creditEntryId = `bce_${randomUUID()}`;
    balance -= deltaCredits;
    await tx.billingCreditEntry.create({
      data: {
        id: creditEntryId,
        creditAccountId: params.creditAccountId,
        serviceId: params.rated.service.id,
        appKeyId: params.credential.id,
        attributedUserId: null,
        direction:
          deltaCredits > 0n
            ? BillingCreditEntryDirection.DEBIT
            : BillingCreditEntryDirection.CREDIT,
        kind:
          settlement.cumulativeRatedUsageAmountMicroMinor === 0n &&
          settlement.cumulativeCreditsConsumedMicrocredits === 0n &&
          settlement.cumulativeRemainingUsageAmountMicroMinor === 0n
            ? BillingCreditEntryKind.USAGE_SETTLEMENT
            : BillingCreditEntryKind.USAGE_SETTLEMENT_CORRECTION,
        amountMicrocredits: deltaCredits < 0n ? -deltaCredits : deltaCredits,
        balanceAfterMicrocredits: balance,
        currency: 'USD',
        idempotencyKey: `credit-usage:${settlement.id}:${params.snapshotId}`,
        sourceType: 'credit_usage_settlement_adjustment',
        sourceId: adjustmentId,
        occurredAt: params.capturedAt,
      },
    });
  }

  const adjustment = await tx.billingCreditUsageSettlementAdjustment.create({
    data: {
      id: adjustmentId,
      settlementId: settlement.id,
      accountId: params.accountId,
      creditAccountId: params.creditAccountId,
      serviceId: params.rated.service.id,
      appKeyId: params.credential.id,
      portfolioSnapshotId: params.snapshotId,
      sequence: previousSequence + 1,
      deltaRatedUsageAmountMicroMinor: deltaRated,
      deltaCreditsConsumedMicrocredits: deltaCredits,
      deltaRemainingUsageAmountMicroMinor: deltaRemaining,
      cumulativeRatedUsageAmountMicroMinor: params.rated.ratedMicroMinor,
      cumulativeCreditsConsumedMicrocredits: params.rated.consumedMicrocredits,
      cumulativeRemainingUsageAmountMicroMinor: params.rated.remainingMicroMinor,
      creditEntryId,
    },
  });

  const targetByUser = new Map(params.rated.allocations.map((row) => [row.userId, row]));
  const previousForService = [...params.previous.values()].filter(
    (row) => row.serviceId === params.rated.service.id,
  );
  const users = new Set([...targetByUser.keys(), ...previousForService.map((row) => row.userId)]);
  for (const userId of users) {
    const target = targetByUser.get(userId) ?? {
      userId,
      ratedMicroMinor: 0n,
      consumedMicrocredits: 0n,
      remainingMicroMinor: 0n,
    };
    const old = previousForService.find((row) => row.userId === userId);
    const allocationDeltaRated = target.ratedMicroMinor - (old?.ratedMicroMinor ?? 0n);
    const allocationDeltaCredits =
      target.consumedMicrocredits - (old?.consumedMicrocredits ?? 0n);
    const allocationDeltaRemaining =
      target.remainingMicroMinor - (old?.remainingMicroMinor ?? 0n);
    if (
      allocationDeltaRated === 0n &&
      allocationDeltaCredits === 0n &&
      allocationDeltaRemaining === 0n
    ) {
      continue;
    }
    await tx.billingCreditUsageAllocation.create({
      data: {
        settlementId: settlement.id,
        adjustmentId: adjustment.id,
        serviceId: params.rated.service.id,
        appKeyId: params.credential.id,
        attributedUserId: userId,
        deltaRatedUsageAmountMicroMinor: allocationDeltaRated,
        deltaCreditsConsumedMicrocredits: allocationDeltaCredits,
        deltaRemainingUsageAmountMicroMinor: allocationDeltaRemaining,
        cumulativeRatedUsageAmountMicroMinor: target.ratedMicroMinor,
        cumulativeCreditsConsumedMicrocredits: target.consumedMicrocredits,
        cumulativeRemainingUsageAmountMicroMinor: target.remainingMicroMinor,
      },
    });
  }
  return balance;
}
