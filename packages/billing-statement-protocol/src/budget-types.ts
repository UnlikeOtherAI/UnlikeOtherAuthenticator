/** Customer credit budgets. Raw usage and private rating terms are never public. */
export const BILLING_CREDIT_BUDGET_PROTOCOL_VERSION = '1.0.0' as const;
export const BILLING_CREDIT_BUDGET_SCHEMA_VERSION = 1 as const;
export const BILLING_CREDIT_BUDGET_SCHEMA_PATH = '/schemas/billing-credit-budgets-v1.json' as const;
export const BILLING_CREDIT_BUDGET_EXAMPLE_PATH =
  '/schemas/billing-credit-budgets-v1.example.json' as const;
export const BILLING_CREDIT_BUDGET_OPENAPI_PATH =
  '/schemas/billing-credit-budgets-v1.openapi.json' as const;
export const BILLING_CREDIT_BUDGET_LIST_PATH = '/billing/v1/credit-budgets' as const;

export type BillingCreditBudgetPolicyV1 = {
  scope_type: 'organization' | 'team' | 'project' | 'run';
  scope_id: string;
  period: 'weekly' | 'monthly' | 'yearly' | 'per_run';
  mode: 'off' | 'warn' | 'enforce' | 'degrade' | 'unlimited';
  limit_credits: string | null;
  warn_threshold_percent: number;
  block_humans_when_over: boolean;
  degrade_model: string | null;
  degrade_provider: string | null;
};

export type BillingCreditBudgetV1 = BillingCreditBudgetPolicyV1 & {
  policy_id: string;
  version: number;
  spent_credits: string;
  held_credits: string;
  /** False means spent is only the known subset and remaining is unknown. */
  evidence_complete: boolean;
  remaining_credits: string | null;
  percent_used: number | null;
  effective_window_start: string;
  effective_window_end: string | null;
};

export type BillingCreditBudgetListV1 = {
  schema_version: typeof BILLING_CREDIT_BUDGET_SCHEMA_VERSION;
  product: string;
  organization_id: string;
  team_id: string;
  budgets: BillingCreditBudgetV1[];
};

export type BillingCreditBudgetWriteV1 = BillingCreditBudgetPolicyV1 & {
  product: string;
  organization_id: string;
  team_id: string;
  expected_version?: number | null;
};

export type BillingCreditBudgetDeleteV1 = { expected_version: number };
export type BillingCreditBudgetDisabledV1 = {
  policy_id: string;
  version: number;
  status: 'disabled';
};
