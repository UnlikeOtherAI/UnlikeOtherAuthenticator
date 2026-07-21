import {
  BillingCreditAutoTopUpState,
  BillingCreditEntryDirection,
  BillingCreditEntryKind,
} from '@prisma/client';

import type {
  BillingCreditsManagerV1,
  BillingCreditsMemberV1,
  BillingCreditsV1,
} from '../contracts/billing-statement-v1.js';
import { AppError } from '../utils/errors.js';
import type { VerifiedBillingAppKey } from './billing-app-key.service.js';
import {
  billingCreditAmount,
  billingCreditsPaymentMoney,
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
import type { BillingFundingViewer } from './billing-funding-viewer.service.js';

const ACTIONS_UNAVAILABLE = 'Funding actions are not available in this deployment.';

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function service(value: { id: string; identifier: string; name: string }) {
  return { id: value.id, identifier: value.identifier, name: value.name };
}

function autoTopUpState(state: BillingCreditAutoTopUpState) {
  return state.toLowerCase() as Lowercase<BillingCreditAutoTopUpState>;
}

function paymentMethod(data: BillingCreditProjectionData) {
  const account = data.creditAccount;
  const status = !account.stripePaymentMethodId
    ? ('missing' as const)
    : account.autoTopUpState === BillingCreditAutoTopUpState.REQUIRES_ACTION ||
        account.autoTopUpState === BillingCreditAutoTopUpState.NEEDS_REVIEW
      ? ('requires_action' as const)
      : ('ready' as const);
  const summary = account.paymentMethodSummary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return { status, display: status === 'missing' ? 'No payment method saved' : 'Saved payment method' };
  }
  const record = summary as Record<string, unknown>;
  const brand = typeof record.brand === 'string' ? record.brand : 'Card';
  const last4 = typeof record.last4 === 'string' && /^\d{4}$/.test(record.last4)
    ? ` ending in ${record.last4}`
    : '';
  return { status, display: `${brand}${last4}` };
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
          (row) =>
            row.attributedUserId !== null && row.cumulativeCreditsConsumedMicrocredits > 0n,
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
    const viewer = rows.find((row) => row.attributedUserId === viewerId)
      ?.cumulativeCreditsConsumedMicrocredits ?? 0n;
    const unattributed = rows.find((row) => row.attributedUserId === null)
      ?.cumulativeCreditsConsumedMicrocredits ?? 0n;
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

function fundingPolicy(
  data: BillingCreditProjectionData,
  requestBody: { product: string; organisation_id: string; team_id: string; user_id: string },
  manager: boolean,
) {
  const policy = data.policy;
  const catalogs = new Map(data.catalogs.map((row) => [`${row.key}\0${row.version}`, row]));
  return {
    top_up_enabled: policy?.topUpEnabled ?? false,
    automatic_top_up_enabled: policy?.automaticTopUpEnabled ?? false,
    title: 'Add team credits',
    description:
      'Credits fund metered usage across connected services. Subscriptions and add-ons remain separate.',
    offers: (policy?.topUpOffers ?? []).map((offer) => {
      const catalog = catalogs.get(`${offer.catalogKey}\0${offer.catalogVersion}`);
      const configured = Boolean(
        catalog &&
          catalog.stripePriceId &&
          catalog.paymentAmountMinor === offer.paymentAmountMinor &&
          catalog.creditsReceivedMicrocredits === offer.creditsReceivedMicrocredits,
      );
      const available = Boolean(policy?.topUpEnabled && configured);
      return {
        id: offer.id,
        key: offer.key,
        name: offer.name,
        description: offer.description,
        payment_amount: billingCreditsPaymentMoney(offer.paymentAmountMinor),
        credits_received: billingCreditAmount(offer.creditsReceivedMicrocredits),
        available,
        unavailable_reason: available
          ? null
          : policy?.topUpEnabled
            ? 'This offer is not configured for the active Stripe account.'
            : 'Top-ups are disabled for this service.',
        action: manager
          ? {
              id: 'top_up' as const,
              kind: 'hosted_redirect' as const,
              label: `Buy ${billingCreditAmount(offer.creditsReceivedMicrocredits).display}`,
              description: 'Open secure Checkout for this exact UOA-defined offer.',
              enabled: false,
              disabled_reason: ACTIONS_UNAVAILABLE,
              request: {
                method: 'POST' as const,
                path: '/billing/v1/credits/top-up-checkout' as const,
                body: { ...requestBody, offer_id: offer.id },
              },
            }
          : null,
      };
    }),
  };
}

function automaticTopUp(
  data: BillingCreditProjectionData,
  requestBody: { product: string; organisation_id: string; team_id: string; user_id: string },
  manager: boolean,
) {
  const account = data.creditAccount;
  const charged = data.autoTopUpChargedMinor;
  const cap = account.autoTopUpMonthlyChargeCapMinor;
  const remainingCap = cap === null ? null : cap > charged ? cap - charged : 0n;
  const policy = data.policy;
  const state = autoTopUpState(account.autoTopUpState);
  const options = (policy?.autoTopUpOptions ?? []).map((option) => ({
    selected: account.autoTopUpOptionId === option.id,
    label: `${billingCreditAmount(option.refillOffer.creditsReceivedMicrocredits).display} below ${billingCreditAmount(option.thresholdMicrocredits).display}`,
    description: 'A bounded UOA option; products cannot submit arbitrary amounts.',
    threshold: billingCreditAmount(option.thresholdMicrocredits),
    refill_offer_id: option.refillOfferId,
    refill_payment_amount: billingCreditsPaymentMoney(option.refillOffer.paymentAmountMinor),
    refill_credits_received: billingCreditAmount(option.refillOffer.creditsReceivedMicrocredits),
    monthly_cap: billingCreditsPaymentMoney(option.monthlyChargeCapMinor),
    setup_action: manager
      ? {
          id: 'auto_top_up_setup' as const,
          kind: 'hosted_redirect' as const,
          label: 'Set up automatic top-up',
          description: 'Review and consent to this exact option in secure Checkout.',
          enabled: false,
          disabled_reason: ACTIONS_UNAVAILABLE,
          request: {
            method: 'POST' as const,
            path: '/billing/v1/credits/auto-top-up/setup' as const,
            body: { ...requestBody, option_id: option.id },
          },
        }
      : null,
    update_action: manager
      ? {
          id: 'auto_top_up_update' as const,
          kind: 'mutation' as const,
          label: 'Use this automatic top-up option',
          description: 'Select this UOA-defined threshold, refill, and cap.',
          enabled: false,
          disabled_reason: ACTIONS_UNAVAILABLE,
          request: {
            method: 'POST' as const,
            path: '/billing/v1/credits/auto-top-up/update' as const,
            body: { ...requestBody, option_id: option.id },
          },
        }
      : null,
  }));
  const base = {
    state,
    display_status: `Automatic top-up is ${state.replaceAll('_', ' ')}`,
    description:
      state === 'disabled'
        ? 'Automatic top-up is not enabled for this team.'
        : 'UOA applies the saved threshold, refill offer, and monthly charge cap.',
    threshold:
      account.autoTopUpThresholdMicrocredits === null
        ? null
        : billingCreditAmount(account.autoTopUpThresholdMicrocredits),
    refill_offer_id: account.autoTopUpRefillOfferId,
    monthly_cap: cap === null ? null : billingCreditsPaymentMoney(cap),
    charged_this_month: billingCreditsPaymentMoney(charged),
    remaining_monthly_cap:
      remainingCap === null ? null : billingCreditsPaymentMoney(remainingCap),
    payment_method: manager
      ? paymentMethod(data)
      : { status: paymentMethod(data).status },
    consent: manager
      ? {
          status: !account.autoTopUpConsentVersion
            ? ('missing' as const)
            : account.autoTopUpConsentVersion === policy?.automaticConsentVersion
              ? ('current' as const)
              : ('outdated' as const),
          version: account.autoTopUpConsentVersion,
          consented_at: account.autoTopUpConsentedAt?.toISOString() ?? null,
          consented_by: account.autoTopUpConsentedBy
            ? { display_name: account.autoTopUpConsentedBy.name ?? 'Team member' }
            : null,
          description: 'Consent covers the saved threshold, refill offer, and monthly cap.',
        }
      : {
          status: !account.autoTopUpConsentVersion
            ? ('missing' as const)
            : account.autoTopUpConsentVersion === policy?.automaticConsentVersion
              ? ('current' as const)
              : ('outdated' as const),
          version: account.autoTopUpConsentVersion,
          consented_at: account.autoTopUpConsentedAt?.toISOString() ?? null,
        },
    options,
    disable_action: null,
    recover_action: null,
  };
  return base;
}

type RequestSubject = {
  product: string;
  organisation_id: string;
  team_id: string;
  user_id: string;
};

function managerFundingPolicy(data: BillingCreditProjectionData, body: RequestSubject) {
  return fundingPolicy(data, body, true) as BillingCreditsManagerV1['funding_policy'];
}

function memberFundingPolicy(data: BillingCreditProjectionData, body: RequestSubject) {
  return fundingPolicy(data, body, false) as BillingCreditsMemberV1['funding_policy'];
}

function managerAutomaticTopUp(data: BillingCreditProjectionData, body: RequestSubject) {
  return automaticTopUp(data, body, true) as BillingCreditsManagerV1['automatic_top_up'];
}

function memberAutomaticTopUp(data: BillingCreditProjectionData, body: RequestSubject) {
  return automaticTopUp(data, body, false) as BillingCreditsMemberV1['automatic_top_up'];
}

export function buildBillingCreditsProjection(params: {
  credential: VerifiedBillingAppKey;
  collection: CreditCollectionContext;
  viewer: BillingFundingViewer;
  period: BillingCreditPeriod;
  data: BillingCreditProjectionData;
  now: Date;
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
            BillingCreditEntryKind.ADJUSTMENT,
          ].some((kind: BillingCreditEntryKind) => kind === entry.kind),
      )
      .map((entry) => entry.amountMicrocredits),
  );
  const creditsConsumed = sum(
    data.settlements.map((settlement) => settlement.cumulativeCreditsConsumedMicrocredits),
  );
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
    capabilities: {
      can_top_up: false as const,
      can_manage_automatic_top_up: false as const,
    },
    conversion: {
      credits_per_usd: '1000' as const,
      settlement_currency: 'USD' as const,
      description: '1,000 credits always equal US$1.00; one cent always equals 10 credits.',
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
      state: data.creditAccount.balanceMicrocredits > 0n
        ? ('available' as const)
        : data.creditAccount.balanceMicrocredits < 0n
          ? ('debt' as const)
          : ('zero' as const),
      label: 'Remaining credits' as const,
      description: 'This balance is shared by the exact team across connected services.',
    },
    pending_credits: {
      top_up_count: pendingCount,
      payment_amount: billingCreditsPaymentMoney(pendingPayment),
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
    return {
      ...common,
      viewer: {
        role: 'billing_manager',
        usage_visibility: 'full_team',
        description: 'This viewer may see the full team breakdown and manage funding.',
      },
      funding_policy: managerFundingPolicy(data, requestBody),
      automatic_top_up: managerAutomaticTopUp(data, requestBody),
      credit_summary: { ...summary, consumed_breakdown: managerBreakdown(data) },
      recent_entries: buildManagerCreditRecentEntries(data),
    } satisfies BillingCreditsManagerV1;
  }
  return {
    ...common,
    viewer: {
      role: 'member',
      usage_visibility: 'own_plus_team_aggregate',
      description: 'This viewer may see their usage and privacy-safe team aggregates.',
    },
    funding_policy: memberFundingPolicy(data, requestBody),
    automatic_top_up: memberAutomaticTopUp(data, requestBody),
    credit_summary: {
      ...summary,
      consumed_breakdown: memberBreakdown(data, viewer.userId),
    },
    recent_entries: buildMemberCreditRecentEntries(data, viewer.userId),
  } satisfies BillingCreditsMemberV1;
}
