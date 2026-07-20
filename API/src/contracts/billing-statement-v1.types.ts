export const BILLING_STATEMENT_SCHEMA_VERSION = 1 as const;
export const BILLING_STATEMENT_SCHEMA_PATH = '/schemas/billing-statement-v1.json' as const;

export type ExactMoney = {
  amount: string;
  currency: string;
  display: string;
};

export type BillingStatementAction = {
  id: 'upgrade' | 'portal' | 'cancel';
  kind: 'hosted_redirect' | 'confirmation_dialog';
  label: string;
  description: string;
  enabled: boolean;
  disabled_reason: string | null;
  request: {
    method: 'POST';
    path: string;
    body: Record<string, string>;
  };
};

export type BillingStatementV1 = {
  schema_version: typeof BILLING_STATEMENT_SCHEMA_VERSION;
  statement_id: string;
  generated_at: string;
  product: { id: string; identifier: string; name: string };
  subject: { user_id: string; organisation_id: string; team_id: string };
  period: {
    key: string;
    starts_at: string;
    ends_at: string;
    state: 'open' | 'closed';
  };
  pinned_inputs: {
    ledger_snapshots: Array<{
      group_by: 'service' | 'user';
      cursor: string;
      id: string;
      captured_at: string;
      sha256: string;
    }>;
    tariff: { id: string; version: number };
  };
  plan: {
    tariff_id: string;
    key: string;
    version: number;
    name: string;
    display_name: string;
    mode: 'standard' | 'free' | 'at_cost' | 'custom';
    collection_mode: 'stripe' | 'manual' | 'none';
    markup_bps: number;
    markup_percent: string;
    markup_display: string;
    usage_multiplier_bps: number;
    monthly_subscription: ExactMoney & { amount_minor: string };
    assignment: {
      scope: 'team' | 'organisation' | 'service_default';
      id: string | null;
    };
  };
  collection: {
    payment_collection_enabled: boolean;
    stripe_collection_enabled: boolean;
    stripe_mode: 'test' | 'live' | null;
  };
  subscription: {
    id: string;
    status: string;
    display_status: string;
    scope: 'team' | 'organisation';
    cancel_at_period_end: boolean;
    current_period_start: string | null;
    current_period_end: string | null;
  } | null;
  services: Array<{
    product: string;
    name: string | null;
    display_name: string;
    access: 'direct' | 'indirect';
    direct_user_count: number;
    roles: Array<'billing_product' | 'caller_product' | 'origin_product'>;
  }>;
  usage: {
    lines: Array<{
      id: string;
      service_id: string;
      usage_unit: string;
      calls: string;
      attribution: {
        user_id: string | null;
        billing_product: string;
        caller_product: string;
        origin_product: string;
      };
      raw_units: {
        input: string;
        cached_input: string;
        output: string;
        total: string;
      };
      billable_units: {
        input: string;
        cached_input: string;
        output: string;
        total: string;
      };
      share: {
        basis_points: number;
        percent: string;
        display: string;
      };
      provider_cost: (ExactMoney & { provenance: string }) | null;
      rated_charge: {
        base: ExactMoney;
        markup: ExactMoney;
        total: ExactMoney;
      } | null;
    }>;
    totals: Array<{
      usage_unit: string;
      raw_units: string;
      billable_units: string;
      display: string;
    }>;
    cost_totals: Array<{
      currency: string;
      provider_cost: ExactMoney;
      markup: ExactMoney;
      usage_charge: ExactMoney;
    }>;
    user_totals: Array<{
      user_id: string;
      name: string | null;
      email: string;
      calls: string;
      usage: Array<{
        usage_unit: string;
        raw_units: string;
        billable_units: string;
      }>;
      costs: Array<{
        currency: string;
        provider_cost: ExactMoney;
        markup: ExactMoney;
        usage_charge: ExactMoney;
      }>;
    }>;
  };
  commercial_lines: Array<{
    id: string;
    kind: 'monthly_subscription' | 'usage' | 'add_on' | 'credit';
    product: string;
    label: string;
    detail: string;
    amount: ExactMoney;
  }>;
  totals: Array<{
    currency: string;
    monthly: ExactMoney;
    usage: ExactMoney;
    add_ons: ExactMoney;
    credits: ExactMoney;
    total_due: ExactMoney;
  }>;
  capabilities: {
    can_upgrade: boolean;
    can_open_portal: boolean;
    can_cancel: boolean;
  };
  actions: BillingStatementAction[];
};
