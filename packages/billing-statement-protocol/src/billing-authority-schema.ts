import { creditAmountSchema, billingSubjectRequestJsonSchema } from './funding-schema-primitives.js';
import { billingOrganisationRequestV1JsonSchema, billingOrganisationScopeV1JsonSchema }
  from './organisation-overview-schema.js';
import { BILLING_AUTHORITY_SCHEMA_PATH, BILLING_TEAM_OVERVIEW_PATH } from './billing-authority-types.js';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
});
const id = { type: 'string', minLength: 1, maxLength: 256 };
const text = { type: 'string', minLength: 1 };
const datetime = { type: 'string', format: 'date-time' };
const month = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' };
const mode = { enum: ['live', 'sandbox'] };
const sourceRef = { type: 'string', pattern: '^tbs_[a-f0-9]{64}$' };
export const billingTeamReadScopeV1JsonSchema = object({ kind: { const: 'team' },
  product: id, organisation_id: id, team_id: id });
export const billingTeamOverviewRequestV1JsonSchema = object({
  ...billingSubjectRequestJsonSchema.properties, billing_month: month,
}, [...billingSubjectRequestJsonSchema.required]);
const common = { schema_version: { const: 2 }, generated_at: datetime,
  subject: billingOrganisationRequestV1JsonSchema };
export const billingCapabilitiesV2JsonSchema = { oneOf: [
  object({ ...common, access: { const: 'organisation_manager' },
    financial_scope: billingOrganisationScopeV1JsonSchema }),
  object({ ...common, subject: billingSubjectRequestJsonSchema, access: { const: 'team_reader' },
    team_scope: billingTeamReadScopeV1JsonSchema,
    overview_request: object({ method: { const: 'POST' }, path: { const: BILLING_TEAM_OVERVIEW_PATH },
      body: billingTeamOverviewRequestV1JsonSchema }) }),
  object({ ...common, access: { const: 'none' } }),
] };
const section = (data: unknown) => ({ oneOf: [
  object({ state: { const: 'confirmed' }, message: text, data }),
  object({ state: { enum: ['pending_reconciliation', 'unavailable'] }, message: text, code: text }),
] });
const recordedUsage = object({ as_of: datetime, sources: { type: 'array', maxItems: 100,
  items: object({ source_ref: sourceRef, mode, label: text,
    recorded_usage: creditAmountSchema(), waived_usage: creditAmountSchema() }) } });
const retainedCredits = object({ as_of: datetime, records: { type: 'array', maxItems: 100,
  items: object({ record_id: id, source_ref: sourceRef, mode, label: text,
    recorded_balance: creditAmountSchema({ signed: true }), recorded_at: datetime }) } });
export const billingTeamOverviewV1JsonSchema = object({ schema_version: { const: 1 },
  generated_at: datetime, subject: billingSubjectRequestJsonSchema,
  team_scope: billingTeamReadScopeV1JsonSchema, title: text, description: text,
  team: object({ id, name: text }), product: object({ id, identifier: id, name: text }),
  period: object({ month, starts_at: datetime, ends_at: datetime }),
  sections: object({ activity: section(object({ as_of: datetime,
    recorded_calls: object({ quantity: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
      display: text, label: text }) })),
  recorded_credit_usage: section(recordedUsage), retained_credits: section(retainedCredits) }),
});
export const billingAuthorityV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: BILLING_AUTHORITY_SCHEMA_PATH,
  $defs: { capabilities: billingCapabilitiesV2JsonSchema,
    team_overview_request: billingTeamOverviewRequestV1JsonSchema, team_overview: billingTeamOverviewV1JsonSchema },
  oneOf: [{ $ref: '#/$defs/capabilities' }, { $ref: '#/$defs/team_overview' }],
};
