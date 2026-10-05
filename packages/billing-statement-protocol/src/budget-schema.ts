import { BILLING_CREDIT_BUDGET_SCHEMA_PATH } from './budget-types.js';

const credits = { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]{1,6})?$' } as const;
const policyProperties = {
  scope_type: { enum: ['organization', 'team', 'project', 'run'] },
  scope_id: { type: 'string', minLength: 1, maxLength: 256 },
  period: { enum: ['weekly', 'monthly', 'yearly', 'per_run'] },
  mode: { enum: ['off', 'warn', 'enforce', 'degrade', 'unlimited'] },
  limit_credits: { anyOf: [credits, { type: 'null' }] },
  warn_threshold_percent: { type: 'number', minimum: 0, maximum: 100 },
  block_humans_when_over: { type: 'boolean' },
  degrade_model: { type: ['string', 'null'] },
  degrade_provider: { type: ['string', 'null'] },
} as const;
const policyRequired = Object.keys(policyProperties);
const subjectProperties = {
  product: { type: 'string', minLength: 1, maxLength: 256 },
  organization_id: { type: 'string', minLength: 1, maxLength: 256 },
  team_id: { type: 'string', minLength: 1, maxLength: 256 },
} as const;

export const billingCreditBudgetV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: BILLING_CREDIT_BUDGET_SCHEMA_PATH,
  title: 'Customer credit budget management',
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'product', 'organization_id', 'team_id', 'budgets'],
  properties: {
    schema_version: { const: 1 },
    ...subjectProperties,
    budgets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        allOf: [{ if: { properties: { evidence_complete: { const: false } },
          required: ['evidence_complete'] }, then: { properties: {
          remaining_credits: { type: 'null' }, percent_used: { type: 'null' },
        } } }],
        required: [...policyRequired, 'policy_id', 'version', 'spent_credits',
          'held_credits', 'evidence_complete', 'remaining_credits', 'percent_used',
          'effective_window_start', 'effective_window_end'],
        properties: {
          ...policyProperties,
          policy_id: { type: 'string', minLength: 1, maxLength: 256 },
          version: { type: 'integer', minimum: 1 },
          spent_credits: credits,
          held_credits: credits,
          evidence_complete: { type: 'boolean' },
          remaining_credits: { anyOf: [credits, { type: 'null' }] },
          percent_used: { type: ['number', 'null'], minimum: 0 },
          effective_window_start: { type: 'string', format: 'date-time' },
          effective_window_end: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  },
} as const;

export const billingCreditBudgetWriteV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: [...Object.keys(subjectProperties), ...policyRequired],
  properties: {
    ...subjectProperties,
    ...policyProperties,
    expected_version: { type: ['integer', 'null'], minimum: 1 },
  },
} as const;

export const billingCreditBudgetDeleteV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['expected_version'],
  properties: { expected_version: { type: 'integer', minimum: 1 } },
} as const;
