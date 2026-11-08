import type { BillingCreditAmount } from './credits-types.js';
import type { BillingSubjectRequest } from './funding-schema-primitives.js';
import type {
  BillingOrganisationFinancialScopeV1,
  BillingOrganisationRequestV1,
  BillingOrganisationSectionV1,
} from './organisation-overview-types.js';

export const BILLING_AUTHORITY_PROTOCOL_VERSION = '1.0.0' as const;
export const BILLING_AUTHORITY_PROTOCOL_HEADER = 'X-UOA-Billing-Authority-Protocol' as const;
export const BILLING_TEAM_OVERVIEW_PATH = '/billing/v1/team/overview' as const;
export const BILLING_AUTHORITY_SCHEMA_PATH = '/schemas/billing-authority-v1.json' as const;
export const BILLING_AUTHORITY_EXAMPLE_PATH = '/schemas/billing-authority-v1.example.json' as const;
export const BILLING_AUTHORITY_OPENAPI_PATH = '/schemas/billing-authority-v1.openapi.json' as const;

/** Attribution only: there is still one organisation payer and mode. */
export type BillingTeamReadScopeV1 = {
  kind: 'team'; product: string; organisation_id: string; team_id: string;
};
export type BillingTeamOverviewRequestV1 = BillingSubjectRequest & { billing_month?: string };
type CapabilitiesBaseV2 = {
  schema_version: 2; generated_at: string; subject: BillingOrganisationRequestV1;
};
/** Negotiated response on the existing organisation capabilities endpoint.
 * Without the authority header the strict schema1 response remains unchanged. */
export type BillingCapabilitiesV2 = CapabilitiesBaseV2 & (
  | { access: 'organisation_manager'; financial_scope: BillingOrganisationFinancialScopeV1 }
  | { access: 'team_reader'; subject: BillingSubjectRequest; team_scope: BillingTeamReadScopeV1;
    overview_request: { method: 'POST'; path: typeof BILLING_TEAM_OVERVIEW_PATH;
      body: BillingTeamOverviewRequestV1 } }
  | { access: 'none' }
);
export type BillingTeamActivityV1 = {
  as_of: string;
  recorded_calls: { quantity: string; display: string; label: string };
};
export type BillingTeamRecordedUsageV1 = {
  as_of: string;
  /** Every captured provider account/mode stays separate. No total or amount due. */
  sources: Array<{ source_ref: string; mode: 'live' | 'sandbox'; label: string;
    recorded_usage: BillingCreditAmount; waived_usage: BillingCreditAmount }>;
};
export type BillingTeamRetainedCreditsV1 = {
  as_of: string;
  /** Original TEAM rows only; these records never become ORG spendable funds. */
  records: Array<{ record_id: string; source_ref: string; mode: 'live' | 'sandbox';
    label: string; recorded_balance: BillingCreditAmount; recorded_at: string }>;
};
export type BillingTeamOverviewV1 = {
  schema_version: 1; generated_at: string; subject: BillingSubjectRequest;
  team_scope: BillingTeamReadScopeV1;
  title: string; description: string;
  team: { id: string; name: string };
  product: { id: string; identifier: string; name: string };
  period: { month: string; starts_at: string; ends_at: string };
  sections: {
    activity: BillingOrganisationSectionV1<BillingTeamActivityV1>;
    recorded_credit_usage: BillingOrganisationSectionV1<BillingTeamRecordedUsageV1>;
    retained_credits: BillingOrganisationSectionV1<BillingTeamRetainedCreditsV1>;
  };
};
