import type { ExactMoney } from './types.js';
import type { BillingSubjectRequest } from './funding-schema-primitives.js';

export const BILLING_CREDITS_SCHEMA_VERSION = 1 as const;
export const BILLING_CREDITS_PROTOCOL_VERSION = '1.0.0' as const;
export const BILLING_CREDITS_SCHEMA_PATH = '/schemas/billing-credits-v1.json' as const;
export const BILLING_CREDITS_EXAMPLE_PATH = '/schemas/billing-credits-v1.example.json' as const;
export const BILLING_CREDITS_OPENAPI_PATH = '/schemas/billing-credits-v1.openapi.json' as const;
export const BILLING_CREDITS_READ_PATH = '/billing/v1/credits' as const;
export const BILLING_CREDITS_TOP_UP_PATH = '/billing/v1/credits/top-up-checkout' as const;
export const BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH =
  '/billing/v1/credits/auto-top-up/setup' as const;
export const BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH =
  '/billing/v1/credits/auto-top-up/update' as const;
export const BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH =
  '/billing/v1/credits/auto-top-up/disable' as const;
export const BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH =
  '/billing/v1/credits/auto-top-up/recover' as const;

export type BillingCreditAmount = {
  credits: string;
  display: string;
  usd_equivalent: ExactMoney & { currency: 'USD' };
};

export type BillingCreditsPaymentMoney = ExactMoney & {
  amount_minor: string;
  currency: 'USD';
};

type BillingCreditsActionBase = {
  label: string;
  description: string;
  enabled: boolean;
  disabled_reason: string | null;
};

export type BillingCreditsTopUpAction = BillingCreditsActionBase & {
  id: 'top_up';
  kind: 'hosted_redirect';
  request: {
    method: 'POST';
    path: typeof BILLING_CREDITS_TOP_UP_PATH;
    body: BillingSubjectRequest & { offer_id: string };
  };
};

export type BillingCreditsAutoTopUpSetupAction = BillingCreditsActionBase & {
  id: 'auto_top_up_setup';
  kind: 'hosted_redirect';
  request: {
    method: 'POST';
    path: typeof BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH;
    body: BillingSubjectRequest & { option_id: string };
  };
};

export type BillingCreditsAutoTopUpUpdateAction = BillingCreditsActionBase & {
  id: 'auto_top_up_update';
  kind: 'mutation';
  request: {
    method: 'POST';
    path: typeof BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH;
    body: BillingSubjectRequest & { option_id: string };
  };
};

export type BillingCreditsAutoTopUpDisableAction = BillingCreditsActionBase & {
  id: 'auto_top_up_disable';
  kind: 'mutation';
  request: {
    method: 'POST';
    path: typeof BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH;
    body: BillingSubjectRequest;
  };
};

export type BillingCreditsAutoTopUpRecoverAction = BillingCreditsActionBase & {
  id: 'auto_top_up_recover';
  kind: 'hosted_redirect';
  request: {
    method: 'POST';
    path: typeof BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH;
    body: BillingSubjectRequest;
  };
};

type BillingCreditsCommonV1 = {
  schema_version: typeof BILLING_CREDITS_SCHEMA_VERSION;
  credit_account_id: string;
  generated_at: string;
  storefront: { id: string; identifier: string; name: string };
  subject: { user_id: string; organisation_id: string; team_id: string };
  capabilities: {
    can_top_up: boolean;
    can_manage_automatic_top_up: boolean;
  };
  conversion: {
    credits_per_usd: '1000';
    settlement_currency: 'USD';
    description: string;
  };
  current_period: {
    starts_at: string;
    ends_at: string;
  };
  collection: {
    stripe_collection_enabled: boolean;
    stripe_mode: 'test' | 'live' | null;
  };
  credit_balance: BillingCreditAmount & {
    state: 'available' | 'zero' | 'debt';
    label: 'Remaining credits';
    description: string;
  };
  pending_credits: {
    top_up_count: number;
    payment_amount: BillingCreditsPaymentMoney;
    credits_received: BillingCreditAmount;
    label: string;
    description: string;
  };
};

type BillingCreditsFundingOfferBase = {
  id: string;
  key: string;
  name: string;
  description: string;
  payment_amount: BillingCreditsPaymentMoney;
  credits_received: BillingCreditAmount;
  available: boolean;
  unavailable_reason: string | null;
};

type BillingCreditsFundingPolicy<Action> = {
  top_up_enabled: boolean;
  automatic_top_up_enabled: boolean;
  title: string;
  description: string;
  offers: Array<BillingCreditsFundingOfferBase & { action: Action }>;
};

type BillingCreditsAutoTopUpOptionBase = {
  selected: boolean;
  label: string;
  description: string;
  threshold: BillingCreditAmount;
  refill_offer_id: string;
  refill_payment_amount: BillingCreditsPaymentMoney;
  refill_credits_received: BillingCreditAmount;
  monthly_cap: BillingCreditsPaymentMoney;
};

