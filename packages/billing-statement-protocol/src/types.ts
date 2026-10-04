import type { BillingControlledByV1 } from './org-billing-types.js';

export const BILLING_STATEMENT_SCHEMA_VERSION = 1 as const;
export const BILLING_STATEMENT_SCHEMA_PATH = '/schemas/billing-statement-v1.json' as const;
export const BILLING_STATEMENT_EXAMPLE_PATH = '/schemas/billing-statement-v1.example.json' as const;
export const BILLING_STATEMENT_OPENAPI_PATH = '/schemas/billing-statement-v1.openapi.json' as const;
export const BILLING_STATEMENT_PROTOCOL_VERSION = '5.0.0' as const;

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
  };
  plan: {
    display_name: string;
    collection_mode: 'stripe' | 'manual' | 'none';
    usage_payment_mode: 'prepaid' | 'pay_as_you_go';
    monthly_subscription: ExactMoney & {
      amount_minor: string;
      charge_basis: 'flat' | 'per_seat';
      seat_policy: 'automatic' | 'fixed' | null;
      seat_timing: 'full_month' | 'prorated' | null;
      amount_role: 'monthly_total' | 'per_seat_unit';
    };
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
      attribution: {
        user_id: string | null;
        billing_product: string;
        caller_product: string;
        origin_product: string;
      };
      customer_charge: ExactMoney | null;
    }>;
    charge_totals: Array<{
      currency: string;
      usage_charge: ExactMoney;
    }>;
    user_totals: Array<{
      user_id: string;
      name: string | null;
      email: string;
      charges: Array<{
        currency: string;
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
  /**
   * Present only while the organisation has taken billing over from its teams
   * (protocol 1.3.0). While it is present the team's own `actions` are empty
   * and every capability is false, so a consumer that predates this field
   * renders a read-only statement rather than controls that would 403.
   */
  controlled_by?: BillingControlledByV1;
};
