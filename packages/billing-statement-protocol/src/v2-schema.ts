import { billingStatementV1JsonSchema } from './schema.js';
import {
  BILLING_STATEMENT_V2_SCHEMA_PATH,
  BILLING_STATEMENT_V2_SCHEMA_VERSION,
} from './v2-types.js';

const usageShareSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['basis_points', 'percent', 'display'],
  properties: {
    basis_points: { type: 'integer', minimum: 0, maximum: 10000 },
    percent: { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' },
    display: { type: 'string' },
  },
} as const;

const usageTotalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['usage_unit', 'raw_units', 'display'],
  properties: {
    usage_unit: { type: 'string' },
    raw_units: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
    display: { type: 'string' },
  },
} as const;

const usageContributionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['usage_unit', 'raw_units', 'display', 'share'],
  properties: {
    ...usageTotalSchema.properties,
    share: usageShareSchema,
  },
} as const;

const portfolioTotalsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['calls', 'usage'],
  properties: {
    calls: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
    usage: { type: 'array', items: usageTotalSchema },
  },
} as const;

const portfolioSnapshotSchema = (groupBy: 'service' | 'user') =>
  ({
    type: 'object',
    additionalProperties: false,
    required: ['contract', 'group_by', 'cursor', 'id', 'captured_at', 'sha256'],
    properties: {
      contract: { const: 'metering-portfolio-v1' },
      group_by: { const: groupBy },
      cursor: { type: 'string', pattern: '^mup_[A-Za-z0-9_-]{32}$' },
      id: { type: 'string', pattern: '^mup_[A-Za-z0-9_-]{32}$' },
      captured_at: { type: 'string', format: 'date-time' },
      sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
  }) as const;

const portfolioOriginSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'product',
    'name',
    'display_name',
    'is_statement_product',
    'calls',
    'call_share',
    'usage',
  ],
  properties: {
    product: { type: ['string', 'null'] },
    name: { type: ['string', 'null'] },
    display_name: { type: 'string' },
    is_statement_product: { type: 'boolean' },
    calls: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
    call_share: usageShareSchema,
    usage: { type: 'array', items: usageContributionSchema },
  },
} as const;

const portfolioUserSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'user_id',
    'name',
    'email',
    'display_name',
    'calls',
    'call_share',
    'usage',
  ],
  properties: {
    user_id: { type: ['string', 'null'] },
    name: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    display_name: { type: 'string' },
    calls: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
    call_share: usageShareSchema,
    usage: { type: 'array', items: usageContributionSchema },
  },
} as const;

const connectedServiceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'billing_product',
    'name',
    'display_name',
    'access',
    'direct_user_count',
    'title',
    'description',
    'totals',
    'origins',
    'users',
  ],
  properties: {
    billing_product: { type: 'string' },
    name: { type: ['string', 'null'] },
    display_name: { type: 'string' },
    access: { type: 'string', enum: ['direct', 'indirect'] },
    direct_user_count: { type: 'integer', minimum: 0 },
    title: { type: 'string' },
    description: { type: 'string' },
    totals: portfolioTotalsSchema,
    origins: { type: 'array', items: portfolioOriginSchema },
    users: { type: 'array', items: portfolioUserSchema },
  },
} as const;

const connectedServicePortfolioSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'statement_product', 'services'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    statement_product: { type: 'string' },
    services: { type: 'array', items: connectedServiceSchema },
  },
} as const;

const organisationTeamUsageSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'team_id',
    'team_name',
    'display_name',
    'pinned_ledger_snapshot',
    'connected_service_usage',
    'commercial_lines',
    'totals',
  ],
  properties: {
    team_id: { type: 'string', minLength: 1 },
    team_name: { type: 'string' },
    display_name: { type: 'string' },
    pinned_ledger_snapshot: portfolioSnapshotSchema('user'),
    connected_service_usage: connectedServicePortfolioSchema,
    commercial_lines: billingStatementV1JsonSchema.properties.commercial_lines,
    totals: billingStatementV1JsonSchema.properties.totals,
  },
} as const;

const organisationScopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'organisation_id',
    'organisation_name',
    'title',
    'description',
    'teams',
    'commercial_lines',
    'totals',
  ],
  properties: {
    organisation_id: { type: 'string', minLength: 1, maxLength: 256 },
    organisation_name: { type: 'string', minLength: 1 },
    title: { type: 'string' },
    description: { type: 'string' },
    teams: { type: 'array', items: organisationTeamUsageSchema },
    commercial_lines: billingStatementV1JsonSchema.properties.commercial_lines,
    totals: billingStatementV1JsonSchema.properties.totals,
  },
} as const;

export const billingStatementV2JsonSchema = {
  ...billingStatementV1JsonSchema,
  $id: BILLING_STATEMENT_V2_SCHEMA_PATH,
  title: 'UOA canonical customer billing statement with connected-service portfolio',
  required: [...billingStatementV1JsonSchema.required, 'connected_service_usage'],
  properties: {
    ...billingStatementV1JsonSchema.properties,
    schema_version: { const: BILLING_STATEMENT_V2_SCHEMA_VERSION },
    pinned_inputs: {
      type: 'object',
      additionalProperties: false,
      required: ['ledger_snapshots'],
      properties: {
        ledger_snapshots: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          prefixItems: [portfolioSnapshotSchema('user')],
          items: false,
        },
      },
    },
    connected_service_usage: connectedServicePortfolioSchema,
    // Optional and absent from `required`: present only for an organisation
    // billing manager while the override is active. Everything else in the
    // document stays the requested team's own truthful statement.
    organisation_scope: organisationScopeSchema,
  },
} as const;
