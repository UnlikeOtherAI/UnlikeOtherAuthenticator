import type { BillingCreditsManagerV1, BillingCreditAmount } from './credits-types.js';
import type { BillingCyclePeriod, BillingCycleTotals } from './cycle-types.js';
import type { BillingSubjectRequest } from './funding-schema-primitives.js';
import type { BillingStatementV1, ExactMoney } from './types.js';

export const BILLING_ORGANISATION_PROTOCOL_VERSION = '1.0.0' as const;
export const BILLING_ORGANISATION_CAPABILITIES_PATH = '/billing/v1/organisation/capabilities' as const;
export const BILLING_ORGANISATION_OVERVIEW_PATH = '/billing/v1/organisation/overview' as const;
export const BILLING_ORGANISATION_SCHEMA_PATH = '/schemas/billing-organisation-v1.json' as const;
export const BILLING_ORGANISATION_EXAMPLE_PATH = '/schemas/billing-organisation-v1.example.json' as const;
export const BILLING_ORGANISATION_OPENAPI_PATH = '/schemas/billing-organisation-v1.openapi.json' as const;

/** Team and product identify the currently admitted actor/perspective, never the financial filter. */
export type BillingOrganisationRequestV1 = BillingSubjectRequest;
export type BillingOrganisationOverviewRequestV1 = BillingOrganisationRequestV1 & { billing_month?: string };
export type BillingOrganisationScopeV1 = {
  kind: 'organisation'; organisation_id: string; mode: 'live' | 'sandbox';
  revision: number; epoch: string;
};
export type BillingOrganisationCapabilitiesV1 = {
  schema_version: 1; generated_at: string; subject: BillingSubjectRequest;
} & ({ capabilities: { can_view_billing: true; can_manage_billing: true }; financial_scope: BillingOrganisationScopeV1 }
  | { capabilities: { can_view_billing: false; can_manage_billing: false }; financial_scope?: never });

/** No data/numeric total is admitted in an unconfirmed section. Sections fail independently. */
export type BillingOrganisationSectionV1<T> =
  | { state: 'confirmed'; message: string; data: T }
  | { state: 'pending_reconciliation' | 'unavailable'; message: string; code: string; data?: never };

export type BillingOrganisationCreditBalanceV1 = {
  credit_account_id: string;
  /** Confirmed ledger balance; reservations are not debits. */
  confirmed_balance: BillingCreditAmount;
  reserved_credits: BillingCreditAmount;
  spendable_balance: BillingCreditAmount;
  as_of: string;
  /** An unresolved usage settlement does not erase the independently confirmed wallet balance. */
  billing_status: { settlement_state: 'current' | 'pending_reconciliation'; message: string };
  region_rate?: BillingCreditsManagerV1['region_rate'];
};
export type BillingOrganisationFundingV1 = Pick<BillingCreditsManagerV1,
  'capabilities' | 'funding_policy' | 'automatic_top_up' | 'conversion' | 'collection' | 'region_rate'>;
export type BillingOrganisationSubscriptionV1 = Pick<BillingStatementV1,
  'plan' | 'collection' | 'subscription' | 'capabilities' | 'actions'>;
export type BillingOrganisationAccruedBillV1 = {
  as_of: string; period: BillingCyclePeriod;
  /** UOA authored, currency-separated liabilities. Consumers never sum team/product statements. */
  totals: BillingCycleTotals[];
  lines: Array<{ id: string; product: string | null; label: string;
    kind: 'subscription' | 'usage' | 'add_on' | 'adjustment' | 'tax' | 'prepaid_credit';
    amount: ExactMoney & { amount_minor: string } }>;
};
export type BillingOrganisationHistoryV1 = {
  cycles_request: { method: 'POST'; path: '/billing/v1/cycles/list'; body: BillingSubjectRequest };
  invoices_request: { method: 'POST'; path: '/billing/v1/invoices/list'; body: BillingSubjectRequest & { charge_month: string } };
};
export type BillingOrganisationOverviewV1 = {
  schema_version: 1; generated_at: string; subject: BillingSubjectRequest;
  financial_scope: BillingOrganisationScopeV1;
  sections: {
    accrued_bill: BillingOrganisationSectionV1<BillingOrganisationAccruedBillV1>;
    credits: BillingOrganisationSectionV1<BillingOrganisationCreditBalanceV1>;
    funding: BillingOrganisationSectionV1<BillingOrganisationFundingV1>;
    subscription: BillingOrganisationSectionV1<BillingOrganisationSubscriptionV1>;
    history: BillingOrganisationSectionV1<BillingOrganisationHistoryV1>;
  };
};
