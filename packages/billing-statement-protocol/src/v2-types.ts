import type { BillingStatementV1, ExactMoney } from './types.js';

export const BILLING_STATEMENT_V2_SCHEMA_VERSION = 2 as const;
export const BILLING_STATEMENT_V2_PROTOCOL_VERSION = '2.0.0' as const;
export const BILLING_STATEMENT_V2_SCHEMA_PATH = '/schemas/billing-statement-v2.json' as const;
export const BILLING_STATEMENT_V2_EXAMPLE_PATH =
  '/schemas/billing-statement-v2.example.json' as const;
export const BILLING_STATEMENT_V2_OPENAPI_PATH =
  '/schemas/billing-statement-v2.openapi.json' as const;

export type BillingUsageShare = {
  basis_points: number;
  percent: string;
  display: string;
};

export type BillingPortfolioUsageTotal = {
  usage_unit: string;
  raw_units: string;
  display: string;
};

export type BillingPortfolioUsageContribution = BillingPortfolioUsageTotal & {
  share: BillingUsageShare;
};

export type BillingPortfolioCostTotal = {
  currency: string;
  provider_cost: ExactMoney;
  display: string;
};

export type BillingPortfolioCostContribution = BillingPortfolioCostTotal & {
  share: BillingUsageShare | null;
};

export type BillingPortfolioTotals = {
  calls: string;
  usage: BillingPortfolioUsageTotal[];
  provider_costs: BillingPortfolioCostTotal[];
};

export type BillingPortfolioOrigin = {
  product: string | null;
  name: string | null;
  display_name: string;
  is_statement_product: boolean;
  calls: string;
  call_share: BillingUsageShare;
  usage: BillingPortfolioUsageContribution[];
  provider_costs: BillingPortfolioCostContribution[];
};

export type BillingPortfolioUser = {
  user_id: string | null;
  name: string | null;
  email: string | null;
  display_name: string;
  calls: string;
  call_share: BillingUsageShare;
  usage: BillingPortfolioUsageContribution[];
  provider_costs: BillingPortfolioCostContribution[];
};

export type BillingConnectedServiceUsage = {
  billing_product: string;
  name: string | null;
  display_name: string;
  access: 'direct' | 'indirect';
  direct_user_count: number;
  title: string;
  description: string;
  totals: BillingPortfolioTotals;
  origins: BillingPortfolioOrigin[];
  users: BillingPortfolioUser[];
};

export type BillingConnectedServicePortfolio = {
  title: string;
  description: string;
  statement_product: string;
  services: BillingConnectedServiceUsage[];
};

export type BillingPortfolioSnapshot<Group extends 'service' | 'user'> = {
  contract: 'metering-portfolio-v1';
  group_by: Group;
  cursor: string;
  id: string;
  captured_at: string;
  sha256: string;
};

/**
 * One team inside an organisation-wide roll-up (protocol 1.3.0). Every field is
 * that team's own display-ready statement material, produced by exactly the
 * pipeline that produces a single-team statement, from that team's own pinned
 * Ledger portfolio snapshot.
 */
export type BillingOrganisationTeamUsageV1 = {
  team_id: string;
  team_name: string;
  display_name: string;
  pinned_ledger_snapshot: BillingPortfolioSnapshot<'user'>;
  connected_service_usage: BillingConnectedServicePortfolio;
  commercial_lines: BillingStatementV1['commercial_lines'];
  totals: BillingStatementV1['totals'];
};

/**
 * The organisation-wide view, present only when the organisation has taken
 * billing over AND UOA has verified the caller is an organisation billing
 * manager. It sits beside — never in place of — the requested team's own
 * statement fields, so a consumer that predates this field keeps reading
 * truthful per-team numbers instead of silently reading organisation-wide ones
 * as if they were the team's.
 *
 * `totals` is the same `commercial_lines` summation UOA already performs for
 * one team, applied to every team's lines: no new rating and no new arithmetic
 * enters the path, and nothing here is ever computed by a product.
 */
export type BillingOrganisationScopeV1 = {
  organisation_id: string;
  organisation_name: string;
  title: string;
  description: string;
  teams: BillingOrganisationTeamUsageV1[];
  commercial_lines: BillingStatementV1['commercial_lines'];
  totals: BillingStatementV1['totals'];
};

export type BillingStatementV2 = Omit<BillingStatementV1, 'schema_version' | 'pinned_inputs'> & {
  schema_version: typeof BILLING_STATEMENT_V2_SCHEMA_VERSION;
  pinned_inputs: {
    ledger_snapshots: [BillingPortfolioSnapshot<'user'>];
    tariff: { id: string; version: number };
  };
  connected_service_usage: BillingConnectedServicePortfolio;
  organisation_scope?: BillingOrganisationScopeV1;
};
