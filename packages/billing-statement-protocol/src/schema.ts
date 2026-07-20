import { BILLING_STATEMENT_SCHEMA_PATH, BILLING_STATEMENT_SCHEMA_VERSION } from './types.js';

export type { BillingStatementAction, BillingStatementV1, ExactMoney } from './types.js';
export {
  BILLING_STATEMENT_EXAMPLE_PATH,
  BILLING_STATEMENT_OPENAPI_PATH,
  BILLING_STATEMENT_PROTOCOL_VERSION,
  BILLING_STATEMENT_SCHEMA_PATH,
  BILLING_STATEMENT_SCHEMA_VERSION,
} from './types.js';

const exactMoneyProperties = {
  amount: { type: 'string', pattern: '^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$' },
  currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  display: { type: 'string' },
} as const;

const exactMoneySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['amount', 'currency', 'display'],
  properties: exactMoneyProperties,
} as const;

const unitSetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['input', 'cached_input', 'output', 'total'],
  properties: {
    input: { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' },
    cached_input: { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' },
    output: { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' },
    total: { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' },
  },
} as const;

export const billingStatementV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: BILLING_STATEMENT_SCHEMA_PATH,
  title: 'UOA canonical customer billing statement',
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'statement_id',
    'generated_at',
    'product',
    'subject',
    'period',
    'pinned_inputs',
    'plan',
    'collection',
    'subscription',
    'services',
    'usage',
    'commercial_lines',
    'totals',
    'capabilities',
    'actions',
  ],
  properties: {
    schema_version: { const: BILLING_STATEMENT_SCHEMA_VERSION },
    statement_id: { type: 'string', pattern: '^bst_[A-Za-z0-9_-]+$' },
    generated_at: { type: 'string', format: 'date-time' },
    product: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'identifier', 'name'],
      properties: {
        id: { type: 'string' },
        identifier: { type: 'string' },
        name: { type: 'string' },
      },
    },
    subject: {
      type: 'object',
      additionalProperties: false,
      required: ['user_id', 'organisation_id', 'team_id'],
      properties: {
        user_id: { type: 'string' },
        organisation_id: { type: 'string' },
        team_id: { type: 'string' },
      },
    },
    period: {
      type: 'object',
      additionalProperties: false,
      required: ['key', 'starts_at', 'ends_at', 'state'],
      properties: {
        key: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' },
        starts_at: { type: 'string', format: 'date-time' },
        ends_at: { type: 'string', format: 'date-time' },
        state: { type: 'string', enum: ['open', 'closed'] },
      },
    },
    pinned_inputs: {
      type: 'object',
      additionalProperties: false,
      required: ['ledger_snapshots', 'tariff'],
      properties: {
        ledger_snapshots: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['group_by', 'cursor', 'id', 'captured_at', 'sha256'],
            properties: {
              group_by: { type: 'string', enum: ['service', 'user'] },
              cursor: { type: 'string' },
              id: { type: 'string' },
              captured_at: { type: 'string', format: 'date-time' },
              sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            },
          },
        },
        tariff: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'version'],
          properties: {
            id: { type: 'string' },
            version: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    plan: {
      type: 'object',
      additionalProperties: false,
      required: [
        'tariff_id',
        'key',
        'version',
        'name',
        'display_name',
        'mode',
        'collection_mode',
        'markup_bps',
        'markup_percent',
        'markup_display',
        'usage_multiplier_bps',
        'monthly_subscription',
        'assignment',
      ],
      properties: {
        tariff_id: { type: 'string' },
        key: { type: 'string' },
        version: { type: 'integer', minimum: 1 },
        name: { type: 'string' },
        display_name: { type: 'string' },
        mode: { type: 'string', enum: ['standard', 'free', 'at_cost', 'custom'] },
        collection_mode: { type: 'string', enum: ['stripe', 'manual', 'none'] },
        markup_bps: { type: 'integer', minimum: 0 },
        markup_percent: { type: 'string' },
        markup_display: { type: 'string' },
        usage_multiplier_bps: { type: 'integer', minimum: 0 },
        monthly_subscription: {
          type: 'object',
          additionalProperties: false,
          required: ['amount', 'currency', 'display', 'amount_minor'],
          properties: {
            ...exactMoneyProperties,
            amount_minor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
          },
        },
        assignment: {
          type: 'object',
          additionalProperties: false,
          required: ['scope', 'id'],
          properties: {
            scope: {
              type: 'string',
              enum: ['team', 'organisation', 'service_default'],
            },
            id: { type: ['string', 'null'] },
          },
        },
      },
    },
    collection: {
      type: 'object',
      additionalProperties: false,
      required: ['payment_collection_enabled', 'stripe_collection_enabled', 'stripe_mode'],
      properties: {
        payment_collection_enabled: { type: 'boolean' },
        stripe_collection_enabled: { type: 'boolean' },
        stripe_mode: { type: ['string', 'null'], enum: ['test', 'live', null] },
      },
    },
    subscription: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: [
        'id',
        'status',
        'display_status',
        'scope',
        'cancel_at_period_end',
        'current_period_start',
        'current_period_end',
      ],
      properties: {
        id: { type: 'string' },
        status: { type: 'string' },
        display_status: { type: 'string' },
        scope: { type: 'string', enum: ['team', 'organisation'] },
        cancel_at_period_end: { type: 'boolean' },
        current_period_start: { type: ['string', 'null'], format: 'date-time' },
        current_period_end: { type: ['string', 'null'], format: 'date-time' },
      },
    },
    services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product', 'name', 'display_name', 'access', 'direct_user_count', 'roles'],
        properties: {
          product: { type: 'string' },
          name: { type: ['string', 'null'] },
          display_name: { type: 'string' },
          access: { type: 'string', enum: ['direct', 'indirect'] },
          direct_user_count: { type: 'integer', minimum: 0 },
          roles: {
            type: 'array',
            uniqueItems: true,
            items: {
              type: 'string',
              enum: ['billing_product', 'caller_product', 'origin_product'],
            },
          },
        },
      },
    },
    usage: {
      type: 'object',
      additionalProperties: false,
      required: ['lines', 'totals', 'cost_totals', 'user_totals'],
      properties: {
        lines: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id',
              'service_id',
              'usage_unit',
              'calls',
              'attribution',
              'raw_units',
              'billable_units',
              'share',
              'provider_cost',
              'rated_charge',
            ],
            properties: {
              id: { type: 'string' },
              service_id: { type: 'string' },
              usage_unit: { type: 'string' },
              calls: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
              attribution: {
                type: 'object',
                additionalProperties: false,
                required: ['user_id', 'billing_product', 'caller_product', 'origin_product'],
                properties: {
                  user_id: { type: ['string', 'null'] },
                  billing_product: { type: 'string' },
                  caller_product: { type: 'string' },
                  origin_product: { type: 'string' },
                },
              },
              raw_units: unitSetSchema,
              billable_units: unitSetSchema,
              share: {
                type: 'object',
                additionalProperties: false,
                required: ['basis_points', 'percent', 'display'],
                properties: {
                  basis_points: { type: 'integer', minimum: 0, maximum: 10000 },
                  percent: { type: 'string' },
                  display: { type: 'string' },
                },
              },
              provider_cost: {
                anyOf: [
                  { type: 'null' },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['amount', 'currency', 'display', 'provenance'],
                    properties: {
                      ...exactMoneyProperties,
                      provenance: { type: 'string' },
                    },
                  },
                ],
              },
              rated_charge: {
                type: ['object', 'null'],
                additionalProperties: false,
                required: ['base', 'markup', 'total'],
                properties: {
                  base: exactMoneySchema,
                  markup: exactMoneySchema,
                  total: exactMoneySchema,
                },
              },
            },
          },
        },
        totals: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['usage_unit', 'raw_units', 'billable_units', 'display'],
            properties: {
              usage_unit: { type: 'string' },
              raw_units: { type: 'string' },
              billable_units: { type: 'string' },
              display: { type: 'string' },
            },
          },
        },
        cost_totals: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['currency', 'provider_cost', 'markup', 'usage_charge'],
            properties: {
              currency: { type: 'string' },
              provider_cost: exactMoneySchema,
              markup: exactMoneySchema,
              usage_charge: exactMoneySchema,
            },
          },
        },
        user_totals: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['user_id', 'name', 'email', 'calls', 'usage', 'costs'],
            properties: {
              user_id: { type: 'string' },
              name: { type: ['string', 'null'] },
              email: { type: 'string' },
              calls: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
              usage: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['usage_unit', 'raw_units', 'billable_units'],
                  properties: {
                    usage_unit: { type: 'string' },
                    raw_units: { type: 'string' },
                    billable_units: { type: 'string' },
                  },
                },
              },
              costs: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['currency', 'provider_cost', 'markup', 'usage_charge'],
                  properties: {
                    currency: { type: 'string' },
                    provider_cost: exactMoneySchema,
                    markup: exactMoneySchema,
                    usage_charge: exactMoneySchema,
                  },
                },
              },
            },
          },
        },
      },
    },
    commercial_lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'product', 'label', 'detail', 'amount'],
        properties: {
          id: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['monthly_subscription', 'usage', 'add_on', 'credit'],
          },
          product: { type: 'string' },
          label: { type: 'string' },
          detail: { type: 'string' },
          amount: exactMoneySchema,
        },
      },
    },
    totals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['currency', 'monthly', 'usage', 'add_ons', 'credits', 'total_due'],
        properties: {
          currency: { type: 'string' },
          monthly: exactMoneySchema,
          usage: exactMoneySchema,
          add_ons: exactMoneySchema,
          credits: exactMoneySchema,
          total_due: exactMoneySchema,
        },
      },
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      required: ['can_upgrade', 'can_open_portal', 'can_cancel'],
      properties: {
        can_upgrade: { type: 'boolean' },
        can_open_portal: { type: 'boolean' },
        can_cancel: { type: 'boolean' },
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'label', 'description', 'enabled', 'disabled_reason', 'request'],
        properties: {
          id: { type: 'string', enum: ['upgrade', 'portal', 'cancel'] },
          kind: { type: 'string', enum: ['hosted_redirect', 'confirmation_dialog'] },
          label: { type: 'string' },
          description: { type: 'string' },
          enabled: { type: 'boolean' },
          disabled_reason: { type: ['string', 'null'] },
          request: {
            type: 'object',
            additionalProperties: false,
            required: ['method', 'path', 'body'],
            properties: {
              method: { const: 'POST' },
              path: { type: 'string' },
              body: {
                type: 'object',
                additionalProperties: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
} as const;
