import { BillingCreditEntryDirection, BillingCreditEntryKind } from '@prisma/client';

import type {
  BillingControlledByV1,
  BillingCreditAttentionV1,
  BillingCreditFundingRequestActionV1,
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
} from './billing-credit-display.service.js';
import { billingLocalizedCreditDisplay } from './billing-credit-copy.catalog.js';
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
import type { BillingCustomerLocale } from './billing-copy-locale.js';
import { billingCreditCopy, billingPendingCreditsLabel } from './billing-credit-copy.catalog.js';

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function creditAmount(value: bigint, locale?: BillingCustomerLocale) {
  const amount = billingCreditAmount(value, locale);
  return { ...amount, display: billingLocalizedCreditDisplay(amount.credits, locale) };
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

function prepaidByService(data: BillingCreditProjectionData) {
  const grouped = new Map<string, {
    service: { id: string; identifier: string; name: string };
    total: bigint;
    users: Map<string, bigint>;
  }>();
  for (const row of data.prepaidReservations) {
    if (row.status !== 'SETTLED') continue;
    const product = row.tariff.service;
    const item = grouped.get(product.id) ?? { service: product, total: 0n,
      users: new Map<string, bigint>() };
    const amount = row.debitedMicrocredits ?? 0n;
    item.total += amount;
    item.users.set(row.userId, (item.users.get(row.userId) ?? 0n) + amount);
    grouped.set(product.id, item);
  }
  return [...grouped.values()].sort((a, b) =>
    a.service.identifier.localeCompare(b.service.identifier));
}

function managerBreakdown(data: BillingCreditProjectionData, locale?: BillingCustomerLocale) {
  const allocations = latestAllocations(data);
  const settled = data.settlements.map((settlement) => {
    const rows = allocations.filter((row) => row.settlementId === settlement.id);
    return {
      service: service(settlement.service),
      credits_consumed: creditAmount(settlement.cumulativeCreditsConsumedMicrocredits, locale),
      unattributed_credits_consumed: creditAmount(
        rows.find((row) => row.attributedUserId === null)?.cumulativeCreditsConsumedMicrocredits ??
          0n,
        locale,
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
            display_name: row.attributedUser?.name ?? billingCreditCopy(locale).teamMember,
            credits_consumed: creditAmount(row.cumulativeCreditsConsumedMicrocredits, locale),
          };
        }),
    };
  });
  const prepaid = prepaidByService(data).map((row) => ({
    service: service(row.service),
    credits_consumed: creditAmount(row.total, locale),
    unattributed_credits_consumed: creditAmount(0n, locale),
    users: [...row.users.entries()].map(([userId, amount]) => ({
      user_id: userId,
      display_name: data.entries.find((entry) => entry.attributedUserId === userId)
        ?.attributedUser?.name ?? billingCreditCopy(locale).teamMember,
      credits_consumed: creditAmount(amount, locale),
    })),
  }));
  return [...settled, ...prepaid];
}

function memberBreakdown(data: BillingCreditProjectionData, viewerId: string, locale?: BillingCustomerLocale) {
  const allocations = latestAllocations(data);
  const settled = data.settlements.map((settlement) => {
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
      credits_consumed: creditAmount(settlement.cumulativeCreditsConsumedMicrocredits, locale),
      viewer_credits_consumed: creditAmount(viewer, locale),
      other_team_members_credits_consumed: creditAmount(other, locale),
      unattributed_credits_consumed: creditAmount(unattributed, locale),
    };
  });
  const prepaid = prepaidByService(data).map((row) => {
    const viewer = row.users.get(viewerId) ?? 0n;
    return { service: service(row.service),
      credits_consumed: creditAmount(row.total, locale),
      viewer_credits_consumed: creditAmount(viewer, locale),
      other_team_members_credits_consumed: creditAmount(row.total - viewer, locale),
      unattributed_credits_consumed: creditAmount(0n, locale) };
  });
  return [...settled, ...prepaid];
}

