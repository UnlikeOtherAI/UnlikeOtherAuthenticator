export const BILLING_CONSUMER_ACTION_SCHEMA_VERSION = 1 as const;
export const BILLING_CONSUMER_ACTION_SCHEMA_PATH =
  '/schemas/billing-consumer-actions-v1.json' as const;
export const BILLING_CONSUMER_ACTION_EXAMPLE_PATH =
  '/schemas/billing-consumer-actions-v1.example.json' as const;
export const BILLING_CONSUMER_ACTION_OPENAPI_PATH =
  '/schemas/billing-consumer-actions-v1.openapi.json' as const;

export type BillingCancellationSelection =
  | 'current_service'
  | 'current_and_related_direct_services';

export type BillingHostedRedirectResponse = {
  redirect_url: string;
};

/**
 * The exact bodies a product relays to `POST /billing/v1/stripe/checkout-session`
 * and `POST /billing/v1/stripe/portal-session`, and the exact envelopes UOA
 * answers with (protocol 1.3.0).
 *
 * These were the one gap in the published contract, so products hand-wrote
 * validators for them — the parallel-contract problem this package exists to
 * prevent. The body values still come from UOA inside a statement action's
 * `request.body`: publishing the shape lets a product *validate* what it relays
 * and what it receives, never *compose* it.
 */
export type BillingSubjectActionRequest = {
  product: string;
  organisation_id: string;
  team_id: string;
  user_id: string;
};

export type BillingCheckoutSessionRequest = BillingSubjectActionRequest & {
  success_url: string;
  cancel_url: string;
};

export type BillingCheckoutTariff = {
  id: string;
  key: string;
  version: number;
  mode: 'standard' | 'free' | 'at_cost' | 'custom';
  collection_mode: 'stripe' | 'manual' | 'none';
  markup_bps: number;
  markup_percent: string;
  usage_price_multiplier_bps: number;
  monthly_subscription: {
    amount_minor: string;
    currency: string;
  };
  usage_billing_enabled: boolean;
  payment_collection_enabled: boolean;
  raw_usage_preserved: true;
};

export type BillingCheckoutSessionResponse = {
  checkout_session_id: string;
  checkout_url: string;
  expires_at: string;
  tariff: BillingCheckoutTariff;
};

export type BillingPortalSessionRequest = BillingSubjectActionRequest & {
  return_url: string;
};

export type BillingPortalSessionResponse = {
  portal_url: string;
};

export type BillingCancellationPreviewV1 = {
  schema_version: typeof BILLING_CONSUMER_ACTION_SCHEMA_VERSION;
  preview_token: string;
  expires_at: string;
  title: string;
  message: string;
  choice_required: boolean;
  choices: Array<{
    id: BillingCancellationSelection;
    label: string;
    description: string;
    service_ids: string[];
  }>;
  direct_services: Array<{
    service_id: string;
    product: string;
    name: string;
    display_name: string;
    direct_user_count: number;
    subscription_status: string;
  }>;
  indirect_services: Array<{
    product: string;
    name: string | null;
    display_name: string;
    impact: string;
  }>;
  confirm_action: {
    method: 'POST';
    path: '/billing/v1/cancellation/confirm';
    label: string;
    idempotency_key: string;
    selection_required: boolean;
    default_selection: 'current_service' | null;
  };
};

export type BillingCancellationConfirmRequest = {
  preview_token: string;
  idempotency_key: string;
  selection: BillingCancellationSelection | null;
};

export type BillingCancellationConfirmationV1 = {
  schema_version: typeof BILLING_CONSUMER_ACTION_SCHEMA_VERSION;
  status: 'confirmed';
  title: string;
  message: string;
  cancelled_services: Array<{
    service_id: string;
    product: string;
    name: string;
    display_name: string;
    status: string;
    effective_at: string | null;
  }>;
  indirect_services: Array<{
    product: string;
    display_name: string;
    impact: string;
  }>;
};

export type BillingErrorEnvelope = {
  error: string;
};

export type BillingConsumerActionConformanceFixturesV1 = {
  hosted_redirect_response: BillingHostedRedirectResponse;
  checkout_session_request: BillingCheckoutSessionRequest;
  checkout_session_response: BillingCheckoutSessionResponse;
  portal_session_request: BillingPortalSessionRequest;
  portal_session_response: BillingPortalSessionResponse;
  cancellation_preview: BillingCancellationPreviewV1;
  cancellation_confirm_request: BillingCancellationConfirmRequest;
  cancellation_confirmation: BillingCancellationConfirmationV1;
  error: BillingErrorEnvelope;
};
