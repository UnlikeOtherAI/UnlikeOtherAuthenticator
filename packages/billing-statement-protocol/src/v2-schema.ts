import { billingStatementV1JsonSchema } from './schema.js';
import {
  BILLING_STATEMENT_V2_SCHEMA_PATH,
  BILLING_STATEMENT_V2_SCHEMA_VERSION,
} from './v2-types.js';

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

const organisationTeamUsageSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'team_id',
    'team_name',
    'display_name',
    'pinned_ledger_snapshot',
    'commercial_lines',
    'totals',
  ],
  properties: {
    team_id: { type: 'string', minLength: 1 },
    team_name: { type: 'string' },
    display_name: { type: 'string' },
    pinned_ledger_snapshot: portfolioSnapshotSchema('user'),
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
  title: 'UOA canonical customer billing statement',
  required: [...billingStatementV1JsonSchema.required],
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
    // Optional and absent from `required`: present only for an organisation
    // billing manager while the override is active. Everything else in the
    // document stays the requested team's own truthful statement.
    organisation_scope: organisationScopeSchema,
  },
} as const;