export function buildBillingCreditsProjection(params: {
  credential: VerifiedBillingAppKey;
  collection: CreditCollectionContext;
  viewer: BillingFundingViewer;
  period: BillingCreditPeriod;
  data: BillingCreditProjectionData;
  now: Date;
  actionReadiness?: BillingCreditActionReadiness;
  controlledBy?: BillingControlledByV1 | null;
  locale?: BillingCustomerLocale;
  attention?: BillingCreditAttentionV1[];
  fundingRequest?: BillingCreditFundingRequestActionV1;
  settlementPending?: boolean;
}): BillingCreditsV1 {
  const { data, viewer } = params;
  const controlledBy = params.controlledBy ?? null;
  // While the organisation is paying, a team billing manager has nothing on
  // this surface to manage. They get the member shape — no offers, no options,
  // no actions at all — so a consumer that predates `controlled_by` renders a
  // read-only balance instead of controls that would 403. An organisation
  // billing manager keeps the full shape: the actions resolve to the
  // organisation's own credit account.
  const canFund = controlledBy === null ? viewer.billingManager : controlledBy.can_manage;
  const pendingCount = data.pending.length;
  const pendingPayment = sum(data.pending.map((row) => row.paymentAmountMinor));
  const pendingCredits = sum(data.pending.map((row) => row.creditsReceivedMicrocredits));
  const copy = billingCreditCopy(params.locale);
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
    [...data.settlements.map((settlement) => settlement.cumulativeCreditsConsumedMicrocredits),
      ...data.prepaidReservations.filter((row) => row.status === 'SETTLED')
        .map((row) => row.debitedMicrocredits ?? 0n)],
  );
  const availableBalance = data.creditAccount.balanceMicrocredits -
    data.activeReservedMicrocredits;
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
      description: copy.conversionDescription,
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
      ...creditAmount(availableBalance, params.locale),
      state:
        availableBalance > 0n
          ? ('available' as const)
          : availableBalance < 0n
            ? ('debt' as const)
            : ('zero' as const),
      label: copy.balanceLabel,
      description: data.creditAccount.scope === 'ORGANISATION'
        ? copy.organisationBalanceDescription : copy.balanceDescription,
    },
    pending_credits: {
      top_up_count: pendingCount,
      credits_received: creditAmount(pendingCredits, params.locale),
      label: billingPendingCreditsLabel(pendingCount, params.locale),
      description: copy.pendingCreditsDescription,
    },
    ...(controlledBy ? { controlled_by: controlledBy } : {}),
    ...(params.attention ? { attention: params.attention } : {}),
    ...(params.fundingRequest ? { funding_request: params.fundingRequest } : {}),
    ...(params.settlementPending ? {
      billing_status: {
        settlement_state: 'pending_reconciliation' as const,
        message: copy.pendingSettlementDescription,
      },
    } : {}),
  };
  const summary = {
    credits_added: creditAmount(creditsAdded, params.locale),
    credits_consumed: creditAmount(creditsConsumed, params.locale),
    pending_credits: creditAmount(pendingCredits, params.locale),
  };
  if (canFund) {
    const actions = buildManagerCreditActionsProjection(
      data,
      requestBody,
      params.collection.stripeCollectionEnabled,
      params.actionReadiness ?? unavailableBillingCreditActions(),
      params.period.endsAt,
      params.locale,
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
        description: copy.managerViewerDescription,
      },
      pending_credits: {
        ...common.pending_credits,
        payment_amount: billingCreditsPaymentMoney(pendingPayment, params.locale),
      },
      funding_policy: funding,
      automatic_top_up: automatic,
      credit_summary: { ...summary, consumed_breakdown: managerBreakdown(data, params.locale) },
      recent_entries: buildManagerCreditRecentEntries(data, params.locale),
    } satisfies BillingCreditsManagerV1;
  }
  const actions = buildMemberCreditActionsProjection(
    data,
    params.actionReadiness ?? unavailableBillingCreditActions(),
    params.locale,
  );
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
      description: copy.memberViewerDescription,
    },
    funding_policy: actions.funding_policy,
    automatic_top_up: actions.automatic_top_up,
    credit_summary: {
      ...summary,
      consumed_breakdown: memberBreakdown(data, viewer.userId, params.locale),
    },
    recent_entries: buildMemberCreditRecentEntries(data, viewer.userId, params.locale),
  } satisfies BillingCreditsMemberV1;
}
