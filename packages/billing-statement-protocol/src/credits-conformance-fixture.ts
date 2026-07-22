import type { BillingCreditsV1 } from './credits-types.js';

const subject = {
  organisation_id: 'org_example',
  team_id: 'team_example',
  user_id: 'user_example',
};
const requestSubject = { product: 'deepwater', ...subject };

const optionId = 'cto_deepwater_5000_20000_100';
const deepWater = { id: 'service_deepwater', identifier: 'deepwater', name: 'DeepWater' };

export const billingCreditsV1ConformanceFixture: BillingCreditsV1 = {
  schema_version: 1,
  credit_account_id: 'bca_conformance',
  generated_at: '2026-07-21T12:00:00.000Z',
  storefront: deepWater,
  subject: {
    user_id: subject.user_id,
    organisation_id: subject.organisation_id,
    team_id: subject.team_id,
  },
  viewer: {
    role: 'billing_manager',
    usage_visibility: 'full_team',
    description: 'This viewer may see the full team breakdown and manage funding.',
  },
  capabilities: {
    can_top_up: true,
    can_manage_automatic_top_up: true,
  },
  conversion: {
    credits_per_usd: '1000',
    settlement_currency: 'USD',
    description:
      '1,000 credits always equal US$1.00. Usage is accumulated exactly, but only complete credits are deducted.',
  },
  current_period: {
    starts_at: '2026-07-01T00:00:00.000Z',
    ends_at: '2026-08-01T00:00:00.000Z',
  },
  collection: { stripe_collection_enabled: true, stripe_mode: 'test' },
  credit_balance: {
    credits: '34125',
    display: '34,125 credits',
    usd_equivalent: { amount: '34.125', currency: 'USD', display: 'US$34.125' },
    state: 'available',
    label: 'Remaining credits',
    description: '34,125 credits are shared by this team across connected services.',
  },
  pending_credits: {
    top_up_count: 1,
    payment_amount: {
      amount: '20',
      amount_minor: '2000',
      currency: 'USD',
      display: 'US$20.00',
    },
    credits_received: {
      credits: '20000',
      display: '20,000 credits',
      usd_equivalent: { amount: '20', currency: 'USD', display: 'US$20.00' },
    },
    label: '20,000 credits pending',
    description:
      'One top-up is awaiting verified payment and is not included in available credits.',
  },
  credit_summary: {
    credits_added: {
      credits: '42000',
      display: '42,000 credits',
      usd_equivalent: { amount: '42', currency: 'USD', display: 'US$42.00' },
    },
    credits_consumed: {
      credits: '7875',
      display: '7,875 credits',
      usd_equivalent: { amount: '7.875', currency: 'USD', display: 'US$7.875' },
    },
    pending_credits: {
      credits: '20000',
      display: '20,000 credits',
      usd_equivalent: { amount: '20', currency: 'USD', display: 'US$20.00' },
    },
    consumed_breakdown: [
      {
        service: deepWater,
        credits_consumed: {
          credits: '5000',
          display: '5,000 credits',
          usd_equivalent: { amount: '5', currency: 'USD', display: 'US$5.00' },
        },
        unattributed_credits_consumed: {
          credits: '0',
          display: '0 credits',
          usd_equivalent: { amount: '0', currency: 'USD', display: 'US$0.00' },
        },
        users: [
          {
            user_id: 'user_researcher',
            display_name: 'Researcher',
            credits_consumed: {
              credits: '5000',
              display: '5,000 credits',
              usd_equivalent: { amount: '5', currency: 'USD', display: 'US$5.00' },
            },
          },
        ],
      },
      {
        service: { id: 'service_nessie', identifier: 'nessie', name: 'Nessie' },
        credits_consumed: {
          credits: '2875',
          display: '2,875 credits',
          usd_equivalent: { amount: '2.875', currency: 'USD', display: 'US$2.875' },
        },
        unattributed_credits_consumed: {
          credits: '2375',
          display: '2,375 credits',
          usd_equivalent: { amount: '2.375', currency: 'USD', display: 'US$2.375' },
        },
        users: [
          {
            user_id: subject.user_id,
            display_name: 'Example User',
            credits_consumed: {
              credits: '500',
              display: '500 credits',
              usd_equivalent: { amount: '0.5', currency: 'USD', display: 'US$0.50' },
            },
          },
        ],
      },
    ],
  },
  funding_policy: {
    top_up_enabled: true,
    automatic_top_up_enabled: true,
    title: 'Add team credits',
    description:
      'Credits fund metered usage across connected services. Subscriptions and add-ons remain separate.',
    offers: [
      {
        id: 'cto_deepwater_20000',
        key: 'credits-20000',
        name: '20,000 credits',
        description: 'Pay US$20.00 and receive exactly 20,000 credits.',
        payment_amount: {
          amount: '20',
          amount_minor: '2000',
          currency: 'USD',
          display: 'US$20.00',
        },
        credits_received: {
          credits: '20000',
          display: '20,000 credits',
          usd_equivalent: { amount: '20', currency: 'USD', display: 'US$20.00' },
        },
        available: true,
        unavailable_reason: null,
        action: {
          id: 'top_up',
          kind: 'hosted_redirect',
          label: 'Buy 20,000 credits for US$20.00',
          description:
            'Open secure Checkout; credits become available only after UOA verifies payment.',
          enabled: true,
          disabled_reason: null,
          request: {
            method: 'POST',
            path: '/billing/v1/credits/top-up-checkout',
            body: { ...requestSubject, offer_id: 'cto_deepwater_20000' },
          },
        },
      },
    ],
  },
  automatic_top_up: {
    state: 'active',
    display_status: 'Automatic top-up is active',
    description:
      'When the team balance falls below 5,000 credits, UOA may charge US$20.00 for 20,000 credits, up to US$100.00 monthly.',
    threshold: {
      credits: '5000',
      display: '5,000 credits',
      usd_equivalent: { amount: '5', currency: 'USD', display: 'US$5.00' },
    },
    refill_offer_id: 'cto_deepwater_20000',
    monthly_cap: {
      amount: '100',
      amount_minor: '10000',
      currency: 'USD',
      display: 'US$100.00',
    },
    charged_this_month: {
      amount: '40',
      amount_minor: '4000',
      currency: 'USD',
      display: 'US$40.00',
    },
    remaining_monthly_cap: {
      amount: '60',
      amount_minor: '6000',
      currency: 'USD',
      display: 'US$60.00',
    },
    payment_method: { status: 'ready', display: 'Visa ending in 4242' },
    consent: {
      status: 'current',
      version: 'credits-auto-top-up-2026-07',
      consented_at: '2026-07-21T10:00:00.000Z',
      consented_by: { display_name: 'Example User' },
      description: 'Consent covers the displayed threshold, refill offer, and monthly cap.',
    },
    options: [
      {
        selected: true,
        label: '20,000 below 5,000; US$100 monthly cap',
        description: 'A bounded UOA option; products cannot submit arbitrary amounts.',
        threshold: {
          credits: '5000',
          display: '5,000 credits',
          usd_equivalent: { amount: '5', currency: 'USD', display: 'US$5.00' },
        },
        refill_offer_id: 'cto_deepwater_20000',
        refill_payment_amount: {
          amount: '20',
          amount_minor: '2000',
          currency: 'USD',
          display: 'US$20.00',
        },
        refill_credits_received: {
          credits: '20000',
          display: '20,000 credits',
          usd_equivalent: { amount: '20', currency: 'USD', display: 'US$20.00' },
        },
        monthly_cap: {
          amount: '100',
          amount_minor: '10000',
          currency: 'USD',
          display: 'US$100.00',
        },
        setup_action: {
          id: 'auto_top_up_setup',
          kind: 'hosted_redirect',
          label: 'Set up automatic top-up',
          description: 'Review and consent to this exact option in secure Checkout.',
          enabled: false,
          disabled_reason: 'Automatic top-up already has a verified payment method.',
          request: {
            method: 'POST',
            path: '/billing/v1/credits/auto-top-up/setup',
            body: { ...requestSubject, option_id: optionId },
          },
        },
        update_action: {
          id: 'auto_top_up_update',
          kind: 'mutation',
          label: 'Use this automatic top-up option',
          description: 'Select only this UOA-defined threshold, refill, and cap combination.',
          enabled: true,
          disabled_reason: null,
          request: {
            method: 'POST',
            path: '/billing/v1/credits/auto-top-up/update',
            body: { ...requestSubject, option_id: optionId },
          },
        },
      },
    ],
    disable_action: {
      id: 'auto_top_up_disable',
      kind: 'mutation',
      label: 'Turn off automatic top-up',
      description: 'Stop future automatic charges without changing available credits.',
      enabled: true,
      disabled_reason: null,
      request: {
        method: 'POST',
        path: '/billing/v1/credits/auto-top-up/disable',
        body: requestSubject,
      },
    },
    recover_action: {
      id: 'auto_top_up_recover',
      kind: 'hosted_redirect',
      label: 'Review payment',
      description: 'Open UOA recovery when a payment requires customer action or review.',
      enabled: false,
      disabled_reason: 'No automatic top-up currently requires recovery.',
      request: {
        method: 'POST',
        path: '/billing/v1/credits/auto-top-up/recover',
        body: requestSubject,
      },
    },
  },
  recent_entries: [
    {
      id: 'bce_usage_example',
      occurred_at: '2026-07-21T11:30:00.000Z',
      service: deepWater,
      attribution: { kind: 'team_aggregate' },
      kind: 'usage_settlement',
      direction: 'debit',
      label: 'DeepWater usage',
      detail: '5,000 credits were consumed by team-rated DeepWater usage; see the user breakdown.',
      credits: {
        credits: '5000',
        display: '5,000 credits',
        usd_equivalent: { amount: '5', currency: 'USD', display: 'US$5.00' },
      },
      credit_balance_after: {
        credits: '34125',
        display: '34,125 credits',
        usd_equivalent: { amount: '34.125', currency: 'USD', display: 'US$34.125' },
      },
    },
    {
      id: 'bce_topup_example',
      occurred_at: '2026-07-20T09:00:00.000Z',
      service: { id: 'service_nessie', identifier: 'nessie', name: 'Nessie' },
      attribution: {
        kind: 'user',
        user_id: subject.user_id,
        display_name: 'Example User',
      },
      kind: 'top_up',
      direction: 'credit',
      label: 'Team credits added from Nessie',
      detail: 'A verified US$20.00 payment added exactly 20,000 shared team credits.',
      credits: {
        credits: '20000',
        display: '20,000 credits',
        usd_equivalent: { amount: '20', currency: 'USD', display: 'US$20.00' },
      },
      credit_balance_after: {
        credits: '39125',
        display: '39,125 credits',
        usd_equivalent: { amount: '39.125', currency: 'USD', display: 'US$39.125' },
      },
    },
    {
      id: 'bce_admin_adjustment_example',
      occurred_at: '2026-07-15T08:00:00.000Z',
      service: null,
      attribution: { kind: 'system' },
      kind: 'adjustment',
      direction: 'credit',
      label: 'Account credit adjustment',
      detail: '22,000 shared team credits were granted by UOA support.',
      credits: {
        credits: '22000',
        display: '22,000 credits',
        usd_equivalent: { amount: '22', currency: 'USD', display: 'US$22.00' },
      },
      credit_balance_after: {
        credits: '19125',
        display: '19,125 credits',
        usd_equivalent: { amount: '19.125', currency: 'USD', display: 'US$19.125' },
      },
    },
  ],
};
