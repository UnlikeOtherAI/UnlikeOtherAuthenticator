import type { BillingSubjectRequest } from './funding-schema-primitives.js';

export const BILLING_VOICE_PROTOCOL_VERSION = '1.0.0';
export const BILLING_VOICE_PATHS = {
  grant: '/billing/v1/voice/grants', grantRead: '/billing/v1/voice/grants/read',
  grantRevoke: '/billing/v1/voice/grants/revoke', quote: '/billing/v1/voice/quotes',
  reserve: '/billing/v1/voice/reservations', read: '/billing/v1/voice/reservations/read',
  claim: '/billing/v1/voice/reservations/claim', receipt: '/billing/v1/voice/reservations/receipt',
  release: '/billing/v1/voice/reservations/release',
  stream: '/billing/v1/voice/reservations/stream',
  reconciliation: '/billing/v1/voice/stream-reconciliation',
} as const;
export type VoiceDirection = 'inbound' | 'outbound';
export type VoicePurpose = 'agent_call' | 'human_transfer';
export type BillingVoiceGrantRequestV1 = BillingSubjectRequest & {
  idempotency_key: string; number_id: string; allocation_id: string; delegate_id: string;
  direction: VoiceDirection; purpose: VoicePurpose; max_duration_seconds: number;
  max_concurrent_calls: number; destinations: string[];
};
export type BillingVoiceGrantReadRequestV1 = { product: string; grant_id: string };
/** Billing attribution only; never caller authentication or tool authority. */
export type BillingVoiceBillingOriginV1 = {
  subject: string; token_version: number; organisation_id: string; team_id: string; expires_at: string;
};
export type BillingVoiceGrantV1 = {
  id: string; number_id: string; allocation_id: string; delegate_id: string;
  direction: VoiceDirection; purpose: VoicePurpose; max_duration_seconds: number;
  max_concurrent_calls: number; destinations: string[]; state: 'active' | 'revoked';
  billing_origin: BillingVoiceBillingOriginV1 | null;
};
export type BillingVoiceQuoteRequestV1 = BillingVoiceGrantReadRequestV1 & {
  delegate_id: string; from: string; to: string; max_duration_seconds: number; media_stream?: boolean;
};
export type BillingVoiceStreamTariffV1 = {
  currency: 'USD'; price_per_minute: string; customer_price_per_minute: string;
  rounding_seconds: 60; max_streams: 1; disclosure_version: string;
  basis: 'nessie_duration_rounded_minute';
};
export type BillingVoiceQuoteV1 = {
  id: string; grant_id: string; from: string; to: string; direction: VoiceDirection;
  max_duration_seconds: number; reserved_credits: string; expires_at: string;
  stream_tariff: BillingVoiceStreamTariffV1 | null;
};
export type BillingVoiceReserveRequestV1 = BillingVoiceQuoteRequestV1 & {
  dispatch_id: string; request_fingerprint: string; quote_id: string;
  conversation_id: string; leg_id: string; call_sid: string | null;
  parent_reservation_id: string | null; stream_disclosure_version?: string;
};
export type BillingVoiceReadRequestV1 = { product: string; dispatch_id: string };
export type BillingVoiceClaimRequestV1 = BillingVoiceReadRequestV1 & { request_fingerprint: string };
export type BillingVoiceReceiptRequestV1 = BillingVoiceClaimRequestV1 & { call_sid: string };
export type BillingVoiceReleaseRequestV1 = BillingVoiceClaimRequestV1 & {
  proof: 'no_provider_dispatch'; dispatch_token: string | null;
};
export type BillingVoiceReservationV1 = {
  reservation_id: string; dispatch_id: string;
  state: 'reserved' | 'dispatching' | 'uncertain' | 'settled' | 'released' | 'reconciliation';
  dispatch_token: string | null; reserved_credits: string; consumed_credits: string | null;
  call_sid: string | null; max_duration_seconds: number; claim_expires_at: string;
};

export type BillingVoiceStreamRequestV1 = BillingVoiceReceiptRequestV1 & {
  stream_sid: string; event: 'start' | 'stop'; started_at: string; stopped_at: string | null;
};
export type BillingVoiceStreamReconciliationRequestV1 = {
  product: string; account_sid: string; billing_month: string;
  invoice: { id: string; amount_usd: string; reference: string } | null;
};
export type BillingVoiceStreamReconciliationV1 = {
  account_sid: string; billing_month: string; fixed_stream_amount_usd: string;
  pending_streams: number; invoice_amount_usd: string | null; invoice_reference: string | null;
  difference_usd: string | null; status: 'awaiting_invoice' | 'pending_calls' | 'matched' | 'difference';
  invoice_source: 'operator_reported';
};
