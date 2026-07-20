import type { BillingStatementV1 } from './types.js';

export const billingStatementV1ConformanceFixture: BillingStatementV1 = {
  schema_version: 1,
  statement_id: 'bst_conformance_v1',
  generated_at: '2026-07-20T12:00:00.000Z',
  product: {
    id: 'service_deepwater_example',
    identifier: 'deepwater',
    name: 'DeepWater',
  },
  subject: {
    user_id: 'user_example',
    organisation_id: 'org_example',
    team_id: 'team_example',
  },
  period: {
    key: '2026-07',
    starts_at: '2026-07-01T00:00:00.000Z',
    ends_at: '2026-08-01T00:00:00.000Z',
    state: 'open',
  },
  pinned_inputs: {
    ledger_snapshots: [
      {
        group_by: 'service',
        cursor: 'mus_service_conformance_v1',
        id: 'mus_service_conformance_v1',
        captured_at: '2026-07-20T11:59:00.000Z',
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      {
        group_by: 'user',
        cursor: 'mus_user_conformance_v1',
        id: 'mus_user_conformance_v1',
        captured_at: '2026-07-20T11:59:00.000Z',
        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    ],
    tariff: {
      id: 'tariff_standard_example',
      version: 4,
    },
  },
  plan: {
    tariff_id: 'tariff_standard_example',
    key: 'standard',
    version: 4,
    name: 'Standard',
    display_name: 'Standard · v4',
    mode: 'standard',
    collection_mode: 'stripe',
    markup_bps: 2000,
    markup_percent: '20.00',
    markup_display: '20.00%',
    usage_multiplier_bps: 12000,
    monthly_subscription: {
      amount: '20',
      amount_minor: '2000',
      currency: 'GBP',
      display: '£20',
    },
    assignment: {
      scope: 'team',
      id: 'assignment_example',
    },
  },
  collection: {
    payment_collection_enabled: true,
    stripe_collection_enabled: true,
    stripe_mode: 'test',
  },
  subscription: {
    id: 'subscription_example',
    status: 'active',
    display_status: 'active',
    scope: 'team',
    cancel_at_period_end: false,
    current_period_start: '2026-07-01T00:00:00.000Z',
    current_period_end: '2026-08-01T00:00:00.000Z',
  },
  services: [
    {
      product: 'deepwater',
      name: 'DeepWater',
      display_name: 'DeepWater',
      access: 'direct',
      direct_user_count: 2,
      roles: ['billing_product'],
    },
    {
      product: 'nessie',
      name: 'Nessie',
      display_name: 'Nessie',
      access: 'indirect',
      direct_user_count: 0,
      roles: ['caller_product', 'origin_product'],
    },
  ],
  usage: {
    lines: [
      {
        id: 'usage_openai_example',
        service_id: 'openai',
        usage_unit: 'tokens',
        calls: '2',
        attribution: {
          user_id: null,
          billing_product: 'deepwater',
          caller_product: 'nessie',
          origin_product: 'nessie',
        },
        raw_units: {
          input: '100',
          cached_input: '0',
          output: '50',
          total: '150',
        },
        billable_units: {
          input: '120',
          cached_input: '0',
          output: '60',
          total: '180',
        },
        share: {
          basis_points: 10000,
          percent: '100.00',
          display: '100.00%',
        },
        provider_cost: {
          amount: '3',
          currency: 'USD',
          display: '$3',
          provenance: 'provider_invoice',
        },
        rated_charge: {
          base: {
            amount: '3',
            currency: 'USD',
            display: '$3',
          },
          markup: {
            amount: '0.6',
            currency: 'USD',
            display: '$0.6',
          },
          total: {
            amount: '3.6',
            currency: 'USD',
            display: '$3.6',
          },
        },
      },
    ],
    totals: [
      {
        usage_unit: 'tokens',
        raw_units: '150',
        billable_units: '180',
        display: '180 billable tokens (150 raw)',
      },
    ],
    cost_totals: [
      {
        currency: 'USD',
        provider_cost: {
          amount: '3',
          currency: 'USD',
          display: '$3',
        },
        markup: {
          amount: '0.6',
          currency: 'USD',
          display: '$0.6',
        },
        usage_charge: {
          amount: '3.6',
          currency: 'USD',
          display: '$3.6',
        },
      },
    ],
    user_totals: [
      {
        user_id: 'user_example',
        name: 'Example User',
        email: 'example@example.invalid',
        calls: '2',
        usage: [
          {
            usage_unit: 'tokens',
            raw_units: '150',
            billable_units: '180',
          },
        ],
        costs: [
          {
            currency: 'USD',
            provider_cost: {
              amount: '3',
              currency: 'USD',
              display: '$3',
            },
            markup: {
              amount: '0.6',
              currency: 'USD',
              display: '$0.6',
            },
            usage_charge: {
              amount: '3.6',
              currency: 'USD',
              display: '$3.6',
            },
          },
        ],
      },
    ],
  },
  commercial_lines: [
    {
      id: 'monthly_subscription_example',
      kind: 'monthly_subscription',
      product: 'deepwater',
      label: 'Standard monthly subscription',
      detail: 'Standard · v4',
      amount: {
        amount: '20',
        currency: 'GBP',
        display: '£20',
      },
    },
    {
      id: 'usage_usd_example',
      kind: 'usage',
      product: 'deepwater',
      label: 'Usage',
      detail: 'Provider cost plus 20.00% markup',
      amount: {
        amount: '3.6',
        currency: 'USD',
        display: '$3.6',
      },
    },
  ],
  totals: [
    {
      currency: 'GBP',
      monthly: {
        amount: '20',
        currency: 'GBP',
        display: '£20',
      },
      usage: {
        amount: '0',
        currency: 'GBP',
        display: '£0',
      },
      add_ons: {
        amount: '0',
        currency: 'GBP',
        display: '£0',
      },
      credits: {
        amount: '0',
        currency: 'GBP',
        display: '£0',
      },
      total_due: {
        amount: '20',
        currency: 'GBP',
        display: '£20',
      },
    },
    {
      currency: 'USD',
      monthly: {
        amount: '0',
        currency: 'USD',
        display: '$0',
      },
      usage: {
        amount: '3.6',
        currency: 'USD',
        display: '$3.6',
      },
      add_ons: {
        amount: '0',
        currency: 'USD',
        display: '$0',
      },
      credits: {
        amount: '0',
        currency: 'USD',
        display: '$0',
      },
      total_due: {
        amount: '3.6',
        currency: 'USD',
        display: '$3.6',
      },
    },
  ],
  capabilities: {
    can_upgrade: false,
    can_open_portal: true,
    can_cancel: true,
  },
  actions: [
    {
      id: 'upgrade',
      kind: 'hosted_redirect',
      label: 'Change plan',
      description: 'Plan changes are unavailable for this tariff.',
      enabled: false,
      disabled_reason: 'No alternative tariff is available.',
      request: {
        method: 'POST',
        path: '/billing/v1/stripe/checkout-session',
        body: {
          product: 'deepwater',
          organisation_id: 'org_example',
          team_id: 'team_example',
          user_id: 'user_example',
        },
      },
    },
    {
      id: 'portal',
      kind: 'hosted_redirect',
      label: 'Manage payment method',
      description: 'Open the hosted Stripe billing portal.',
      enabled: true,
      disabled_reason: null,
      request: {
        method: 'POST',
        path: '/billing/v1/stripe/portal-session',
        body: {
          product: 'deepwater',
          organisation_id: 'org_example',
          team_id: 'team_example',
          user_id: 'user_example',
        },
      },
    },
    {
      id: 'cancel',
      kind: 'confirmation_dialog',
      label: 'Cancel subscription',
      description: 'Review the exact direct subscriptions before confirming.',
      enabled: true,
      disabled_reason: null,
      request: {
        method: 'POST',
        path: '/billing/v1/cancellation/preview',
        body: {
          product: 'deepwater',
          organisation_id: 'org_example',
          team_id: 'team_example',
          user_id: 'user_example',
        },
      },
    },
  ],
};
