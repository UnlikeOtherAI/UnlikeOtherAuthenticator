import type { BillingSubjectRequest } from './funding-schema-primitives.js';

export const BILLING_CREDIT_ATTENTION_KINDS = [
  'low_credits', 'credits_exhausted', 'payment_action_required',
  'card_expired', 'auto_top_up_paused',
] as const;

/** Stable, privacy-safe source facts; consumers localize their existing alerts. */
export type BillingCreditAttentionV1 = {
  event_key: string;
  kind: (typeof BILLING_CREDIT_ATTENTION_KINDS)[number];
};

export const BILLING_CREDIT_FUNDING_REQUEST_PATH = '/billing/v1/credits/funding-request' as const;
export const BILLING_CREDIT_FUNDING_REQUEST_SCHEMA_PATH =
  '/schemas/billing-credit-funding-request-v1.json' as const;

export type BillingCreditFundingRequestActionV1 = {
  label: string;
  enabled: boolean;
  disabled_reason: string | null;
  request: {
    method: 'POST';
    path: typeof BILLING_CREDIT_FUNDING_REQUEST_PATH;
    body: BillingSubjectRequest;
  };
};

/** Server-to-server authorization result, not a claim that anyone was notified. */
export type BillingCreditFundingRequestV1 = {
  schema_version: 1;
  request_id: string;
  recipient_user_ids: string[];
};
