import { BillingCreditEntryDirection, BillingCreditEntryKind } from '@prisma/client';

import type {
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
  BillingCreditsV1,
} from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  buildManagerCreditActionsProjection,
  buildMemberCreditActionsProjection,
} from './billing-credit-action-projection.service.js';
import {
  billingCreditAmount,
  billingCreditsPaymentMoney,
  billingWholeCredits,
} from './billing-credit-display.service.js';
import {
  buildManagerCreditRecentEntries,
  buildMemberCreditRecentEntries,
} from './billing-credit-entry-projection.service.js';
import type {
  BillingCreditPeriod,
  BillingCreditProjectionData,
} from './billing-credit-projection-data.service.js';
import type { CreditCollectionContext } from './billing-credit-account.service.js';
import {
  unavailableBillingCreditActions,
  type BillingCreditActionReadiness,
} from './billing-credit-action-readiness.service.js';
import type { BillingFundingViewer } from './billing-funding-viewer.service.js';

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function service(value: { id: string; identifier: string; name: string }) {
  return { id: value.id, identifier: value.identifier, name: value.name };
}

function latestAllocations(data: BillingCreditProjectionData) {
  const rows = new Map<string, BillingCreditProjectionData['allocations'][number]>();
  for (const allocation of data.allocations) {
    const key = `${allocation.settlementId}\0${allocation.attributedUserId ?? '\uffff'}`;
    if (!rows.has(key)) rows.set(key, allocation);
  }
  return [...rows.values()];
}

function managerBreakdown(data: BillingCreditProjectionData) {
  const allocations = latestAllocations(data);
  return data.settlements.map((settlement) => {
    const rows = allocations.filter((row) => row.settlementId === settlement.id);
    return {
      service: service(settlement.service),
      credits_consumed: billingCreditAmount(settlement.cumulativeCreditsConsumedMicrocredits),
      unattributed_credits_consumed: billingCreditAmount(
        rows.find((row) => row.attributedUserId === null)?.cumulativeCreditsConsumedMicrocredits ??
          0n,
      ),
      users: rows
        .filter(
          (row) => row.attributedUserId !== null && row.cumulativeCreditsConsumedMicrocredits > 0n,
        )
        .sort((left, right) =>
          (left.attributedUser?.name ?? left.attributedUserId ?? '').localeCompare(
            right.attributedUser?.name ?? right.attributedUserId ?? '',
          ),
        )
        .map((row) => {
          if (!row.attributedUserId) {
            throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_ALLOCATION_INVALID');
          }
          return {
            user_id: row.attributedUserId,
            display_name: row.attributedUser?.name ?? 'Team member',
            credits_consumed: billingCreditAmount(row.cumulativeCreditsConsumedMicrocredits),
          };
        }),
    };
  });
}

function memberBreakdown(data: BillingCreditProjectionData, viewerId: string) {
  const allocations = latestAllocations(data);
  return data.settlements.map((settlement) => {
    const rows = allocations.filter((row) => row.settlementId === settlement.id);
    const viewer =
      rows.find((row) => row.attributedUserId === viewerId)
        ?.cumulativeCreditsConsumedMicrocredits ?? 0n;
    const unattributed =
      rows.find((row) => row.attributedUserId === null)?.cumulativeCreditsConsumedMicrocredits ??
      0n;
    const other = settlement.cumulativeCreditsConsumedMicrocredits - viewer - unattributed;
    if (other < 0n) {
      throw new AppError('INTERNAL', 500, 'BILLING_CREDIT_ALLOCATION_INVALID');
    }
    return {
      service: service(settlement.service),
      credits_consumed: billingCreditAmount(settlement.cumulativeCreditsConsumedMicrocredits),
      viewer_credits_consumed: billingCreditAmount(viewer),
      other_team_members_credits_consumed: billingCreditAmount(other),
      unattributed_credits_consumed: billingCreditAmount(unattributed),
    };
  });
}

