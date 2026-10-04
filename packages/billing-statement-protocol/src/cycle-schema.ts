import {
  billingSubjectActionBodySchema,
  billingSubjectRequestJsonSchema,
  moneySchema,
  signedDecimalPattern,
  unsignedDecimalPattern,
} from './funding-schema-primitives.js';
import {
  BILLING_CYCLES_DOWNLOAD_PATH,
  BILLING_CYCLES_SCHEMA_PATH,
  BILLING_CYCLES_SCHEMA_VERSION,
} from './cycle-types.js';

const object = (required: string[], properties: Record<string, unknown>) => ({
  type: 'object', additionalProperties: false, required, properties,
});
const id = { type: 'string', minLength: 1, maxLength: 256 };
const month = { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' };
const datetime = { type: 'string', format: 'date-time' };
const nullableDatetime = { anyOf: [datetime, { type: 'null' }] };
const decimal = { type: 'string', pattern: unsignedDecimalPattern };
const nullableDecimal = { anyOf: [decimal, { type: 'null' }] };
const credits = { type: 'string', pattern: '^-?(0|[1-9][0-9]*)(\\.[0-9]{1,6})?$' };
const nullableCredits = { anyOf: [credits, { type: 'null' }] };
const nullableMoney = { anyOf: [moneySchema({ signed: true }), { type: 'null' }] };
const exactMoney = object(['amount', 'currency', 'display'], {
  amount: { type: 'string', pattern: signedDecimalPattern },
  currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  display: { type: 'string' },
});

const subject = billingSubjectRequestJsonSchema;
const scope = {
  ...object(['organisation_id', 'team_id', 'cycle_scope', 'payer_scope'], {
  organisation_id: id, team_id: { anyOf: [id, { type: 'null' }] },
  cycle_scope: { enum: ['team', 'organisation'] },
  payer_scope: { enum: ['team', 'organisation'] },
  }),
  allOf: [
    { if: { properties: { cycle_scope: { const: 'organisation' } } },
      then: { properties: { team_id: { type: 'null' },
        payer_scope: { const: 'organisation' } } } },
    { if: { properties: { cycle_scope: { const: 'team' } } },
      then: { properties: { team_id: id } } },
  ],
};
const period = object(['month', 'starts_at', 'ends_at'], {
  month, starts_at: datetime, ends_at: datetime,
});
const product = object(['id', 'identifier', 'name'], {
  id, identifier: id, name: { type: 'string' },
});
const totals = object(
  ['currency', 'subscription', 'usage_charge', 'tax', 'gross_total', 'credits_applied',
    'total_due', 'total_paid', 'outstanding'],
  {
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    subscription: moneySchema({ signed: true }),
    usage_charge: moneySchema({ signed: true }),
    tax: moneySchema({ signed: true }),
    gross_total: moneySchema({ signed: true }),
    credits_applied: moneySchema({ signed: true }),
    total_due: moneySchema({ signed: true }),
    total_paid: moneySchema({ signed: true }),
    outstanding: moneySchema({ signed: true }),
  },
);
const summaryProperties = {
  cycle_id: id,
  period,
  state: { enum: ['open_preview', 'pending_reconciliation', 'finalized', 'adjusted', 'voided'] },
  scope,
  product,
  totals: { type: 'array', items: totals },
  document_available: { type: 'boolean' },
};
const summaryRequired = Object.keys(summaryProperties);
const seatInterval = object(['starts_at', 'ends_at', 'quantity'], {
  starts_at: datetime, ends_at: datetime, quantity: decimal,
});
const subscriptionLine = object([
  'id', 'label', 'charge_basis', 'seat_policy', 'seat_timing', 'unit_price',
  'quantity', 'active_seat_seconds', 'month_seconds', 'intervals', 'customer_charge',
], {
  id, label: { type: 'string' }, charge_basis: { enum: ['flat', 'per_seat'] },
  seat_policy: { type: ['string', 'null'], enum: ['automatic', 'fixed', null] },
  seat_timing: { type: ['string', 'null'], enum: ['full_month', 'prorated', null] },
  unit_price: moneySchema({ signed: true }),
  quantity: nullableDecimal,
  active_seat_seconds: nullableDecimal,
  month_seconds: nullableDecimal,
  intervals: { type: 'array', items: seatInterval },
  customer_charge: moneySchema({ signed: true }),
});
const usageLine = { ...object([
  'id', 'label', 'usage_payment_mode', 'customer_charge', 'credits_consumed',
], {
  id, label: { type: 'string', minLength: 1 },
  usage_payment_mode: { enum: ['prepaid', 'pay_as_you_go'] },
  customer_charge: { anyOf: [exactMoney, { type: 'null' }] },
  credits_consumed: nullableCredits,
}), allOf: [{ if: { properties: { usage_payment_mode: { const: 'prepaid' } } },
  then: { properties: { customer_charge: { type: 'null' } } } }] };
const creditSummary = object([
  'consumed', 'opening_balance', 'closing_balance', 'status',
], {
  consumed: nullableCredits, opening_balance: nullableCredits, closing_balance: nullableCredits,
  status: { enum: ['confirmed', 'pending_reconciliation'] },
});
const downloadAction = object(['method', 'path', 'body'], {
  method: { const: 'POST' }, path: { const: BILLING_CYCLES_DOWNLOAD_PATH },
  body: billingSubjectActionBodySchema({ cycle_id: id, document_id: id },
    ['cycle_id', 'document_id']),
});
const document = object([
  'document_id', 'kind', 'format', 'state', 'number', 'issued_at',
  'customer_total', 'download_action',
], {
  document_id: id,
  kind: { enum: ['monthly_invoice', 'top_up_invoice', 'credit_note', 'usage_breakdown'] },
  format: { enum: ['pdf', 'csv'] },
  state: { enum: ['pending', 'available'] },
  number: { type: ['string', 'null'] },
  issued_at: nullableDatetime,
  customer_total: nullableMoney,
  download_action: { anyOf: [downloadAction, { type: 'null' }] },
});
const adjustment = object([
  'source_cycle_id', 'document_id', 'kind', 'customer_amount', 'reason',
], {
  source_cycle_id: id, document_id: id, kind: { enum: ['charge', 'credit'] },
  customer_amount: moneySchema({ signed: true }), reason: { type: 'string' },
});

export const billingCyclesListRequestV2JsonSchema = billingSubjectActionBodySchema({
  limit: { type: 'integer', minimum: 1, maximum: 24 },
  cursor: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2]):(preview|team|organisation)$' },
});
export const billingCycleDetailRequestV2JsonSchema = billingSubjectActionBodySchema(
  { cycle_id: id }, ['cycle_id'],
);
export const billingCycleDownloadRequestV2JsonSchema = billingSubjectActionBodySchema(
  { cycle_id: id, document_id: id }, ['cycle_id', 'document_id'],
);
export const billingCyclesListV2JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: '/schemas/billing-cycles-v2-list.json',
  ...object(['schema_version', 'generated_at', 'subject', 'cycles', 'next_cursor'], {
    schema_version: { const: BILLING_CYCLES_SCHEMA_VERSION },
    generated_at: datetime,
    subject,
    cycles: { type: 'array', items: object(summaryRequired, summaryProperties) },
    next_cursor: { anyOf: [
      { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2]):(preview|team|organisation)$' },
      { type: 'null' },
    ] },
  }),
};
export const billingCycleDetailV2JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: '/schemas/billing-cycles-v2-detail.json',
  ...object([
    ...summaryRequired, 'schema_version', 'subscription_lines', 'usage_lines',
    'credits', 'documents', 'adjustments',
  ], {
    ...summaryProperties,
    schema_version: { const: BILLING_CYCLES_SCHEMA_VERSION },
    subscription_lines: { type: 'array', items: subscriptionLine },
    usage_lines: { type: 'array', items: usageLine },
    credits: creditSummary,
    documents: { type: 'array', items: document },
    adjustments: { type: 'array', items: adjustment },
  }),
};
export const billingCyclesProtocolV2JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: BILLING_CYCLES_SCHEMA_PATH,
  title: 'UOA customer billing cycles protocol',
  type: 'object',
  additionalProperties: false,
  properties: {
    list_request: billingCyclesListRequestV2JsonSchema,
    list_response: billingCyclesListV2JsonSchema,
    detail_request: billingCycleDetailRequestV2JsonSchema,
    detail_response: billingCycleDetailV2JsonSchema,
    download_request: billingCycleDownloadRequestV2JsonSchema,
  },
};
