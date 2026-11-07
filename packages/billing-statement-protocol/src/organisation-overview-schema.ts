import { billingCreditsV1JsonSchema } from './credits-schema.js';
import { billingCycleDetailV2JsonSchema } from './cycle-schema.js';
import { billingSubjectRequestJsonSchema, creditAmountSchema, moneySchema } from './funding-schema-primitives.js';
import { billingStatementV1JsonSchema } from './schema.js';
import { BILLING_ORGANISATION_SCHEMA_PATH } from './organisation-overview-types.js';
import { organisationFinancialSubjectSchema } from './organisation-financial-subject-schema.js';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
});
const id = { type: 'string', minLength: 1, maxLength: 256 };
const text = { type: 'string', minLength: 1 };
const datetime = { type: 'string', format: 'date-time' };
const month = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' };
const subject = organisationFinancialSubjectSchema(billingSubjectRequestJsonSchema);
export const billingOrganisationRequestV1JsonSchema = subject;
export const billingOrganisationOverviewRequestV1JsonSchema = object({ ...subject.properties,
  billing_month: month }, [...subject.required]);
export const billingOrganisationScopeV1JsonSchema = object({ kind: { const: 'organisation' },
  organisation_id: id, mode: { enum: ['live', 'sandbox'] }, revision: { type: 'integer', minimum: 0 }, epoch: datetime });

const section = (data: unknown) => ({ oneOf: [
  object({ state: { const: 'confirmed' }, message: text, data }),
  object({ state: { enum: ['pending_reconciliation', 'unavailable'] }, message: text, code: text }),
] });
const common = { schema_version: { const: 1 }, generated_at: datetime, subject };
export const billingOrganisationCapabilitiesV1JsonSchema = { oneOf: [
  object({ ...common, capabilities: object({ can_view_billing: { const: false }, can_manage_billing: { const: false } }) }),
  object({ ...common, capabilities: object({ can_view_billing: { const: true }, can_manage_billing: { const: true } }),
    financial_scope: billingOrganisationScopeV1JsonSchema }),
] };
const credits = billingCreditsV1JsonSchema.properties;
const statement = billingStatementV1JsonSchema.properties;
const pick = (properties: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map(key => [key, properties[key]]));
export const billingOrganisationCreditBalanceV1JsonSchema = object({ credit_account_id: id,
  confirmed_balance: creditAmountSchema({ signed: true }), reserved_credits: creditAmountSchema(),
  spendable_balance: creditAmountSchema({ signed: true }), as_of: datetime,
  billing_status: object({ settlement_state: { enum: ['current', 'pending_reconciliation'] }, message: text }),
  region_rate: credits.region_rate }, ['credit_account_id', 'confirmed_balance', 'reserved_credits',
  'spendable_balance', 'as_of', 'billing_status']);
export const billingOrganisationFundingV1JsonSchema = organisationFinancialSubjectSchema(object({
  ...pick(credits, ['capabilities', 'conversion', 'collection', 'region_rate']),
  funding_policy: { allOf: [credits.funding_policy, { type: 'object' }] },
  automatic_top_up: { allOf: [credits.automatic_top_up, { type: 'object',
    properties: { state: { type: 'string' }, options: { type: 'array' } }, required: ['state', 'options'] }] },
}, ['capabilities', 'conversion', 'collection', 'funding_policy', 'automatic_top_up']));
export const billingOrganisationSubscriptionV1JsonSchema = organisationFinancialSubjectSchema(object(pick(statement,
  ['plan', 'collection', 'subscription', 'capabilities', 'actions'])));
export const billingOrganisationAccruedBillV1JsonSchema = object({ as_of: datetime,
  period: billingCycleDetailV2JsonSchema.properties.period,
  totals: billingCycleDetailV2JsonSchema.properties.totals,
  lines: { type: 'array', items: object({ id, product: { anyOf: [id, { type: 'null' }] }, label: text,
    kind: { enum: ['subscription', 'usage', 'add_on', 'adjustment', 'tax', 'prepaid_credit'] },
    amount: moneySchema({ signed: true }) }) },
});
const request = (path: string, body: unknown) => object({ method: { const: 'POST' }, path: { const: path }, body });
const historySubject=object({...subject.properties,financial_scope:{const:'organisation'},billing_mode:{enum:['live','sandbox']}},
  [...subject.required,'financial_scope']);
const historyRequests={
  cycles_request: request('/billing/v1/cycles/list', historySubject),
  invoices_request: request('/billing/v1/invoices/list', object({ ...historySubject.properties, charge_month: month },
    [...historySubject.required,'charge_month'])),
};
export const billingOrganisationHistoryV1JsonSchema = object({
  ...historyRequests,captured_sources:{type:'array',maxItems:2,items:object({mode:{enum:['live','sandbox']},...historyRequests})},
},['cycles_request','invoices_request']);
export const billingOrganisationOverviewV1JsonSchema = object({ ...common,
  financial_scope: billingOrganisationScopeV1JsonSchema,
  sections: object({ accrued_bill: section(billingOrganisationAccruedBillV1JsonSchema),
    credits: section(billingOrganisationCreditBalanceV1JsonSchema), funding: section(billingOrganisationFundingV1JsonSchema),
    subscription: section(billingOrganisationSubscriptionV1JsonSchema), history: section(billingOrganisationHistoryV1JsonSchema) }),
});
export const billingOrganisationProtocolV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', $id: BILLING_ORGANISATION_SCHEMA_PATH,
  $defs: { request: billingOrganisationRequestV1JsonSchema, overview_request: billingOrganisationOverviewRequestV1JsonSchema,
    capabilities: billingOrganisationCapabilitiesV1JsonSchema, overview: billingOrganisationOverviewV1JsonSchema },
  oneOf: [{ $ref: '#/$defs/capabilities' }, { $ref: '#/$defs/overview' }],
};
