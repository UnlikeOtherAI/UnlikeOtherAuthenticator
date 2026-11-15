import type { BillingSubjectRequest } from './funding-schema-primitives.js';

export const BILLING_BROWSER_PROTOCOL_VERSION = '1.0.0';
export const BILLING_BROWSER_PATHS = {
  tariff: '/billing/v1/browser/tariff',
  reserve: '/billing/v1/browser/reservations',
  read: '/billing/v1/browser/reservations/read',
  claim: '/billing/v1/browser/reservations/claim',
  receipt: '/billing/v1/browser/reservations/receipt',
  release: '/billing/v1/browser/reservations/release',
} as const;
export type BillingBrowserTariffRequestV1 = BillingSubjectRequest & { project_id: string };
export type BillingBrowserTariffV1 = {
  policy_id: string;
  project_id: string;
  currency: 'USD';
  provider_price_per_hour: string;
  customer_price_per_minute: string;
  markup_bps: 1000;
  minimum_seconds: 60;
  rounding_seconds: number;
  valid_until: string;
};
export type BillingBrowserBudgetContextV1 = {
  project_id: string | null;
  run_id: string;
  run_started_at: string | null;
  run_owner_sub: string | null;
  budget_run_id: string | null;
  budget_run_started_at: string | null;
  budget_run_owner_sub: string | null;
};
export type BillingBrowserReserveRequestV1 = BillingBrowserTariffRequestV1 & {
  dispatch_id: string;
  max_duration_seconds: number;
  budget_context: BillingBrowserBudgetContextV1 | null;
};
export type BillingBrowserReadRequestV1 = { product: string; dispatch_id: string };
export type BillingBrowserReleaseRequestV1 = BillingBrowserReadRequestV1 &
  (
    | { proof: 'no_provider_dispatch' }
    | { proof: 'provider_rejected'; provider_http_status: 400 | 401 | 403 | 404 | 422 | 429 }
  );
/** Runtime-only receipt fetched from Browserbase; never accepted from a person's browser. */
export type BillingBrowserReceiptRequestV1 = BillingBrowserReadRequestV1 & {
  project_id: string;
  session_id: string;
  status: 'COMPLETED' | 'ERROR' | 'TIMED_OUT';
  started_at: string;
  ended_at: string;
  proxy_bytes: number;
};
export type BillingBrowserReservationV1 = {
  reservation_id: string;
  dispatch_id: string;
  policy_id: string;
  state: 'reserved' | 'dispatching' | 'settled' | 'released' | 'reconciliation';
  can_dispatch: boolean;
  reserved_credits: string;
  consumed_credits: string | null;
  session_id: string | null;
  max_duration_seconds: number;
  claim_expires_at: string;
};