export function buildBillingCreditsProjection(params: {
  credential: VerifiedBillingAppKey;
  collection: CreditCollectionContext;
  viewer: BillingFundingViewer;
  period: BillingCreditPeriod;
  data: BillingCreditProjectionData;
  now: Date;
  actionReadiness?: BillingCreditActionReadiness;
}): BillingCreditsV1 {
  const { data, viewer } = params;
  const pendingCount = data.pending.length;
  const pendingPayment = sum(data.pending.map((row) => row.paymentAmountMinor));
  const pendingCredits = sum(data.pending.map((row) => row.creditsReceivedMicrocredits));
  const creditsAdded = sum(
    data.periodEntries
      .filter(
        (entry) =>
          entry.direction === BillingCreditEntryDirection.CREDIT &&
          [
            BillingCreditEntryKind.TOP_UP,
            BillingCreditEntryKind.AUTOMATIC_TOP_UP,
            BillingCreditEntryKind.REFUND_REVERSAL,
            BillingCreditEntryKind.DISPUTE_REVERSAL,
            BillingCreditEntryKind.ADJUSTMENT,
          ].some((kind: BillingCreditEntryKind) => kind === entry.kind),
      )
      .map((entry) => entry.amountMicrocredits),
  );
  const creditsConsumed = sum(
    data.settlements.map((settlement) => settlement.cumulativeCreditsConsumedMicrocredits),
  );
  const wholeCreditBalance = billingWholeCredits(data.creditAccount.balanceMicrocredits);
  const requestBody = {
    product: params.credential.service.identifier,
    organisation_id: viewer.organisationId,
    team_id: viewer.teamId,
    user_id: viewer.userId,
  };
  const common = {
    schema_version: 1 as const,
    credit_account_id: data.creditAccount.id,
    generated_at: params.now.toISOString(),
    storefront: service(params.credential.service),
    subject: {
      user_id: viewer.userId,
      organisation_id: viewer.organisationId,
      team_id: viewer.teamId,
    },
    conversion: {
      credits_per_usd: '1000' as const,
      settlement_currency: 'USD' as const,
      description:
        '1,000 credits always equal US$1.00. Usage is accumulated exactly, but only complete credits are deducted.',
    },
    current_period: {
      starts_at: params.period.startsAt.toISOString(),
      ends_at: params.period.endsAt.toISOString(),
    },
    collection: {
      stripe_collection_enabled: params.collection.stripeCollectionEnabled,
      stripe_mode: params.collection.account.livemode ? ('live' as const) : ('test' as const),
    },
    credit_balance: {
      ...billingCreditAmount(data.creditAccount.balanceMicrocredits),
      state:
        wholeCreditBalance > 0n
          ? ('available' as const)
          : wholeCreditBalance < 0n
            ? ('debt' as const)
            : ('zero' as const),
      label: 'Remaining credits' as const,
      description: 'This balance is shared by the exact team across connected services.',
    },
    pending_credits: {
      top_up_count: pendingCount,
      credits_received: billingCreditAmount(pendingCredits),
      label: pendingCount === 1 ? 'One top-up pending' : `${pendingCount} top-ups pending`,
      description:
        'Pending credits await verified payment and are not included in remaining credits.',
    },
  };
  const summary = {
    credits_added: billingCreditAmount(creditsAdded),
    credits_consumed: billingCreditAmount(creditsConsumed),
    pending_credits: billingCreditAmount(pendingCredits),
  };
  if (viewer.billingManager) {
    const actions = buildManagerCreditActionsProjection(
      data,
      requestBody,
      params.collection.stripeCollectionEnabled,
      params.actionReadiness ?? unavailableBillingCreditActions(),
    );
    const funding = actions.funding_policy;
    const automatic = actions.automatic_top_up;
    return {
      ...common,
      capabilities: {
        can_top_up: funding.offers.some((offer) => offer.action.enabled),
        can_manage_automatic_top_up:
          automatic.options.some(
            (option) => option.setup_action.enabled || option.update_action.enabled,
          ) || Boolean(automatic.disable_action?.enabled || automatic.recover_action?.enabled),
      },
      viewer: {
        role: 'billing_manager',
        usage_visibility: 'full_team',
        description: 'This viewer may see the full team breakdown and manage funding.',
      },
      pending_credits: {
        ...common.pending_credits,
        payment_amount: billingCreditsPaymentMoney(pendingPayment),
      },
      funding_policy: funding,
      automatic_top_up: automatic,
      credit_summary: { ...summary, consumed_breakdown: managerBreakdown(data) },
      recent_entries: buildManagerCreditRecentEntries(data),
    } satisfies BillingCreditsManagerV1;
  }
  const actions = buildMemberCreditActionsProjection(data);
  return {
    ...common,
    pending_credits: { ...common.pending_credits, payment_amount: null },
    capabilities: {
      can_top_up: false,
      can_manage_automatic_top_up: false,
    },
    viewer: {
      role: 'member',
      usage_visibility: 'own_plus_team_aggregate',
      description: 'This viewer may see their usage and privacy-safe team aggregates.',
    },
    funding_policy: actions.funding_policy,
    automatic_top_up: actions.automatic_top_up,
    credit_summary: {
      ...summary,
      consumed_breakdown: memberBreakdown(data, viewer.userId),
    },
    recent_entries: buildMemberCreditRecentEntries(data, viewer.userId),
  } satisfies BillingCreditsMemberV1;
}
