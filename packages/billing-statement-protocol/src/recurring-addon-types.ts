import type { ExactMoney } from './types.js';
import type { BillingSubjectRequest } from './funding-schema-primitives.js';

export const BILLING_RECURRING_ADDONS_SCHEMA_VERSION = 1 as const;
export const BILLING_RECURRING_ADDONS_PROTOCOL_VERSION = '1.0.0' as const;
export const BILLING_RECURRING_ADDONS_SCHEMA_PATH =
  '/schemas/billing-recurring-addons-v1.json' as const;
export const BILLING_RECURRING_ADDONS_EXAMPLE_PATH =
  '/schemas/billing-recurring-addons-v1.example.json' as const;
export const BILLING_RECURRING_ADDONS_OPENAPI_PATH =
  '/schemas/billing-recurring-addons-v1.openapi.json' as const;
export const BILLING_RECURRING_ADDONS_READ_PATH = '/billing/v1/recurring-addons' as const;
export const BILLING_RECURRING_ADDONS_CHECKOUT_PATH =
  '/billing/v1/recurring-addons/checkout' as const;
export const BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH =
  '/billing/v1/recurring-addons/cancellation/preview' as const;
export const BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH =
  '/billing/v1/recurring-addons/cancellation/confirm' as const;

export type BillingRecurringAddonMoney = ExactMoney & { amount_minor: string };

export type BillingRecurringAddonCheckoutAction = {
  id: 'subscribe';
  kind: 'hosted_redirect';
  label: string;
  description: string;
  enabled: boolean;
  disabled_reason: string | null;
  request: {
    method: 'POST';
    path: typeof BILLING_RECURRING_ADDONS_CHECKOUT_PATH;
    body: BillingSubjectRequest & { offer_id: string };
  };
};

export type BillingRecurringAddonCancelAction = {
  id: 'cancel';
  kind: 'confirmation_dialog';
  label: string;
  description: string;
  enabled: boolean;
  disabled_reason: string | null;
  request: {
    method: 'POST';
    path: typeof BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH;
    body: BillingSubjectRequest & { subscription_id: string };
  };
};

type BillingRecurringAddonSubscriptionBase = {
  status: string;
  display_status: string;
  scope: 'organisation' | 'team' | 'subscribing_user';
  cancel_at_period_end: boolean;
  current_period_start: string | null;
  current_period_end: string | null;
};

export type BillingRecurringAddonManagerSubscription =
  BillingRecurringAddonSubscriptionBase & {
    id: string;
    owner_user_id: string | null;
  };

export type BillingRecurringAddonMemberSubscription =
  BillingRecurringAddonSubscriptionBase & {
    owner_relationship: 'organisation' | 'team' | 'viewer' | 'other_team_member';
  };

type BillingRecurringAddonOffer<
  Subscription,
  Action extends BillingRecurringAddonCheckoutAction | BillingRecurringAddonCancelAction,
> = {
  id: string;
  key: string;
  version: number;
  name: string;
  description: string;
  benefits: string[];
  monthly_price: BillingRecurringAddonMoney;
  interval: 'month';
  available: boolean;
  unavailable_reason: string | null;
  entitlement: {
    state: 'inactive' | 'pending' | 'active' | 'unavailable';
    display_status: string;
    description: string;
  };
  subscription: Subscription | null;
  actions: Action[];
};

type BillingRecurringAddonsCommonV1 = {
  schema_version: typeof BILLING_RECURRING_ADDONS_SCHEMA_VERSION;
  generated_at: string;
  product: { id: string; identifier: string; name: string };
  subject: { user_id: string; organisation_id: string; team_id: string };
  collection: {
    stripe_collection_enabled: boolean;
    stripe_mode: 'test' | 'live' | null;
  };
  title: string;
  description: string;
};

export type BillingRecurringAddonsManagerV1 = BillingRecurringAddonsCommonV1 & {
  viewer: {
    role: 'billing_manager';
    entitlement_visibility: 'full_team';
    description: string;
  };
  capabilities: { can_manage_addons: boolean };
  offers: Array<
    BillingRecurringAddonOffer<
      BillingRecurringAddonManagerSubscription,
      BillingRecurringAddonCheckoutAction | BillingRecurringAddonCancelAction
    >
  >;
};

export type BillingRecurringAddonsMemberV1 = BillingRecurringAddonsCommonV1 & {
  viewer: {
    role: 'member';
    entitlement_visibility: 'own_plus_team_status';
    description: string;
  };
  capabilities: { can_manage_addons: false };
  offers: Array<
    Omit<
      BillingRecurringAddonOffer<
        BillingRecurringAddonMemberSubscription,
        BillingRecurringAddonCheckoutAction | BillingRecurringAddonCancelAction
      >,
      'actions'
    > & { actions: [] }
  >;
};

export type BillingRecurringAddonsV1 =
  | BillingRecurringAddonsManagerV1
  | BillingRecurringAddonsMemberV1;

export type BillingRecurringAddonCancellationPreviewV1 = {
  schema_version: typeof BILLING_RECURRING_ADDONS_SCHEMA_VERSION;
  preview_token: string;
  idempotency_key: string;
  expires_at: string;
  title: string;
  description: string;
  subscription: {
    id: string;
    offer_name: string;
    display_status: string;
    cancellation_effective_at: string | null;
  };
  confirm_action: {
    method: 'POST';
    path: typeof BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH;
    body: {
      product: string;
      organisation_id: string;
      team_id: string;
      user_id: string;
      preview_token: string;
      idempotency_key: string;
      choice: 'cancel_addon';
    };
  };
};

export type BillingRecurringAddonCancellationConfirmRequestV1 = BillingSubjectRequest & {
  preview_token: string;
  idempotency_key: string;
  choice: 'cancel_addon';
};

export type BillingRecurringAddonCancellationConfirmationV1 = {
  schema_version: typeof BILLING_RECURRING_ADDONS_SCHEMA_VERSION;
  status: 'scheduled' | 'already_scheduled';
  title: string;
  description: string;
  cancellation_effective_at: string | null;
};

export type BillingRecurringAddonConformanceFixturesV1 = {
  recurring_addons: BillingRecurringAddonsV1;
  recurring_addons_member: BillingRecurringAddonsMemberV1;
  cancellation_preview: BillingRecurringAddonCancellationPreviewV1;
  cancellation_confirm_request: BillingRecurringAddonCancellationConfirmRequestV1;
  cancellation_confirmation: BillingRecurringAddonCancellationConfirmationV1;
};
