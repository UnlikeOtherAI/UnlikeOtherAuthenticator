import { creditAmountSchema } from './funding-schema-primitives.js';

const unsignedCredits = creditAmountSchema();
const positiveCredits = creditAmountSchema({ positive: true });
const signedCredits = creditAmountSchema({ signed: true });

const serviceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'identifier', 'name'],
  properties: {
    id: { type: 'string', minLength: 1 },
    identifier: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
  },
} as const;

const summaryBase = {
  type: 'object',
  additionalProperties: false,
  required: ['credits_added', 'credits_consumed', 'pending_credits', 'consumed_breakdown'],
  properties: {
    credits_added: unsignedCredits,
    credits_consumed: unsignedCredits,
    pending_credits: unsignedCredits,
  },
} as const;

export const billingCreditsManagerSummaryJsonSchema = {
  ...summaryBase,
  properties: {
    ...summaryBase.properties,
    consumed_breakdown: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['service', 'credits_consumed', 'unattributed_credits_consumed', 'users'],
        properties: {
          service: serviceSchema,
          credits_consumed: unsignedCredits,
          unattributed_credits_consumed: unsignedCredits,
          users: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['user_id', 'display_name', 'credits_consumed'],
              properties: {
                user_id: { type: 'string', minLength: 1 },
                display_name: { type: 'string' },
                credits_consumed: unsignedCredits,
              },
            },
          },
        },
      },
    },
  },
} as const;

export const billingCreditsMemberSummaryJsonSchema = {
  ...summaryBase,
  properties: {
    ...summaryBase.properties,
    consumed_breakdown: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'service',
          'credits_consumed',
          'viewer_credits_consumed',
          'other_team_members_credits_consumed',
          'unattributed_credits_consumed',
        ],
        properties: {
          service: serviceSchema,
          credits_consumed: unsignedCredits,
          viewer_credits_consumed: unsignedCredits,
          other_team_members_credits_consumed: unsignedCredits,
          unattributed_credits_consumed: unsignedCredits,
        },
      },
    },
  },
} as const;

const recentEntryBaseProperties = {
  id: { type: 'string', minLength: 1 },
  occurred_at: { type: 'string', format: 'date-time' },
  service: { anyOf: [serviceSchema, { type: 'null' }] },
  kind: {
    enum: [
      'top_up',
      'automatic_top_up',
      'usage_settlement',
      'usage_settlement_correction',
      'refund',
      'dispute',
      'refund_reversal',
      'dispute_reversal',
      'adjustment',
    ],
  },
  direction: { enum: ['credit', 'debit'] },
  label: { type: 'string' },
  detail: { type: 'string' },
  credits: positiveCredits,
  credit_balance_after: signedCredits,
} as const;

const recentEntryRequired = [
  'id',
  'occurred_at',
  'service',
  'attribution',
  'kind',
  'direction',
  'label',
  'detail',
  'credits',
  'credit_balance_after',
] as const;

export const billingCreditsManagerRecentEntriesJsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: recentEntryRequired,
    properties: {
      ...recentEntryBaseProperties,
      attribution: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'user_id', 'display_name'],
            properties: {
              kind: { const: 'user' },
              user_id: { type: 'string', minLength: 1 },
              display_name: { type: 'string' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind'],
            properties: { kind: { enum: ['unattributed', 'system', 'team_aggregate'] } },
          },
        ],
      },
    },
  },
} as const;

export const billingCreditsMemberRecentEntriesJsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: recentEntryRequired,
    properties: {
      ...recentEntryBaseProperties,
      attribution: {
        enum: ['viewer', 'other_team_members', 'unattributed', 'system', 'team_aggregate'],
      },
    },
  },
} as const;

export const billingCreditsManagerPaymentMethodJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'display'],
  properties: {
    status: { enum: ['missing', 'ready', 'requires_action', 'expired'] },
    display: { type: 'string' },
  },
} as const;

export const billingCreditsMemberPaymentMethodJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: {
    status: { enum: ['missing', 'ready', 'requires_action', 'expired'] },
  },
} as const;

export const billingCreditsManagerConsentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'version', 'consented_at', 'consented_by', 'description'],
  properties: {
    status: { enum: ['missing', 'current', 'outdated'] },
    version: { type: ['string', 'null'] },
    consented_at: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
    consented_by: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['display_name'],
          properties: { display_name: { type: 'string' } },
        },
        { type: 'null' },
      ],
    },
    description: { type: 'string' },
  },
} as const;

export const billingCreditsMemberConsentJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'version', 'consented_at'],
  properties: {
    status: { enum: ['missing', 'current', 'outdated'] },
    version: { type: ['string', 'null'] },
    consented_at: {
      anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
  },
} as const;

const optionActionVisibility = (actionSchema: Readonly<Record<string, unknown>>) => ({
  type: 'array',
  items: {
    type: 'object',
    required: ['setup_action', 'update_action'],
    properties: {
      setup_action: actionSchema,
      update_action: actionSchema,
    },
  },
});

export const billingCreditsVisibilityDiscriminatorJsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        viewer: {
          type: 'object',
          additionalProperties: false,
          required: ['role', 'usage_visibility', 'description'],
          properties: {
            role: { const: 'billing_manager' },
            usage_visibility: { const: 'full_team' },
            description: { type: 'string' },
          },
        },
        credit_summary: billingCreditsManagerSummaryJsonSchema,
        funding_policy: {
          type: 'object',
          properties: {
            offers: {
              type: 'array',
              items: { type: 'object', properties: { action: { type: 'object' } } },
            },
          },
        },
        automatic_top_up: {
          type: 'object',
          properties: {
            payment_method: billingCreditsManagerPaymentMethodJsonSchema,
            consent: billingCreditsManagerConsentJsonSchema,
            options: optionActionVisibility({ type: 'object' }),
          },
        },
        recent_entries: billingCreditsManagerRecentEntriesJsonSchema,
      },
    },
    {
      type: 'object',
      properties: {
        viewer: {
          type: 'object',
          additionalProperties: false,
          required: ['role', 'usage_visibility', 'description'],
          properties: {
            role: { const: 'member' },
            usage_visibility: { const: 'own_plus_team_aggregate' },
            description: { type: 'string' },
          },
        },
        capabilities: {
          type: 'object',
          additionalProperties: false,
          required: ['can_top_up', 'can_manage_automatic_top_up'],
          properties: {
            can_top_up: { const: false },
            can_manage_automatic_top_up: { const: false },
          },
        },
        credit_summary: billingCreditsMemberSummaryJsonSchema,
        funding_policy: {
          type: 'object',
          properties: {
            offers: {
              type: 'array',
              items: { type: 'object', properties: { action: { type: 'null' } } },
            },
          },
        },
        automatic_top_up: {
          type: 'object',
          properties: {
            payment_method: billingCreditsMemberPaymentMethodJsonSchema,
            consent: billingCreditsMemberConsentJsonSchema,
            options: optionActionVisibility({ type: 'null' }),
            disable_action: { type: 'null' },
            recover_action: { type: 'null' },
          },
        },
        recent_entries: billingCreditsMemberRecentEntriesJsonSchema,
      },
    },
  ],
} as const;