type BillingCreditsAutomaticTopUpBase = {
  state: 'disabled' | 'active' | 'paused' | 'requires_action' | 'needs_review';
  display_status: string;
  description: string;
  threshold: BillingCreditAmount | null;
  refill_offer_id: string | null;
  monthly_cap: BillingCreditsPaymentMoney | null;
  charged_this_month: BillingCreditsPaymentMoney;
  remaining_monthly_cap: BillingCreditsPaymentMoney | null;
};

type BillingCreditsManagerAutomaticTopUp = BillingCreditsAutomaticTopUpBase & {
  payment_method: {
    status: 'missing' | 'ready' | 'requires_action' | 'expired';
    display: string;
  };
  consent: {
    status: 'missing' | 'current' | 'outdated';
    version: string | null;
    consented_at: string | null;
    consented_by: { display_name: string } | null;
    description: string;
  };
  options: Array<
    BillingCreditsAutoTopUpOptionBase & {
      setup_action: BillingCreditsAutoTopUpSetupAction;
      update_action: BillingCreditsAutoTopUpUpdateAction;
    }
  >;
  disable_action: BillingCreditsAutoTopUpDisableAction | null;
  recover_action: BillingCreditsAutoTopUpRecoverAction | null;
};

type BillingCreditsMemberAutomaticTopUp = BillingCreditsAutomaticTopUpBase & {
  payment_method: { status: 'missing' | 'ready' | 'requires_action' | 'expired' };
  consent: {
    status: 'missing' | 'current' | 'outdated';
    version: string | null;
    consented_at: string | null;
  };
  options: Array<
    BillingCreditsAutoTopUpOptionBase & {
      setup_action: null;
      update_action: null;
    }
  >;
  disable_action: null;
  recover_action: null;
};

type BillingCreditsSummaryBase = {
  credits_added: BillingCreditAmount;
  credits_consumed: BillingCreditAmount;
  pending_credits: BillingCreditAmount;
};

type BillingCreditsRecentEntryBase = {
  id: string;
  occurred_at: string;
  service: { id: string; identifier: string; name: string } | null;
  kind:
    | 'top_up'
    | 'automatic_top_up'
    | 'usage_settlement'
    | 'usage_settlement_correction'
    | 'refund'
    | 'dispute'
    | 'refund_reversal'
    | 'dispute_reversal'
    | 'adjustment';
  direction: 'credit' | 'debit';
  label: string;
  detail: string;
  credits: BillingCreditAmount;
  credit_balance_after: BillingCreditAmount;
};

export type BillingCreditsManagerV1 = BillingCreditsCommonV1 & {
  viewer: {
    role: 'billing_manager';
    usage_visibility: 'full_team';
    description: string;
  };
  funding_policy: BillingCreditsFundingPolicy<BillingCreditsTopUpAction>;
  automatic_top_up: BillingCreditsManagerAutomaticTopUp;
  credit_summary: BillingCreditsSummaryBase & {
    consumed_breakdown: Array<{
      service: { id: string; identifier: string; name: string };
      credits_consumed: BillingCreditAmount;
      unattributed_credits_consumed: BillingCreditAmount;
      users: Array<{
        user_id: string;
        display_name: string;
        credits_consumed: BillingCreditAmount;
      }>;
    }>;
  };
  recent_entries: Array<
    BillingCreditsRecentEntryBase & {
      attribution:
        | { kind: 'user'; user_id: string; display_name: string }
        | { kind: 'unattributed' | 'system' | 'team_aggregate' };
    }
  >;
};

export type BillingCreditsMemberV1 = BillingCreditsCommonV1 & {
  viewer: {
    role: 'member';
    usage_visibility: 'own_plus_team_aggregate';
    description: string;
  };
  capabilities: {
    can_top_up: false;
    can_manage_automatic_top_up: false;
  };
  funding_policy: BillingCreditsFundingPolicy<null>;
  automatic_top_up: BillingCreditsMemberAutomaticTopUp;
  credit_summary: BillingCreditsSummaryBase & {
    consumed_breakdown: Array<{
      service: { id: string; identifier: string; name: string };
      credits_consumed: BillingCreditAmount;
      viewer_credits_consumed: BillingCreditAmount;
      other_team_members_credits_consumed: BillingCreditAmount;
      unattributed_credits_consumed: BillingCreditAmount;
    }>;
  };
  recent_entries: Array<
    BillingCreditsRecentEntryBase & {
      attribution: 'viewer' | 'other_team_members' | 'unattributed' | 'system' | 'team_aggregate';
    }
  >;
};

export type BillingCreditsV1 = BillingCreditsManagerV1 | BillingCreditsMemberV1;
