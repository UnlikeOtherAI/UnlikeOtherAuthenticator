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

export type BillingStatementV2 = Omit<BillingStatementV1, 'schema_version' | 'pinned_inputs'> & {
  schema_version: typeof BILLING_STATEMENT_V2_SCHEMA_VERSION;
  pinned_inputs: {
    ledger_snapshots: [BillingPortfolioSnapshot<'user'>];
    tariff: { id: string; version: number };
  };
  connected_service_usage: BillingConnectedServicePortfolio;
};
