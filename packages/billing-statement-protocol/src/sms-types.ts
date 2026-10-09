import type { BillingSubjectRequest } from './funding-schema-primitives.js';

export const BILLING_SMS_PROTOCOL_VERSION = '1.0.0' as const;
export const BILLING_SMS_PATHS = {
  quote: '/billing/v1/sms/quotes',
  verifyQuote: '/billing/v1/sms/quotes/verify',
  reserve: '/billing/v1/sms/reservations',
  reservation: '/billing/v1/sms/reservations/read',
  claim: '/billing/v1/sms/reservations/claim',
  receipt: '/billing/v1/sms/reservations/receipt',
  release: '/billing/v1/sms/reservations/release',
  numberBegin: '/billing/v1/sms/numbers/begin',
  numberStatus: '/billing/v1/sms/numbers/status',
  numberRuntimeStatus: '/billing/v1/sms/numbers/runtime-status',
  numberAttach: '/billing/v1/sms/numbers/attach',
  numberEnd: '/billing/v1/sms/numbers/end',
  standingHold: '/billing/v1/sms/inbound/holds',
  standingStatus: '/billing/v1/sms/inbound/holds/read',
  standingRetire: '/billing/v1/sms/inbound/holds/retire',
  inboundReceipt: '/billing/v1/sms/inbound/receipts',
  grant: '/billing/v1/sms/grants',
  grantRead: '/billing/v1/sms/grants/read',
  grantRevoke: '/billing/v1/sms/grants/revoke',
  grantQuote: '/billing/v1/sms/grants/quotes',
} as const;

export type BillingSmsDirection = 'monthly' | 'inbound' | 'outbound';
export type BillingSmsQuoteScope = {
  organisation_id: string;
  country: string;
  number_type: 'mobile';
  direction: BillingSmsDirection;
  destination: string | null;
  carrier: string | null;
  mcc: string | null;
  mnc: string | null;
};

/** Customer-safe exact final price. No private provider or tariff evidence. */
export type BillingSmsFinalQuoteV1 = {
  id: string;
  amount: string;
  currency: 'USD';
  expires_at: string;
  rate_basis: 'monthly_mobile' | 'inbound_mobile' | 'maximum_mobile_carrier';
  scope: BillingSmsQuoteScope;
};

export type BillingSmsQuoteRequestV1 = BillingSubjectRequest &
  Omit<BillingSmsQuoteScope, 'organisation_id'>;

export type BillingSmsVerifyQuoteRequestV1 = BillingSmsQuoteRequestV1 & { quote_id: string };

/** A physical dispatch identity stays unchanged through retry and reallocation. */
export type BillingSmsDispatchBindingV1 = {
  dispatch_id: string;
  request_fingerprint: string;
  number_id: string;
  allocation_id: string;
  account_sid: string;
  from: string;
  to: string;
};

export type BillingSmsReserveRequestV1 = BillingSubjectRequest & BillingSmsDispatchBindingV1 & {
  quote_id: string;
  max_segments: number;
  grant_id: string | null;
  delegate_id: string | null;
};

export type BillingSmsGrantRequestV1 = BillingSubjectRequest & {
  number_id: string; allocation_id: string; delegate_id: string;
  max_segments: number; idempotency_key: string;
};
export type BillingSmsGrantReadRequestV1 = { product: string; grant_id: string };
export type BillingSmsGrantQuoteRequestV1 = BillingSmsGrantReadRequestV1 & {
  country: string; destination: string;
};
export type BillingSmsGrantV1 = {
  id: string; number_id: string; allocation_id: string; delegate_id: string;
  max_segments: number; state: 'active' | 'revoked';
};
export type BillingSmsGrantRevocationV1 = { grant_id: string; state: 'revoked' };
export type BillingSmsGrantRevokeResultV1 = BillingSmsGrantV1 | BillingSmsGrantRevocationV1;

