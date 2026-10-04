import type { ExactMoney } from './types.js';
import type { BillingSubjectRequest } from './funding-schema-primitives.js';

export const BILLING_CYCLES_PROTOCOL_VERSION = '3.0.0' as const;
export const BILLING_CYCLES_SCHEMA_VERSION = 2 as const;
export const BILLING_CYCLES_SCHEMA_PATH = '/schemas/billing-cycles-v2.json' as const;
export const BILLING_CYCLES_EXAMPLE_PATH = '/schemas/billing-cycles-v2.example.json' as const;
export const BILLING_CYCLES_OPENAPI_PATH = '/schemas/billing-cycles-v2.openapi.json' as const;
export const BILLING_CYCLES_LIST_PATH = '/billing/v1/cycles/list' as const;
export const BILLING_CYCLES_DETAIL_PATH = '/billing/v1/cycles/detail' as const;
export const BILLING_CYCLES_DOWNLOAD_PATH = '/billing/v1/cycles/download' as const;

export type BillingCycleMoney = ExactMoney & { amount_minor: string };
export type BillingCycleState =
  | 'open_preview'
  | 'pending_reconciliation'
  | 'finalized'
  | 'adjusted'
  | 'voided';
export type BillingCycleScope = {
  organisation_id: string;
  team_id: string | null;
  cycle_scope: 'team' | 'organisation';
  payer_scope: 'team' | 'organisation';
};
export type BillingCyclePeriod = {
  month: string;
  starts_at: string;
  ends_at: string;
};
export type BillingCycleProduct = {
  id: string;
  identifier: string;
  name: string;
};
export type BillingCycleTotals = {
  currency: string;
  subscription: BillingCycleMoney;
  usage_charge: BillingCycleMoney;
  tax: BillingCycleMoney;
  gross_total: BillingCycleMoney;
  credits_applied: BillingCycleMoney;
  total_due: BillingCycleMoney;
  total_paid: BillingCycleMoney;
  outstanding: BillingCycleMoney;
};
export type BillingCycleSummaryV2 = {
  cycle_id: string;
  period: BillingCyclePeriod;
  state: BillingCycleState;
  scope: BillingCycleScope;
  product: BillingCycleProduct;
  totals: BillingCycleTotals[];
  document_available: boolean;
};
export type BillingCyclesListRequestV2 = BillingSubjectRequest & {
  limit?: number;
  cursor?: string;
};
export type BillingCyclesListV2 = {
  schema_version: typeof BILLING_CYCLES_SCHEMA_VERSION;
  generated_at: string;
  subject: BillingSubjectRequest;
  cycles: BillingCycleSummaryV2[];
  next_cursor: string | null;
};
export type BillingCycleDetailRequestV2 = BillingSubjectRequest & { cycle_id: string };
export type BillingCycleSeatInterval = {
  starts_at: string;
  ends_at: string;
  quantity: string;
};
export type BillingCycleSubscriptionLine = {
  id: string;
  label: string;
  charge_basis: 'flat' | 'per_seat';
  seat_policy: 'automatic' | 'fixed' | null;
  seat_timing: 'full_month' | 'prorated' | null;
  unit_price: BillingCycleMoney;
  quantity: string | null;
  active_seat_seconds: string | null;
  month_seconds: string | null;
  intervals: BillingCycleSeatInterval[];
  customer_charge: BillingCycleMoney;
};
export type BillingCycleUsageLine = {
  id: string;
  label: string;
  usage_payment_mode: 'prepaid' | 'pay_as_you_go';
  customer_charge: ExactMoney | null;
  credits_consumed: string | null;
};
export type BillingCycleCredits = {
  consumed: string | null;
  /** Confirmed usage credits forgiven by an actual UOA operator decision. */
  waived?: string | null;
  opening_balance: string | null;
  closing_balance: string | null;
  status: 'confirmed' | 'pending_reconciliation';
};
export type BillingCycleDownloadAction = {
  method: 'POST';
  path: typeof BILLING_CYCLES_DOWNLOAD_PATH;
  body: BillingSubjectRequest & { cycle_id: string; document_id: string };
};
export type BillingCycleDocument = {
  document_id: string;
  kind: 'monthly_invoice' | 'top_up_invoice' | 'credit_note' | 'usage_breakdown';
  format: 'pdf' | 'csv';
  state: 'pending' | 'available';
  number: string | null;
  issued_at: string | null;
  customer_total: BillingCycleMoney | null;
  download_action: BillingCycleDownloadAction | null;
};
export type BillingCycleAdjustment = {
  source_cycle_id: string;
  document_id: string;
  kind: 'charge' | 'credit';
  customer_amount: BillingCycleMoney;
  reason: string;
};
export type BillingCycleDetailV2 = BillingCycleSummaryV2 & {
  schema_version: typeof BILLING_CYCLES_SCHEMA_VERSION;
  subscription_lines: BillingCycleSubscriptionLine[];
  usage_lines: BillingCycleUsageLine[];
  credits: BillingCycleCredits;
  documents: BillingCycleDocument[];
  adjustments: BillingCycleAdjustment[];
};
export type BillingCycleDownloadRequestV2 = BillingSubjectRequest & {
  cycle_id: string;
  document_id: string;
};