/** Explicit team consent reserves existing credits before inbound traffic is funded. */
export type BillingSmsStandingHoldRequestV1 = BillingSubjectRequest & {
  number_id: string;
  allocation_id: string;
  reserve_credits: string;
  idempotency_key: string;
};
export type BillingSmsStandingReadRequestV1 = {
  product: string; number_id: string; allocation_id: string;
};
export type BillingSmsInboundReceiptRequestV1 = BillingSmsStandingReadRequestV1 & {
  message_sid: string; organisation_id: string; team_id: string;
};
export type BillingSmsStandingHoldV1 = {
  id: string;
  number_id: string;
  allocation_id: string;
  state: 'active' | 'retired' | 'reconciliation';
  reserved_credits: string;
};
export type BillingSmsStandingRetirementV1 = {
  number_id: string; allocation_id: string; state: 'retired'; can_fund: false;
};
export type BillingSmsStandingRetireResultV1 = BillingSmsStandingHoldV1 | BillingSmsStandingRetirementV1;
/** An uncovered charge is recorded as uncollected liability; it is never prepaid usage. */
export type BillingSmsInboundReceiptV1 = {
  message_sid: string;
  state: 'pending' | 'funded' | 'uncollected' | 'reconciliation';
  consumed_credits: string | null;
  uncollected_credits: string | null;
};

export type BillingSmsReservationReadRequestV1 = { product: string; dispatch_id: string };
export type BillingSmsClaimRequestV1 = BillingSmsReservationReadRequestV1 & {
  request_fingerprint: string;
};
export type BillingSmsReceiptRequestV1 = BillingSmsClaimRequestV1 & { message_sid: string };
export type BillingSmsReleaseRequestV1 = BillingSmsClaimRequestV1 & {
  proof: 'no_provider_dispatch';
  dispatch_token: string | null;
};

export type BillingSmsReservationV1 = {
  dispatch_id: string;
  reservation_id: string;
  state: 'reserved' | 'dispatching' | 'uncertain' | 'settled' | 'released' | 'reconciliation';
  /** Opaque fence returned only to the backend which claimed provider dispatch. */
  dispatch_token: string | null;
  reserved_credits: string;
  consumed_credits: string | null;
  message_sid: string | null;
};
export type BillingSmsDispatchCancellationV1 = {
  dispatch_id: string; state: 'released'; can_dispatch: false;
};
export type BillingSmsReleaseResultV1 = BillingSmsReservationV1 | BillingSmsDispatchCancellationV1;

export type BillingSmsNumberBeginRequestV1 = BillingSubjectRequest & {
  resource_id: string;
  quote_id: string;
  phone_number: string;
};
export type BillingSmsNumberStatusRequestV1 = BillingSubjectRequest & { resource_id: string };
/** Product-scoped machine recovery never relies on an expired customer assertion. */
export type BillingSmsNumberRuntimeStatusRequestV1 = { product: string; resource_id: string };
export type BillingSmsResourceNotFoundV1 = { code: 'BILLING_SMS_RESOURCE_NOT_FOUND'; resource_id: string };
/** A refusal reserves no funds and authorizes no provider dispatch. */
export type BillingSmsInsufficientCreditsV1 = {
  code: 'BILLING_SMS_INSUFFICIENT_CREDITS';
  reason: 'insufficient_prepaid_credits';
  can_dispatch: false;
};
export type BillingSmsNumberAttachRequestV1 = {
  product: string;
  resource_id: string;
  account_sid: string;
  phone_number_sid: string;
};
export type BillingSmsNumberEndRequestV1 = {
  product: string;
  resource_id: string;
  reason: 'released' | 'acquisition_unavailable';
};
export type BillingSmsNumberCancellationV1 = {
  resource_id: string; state: 'ended'; acquisition_authorized: false;
};
export type BillingSmsNumberEndResultV1 = BillingSmsNumberV1 | BillingSmsNumberCancellationV1;

/** Payment pins the accepted quote; display expiry cannot invalidate paid terms. */
export type BillingSmsNumberV1 = {
  resource_id: string;
  organisation_id: string;
  phone_number: string;
  state: 'payment_required' | 'payment_pending' | 'paid' | 'active' | 'ending' |
    'ended' | 'recovery_required' | 'refund_required';
  quote: BillingSmsFinalQuoteV1;
  acquisition_authorized: boolean;
  checkout_url: string | null;
  disabled_reason: string | null;
};
