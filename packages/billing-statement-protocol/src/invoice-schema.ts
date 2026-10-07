import {
  BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
  BILLING_CUSTOMER_INVOICES_SCHEMA_PATH,
} from './invoice-types.js';

const id = { type: 'string', minLength: 1, maxLength: 256 } as const;
const month = { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])$' } as const;
const datetime = { type: 'string', format: 'date-time' } as const;
const money = {
  type: 'object', additionalProperties: false,
  required: ['amount', 'amount_minor', 'currency', 'display'],
  properties: {
    amount: { type: 'string', pattern: '^-?[0-9]+(\\.[0-9]+)?$' },
    amount_minor: { type: 'string', pattern: '^-?[0-9]+$' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    display: { type: 'string' },
  },
} as const;
const nonnegativeMoney = {
  ...money, properties: { ...money.properties,
    amount: { type: 'string', pattern: '^[0-9]+(\\.[0-9]+)?$' },
    amount_minor: { type: 'string', pattern: '^[0-9]+$' },
  },
} as const;
const subject = {
  product: id, organisation_id: id, team_id: id, user_id: id,
} as const;
const scope = {
  type: 'object', additionalProperties: false,
  required: ['organisation_id', 'team_id', 'scope_type'],
  properties: {
    organisation_id: id, team_id: { anyOf: [id, { type: 'null' }] },
    scope_type: { enum: ['team', 'organisation'] },
  },
  allOf: [{ if: { properties: { scope_type: { const: 'organisation' } } },
    then: { properties: { team_id: { type: 'null' } } },
    else: { properties: { team_id: id } } }],
} as const;
const totals = {
  type: 'object', additionalProperties: false,
  required: ['currency', 'gross_total', 'tax', 'credits_applied', 'voided_amount',
    'total_due', 'total_paid', 'refunded_amount', 'disputed_amount',
    'write_off', 'outstanding'],
  properties: {
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    gross_total: nonnegativeMoney,
    tax: { anyOf: [nonnegativeMoney, { type: 'null' }] },
    credits_applied: nonnegativeMoney, voided_amount: nonnegativeMoney,
    total_due: nonnegativeMoney, total_paid: nonnegativeMoney,
    refunded_amount: nonnegativeMoney, disputed_amount: nonnegativeMoney,
    write_off: nonnegativeMoney, outstanding: nonnegativeMoney,
    customer_credit_due: nonnegativeMoney,
  },
} as const;
const summaryProperties = {
  invoice_id: id,
  kind: { enum: ['prepaid_purchase', 'monthly_service', 'adjustment', 'credit_note'] },
  status: { enum: ['pending_document', 'issued', 'paid', 'partially_paid',
    'voided', 'refunded', 'partially_refunded', 'disputed',
    'partially_disputed', 'written_off'] },
  number: { anyOf: [id, { type: 'null' }] }, charged_at: datetime,
  charge_month: month, payments_in_charge_month: nonnegativeMoney,
  issued_at: { anyOf: [datetime, { type: 'null' }] }, scope,
  product_identifiers: { type: 'array', minItems: 1, items: id, uniqueItems: true },
  totals, document_available: { type: 'boolean' },
} as const;
const summaryRequired = Object.keys(summaryProperties);
const summaryAvailability = {
  if: { properties: { status: { const: 'pending_document' } } },
  then: { properties: { number: { type: 'null' }, issued_at: { type: 'null' },
    document_available: { const: false } } },
  else: { properties: { number: id, issued_at: datetime,
    totals: { type: 'object', properties: { tax: nonnegativeMoney } },
    document_available: { const: true } } },
} as const;
const listRequest = {
  type: 'object', additionalProperties: false,
  required: [...Object.keys(subject), 'charge_month'],
  properties: { ...subject, charge_month: month,
    limit: { type: 'integer', minimum: 1, maximum: 50 }, cursor: id },
} as const;
const detailRequest = {
  type: 'object', additionalProperties: false,
  required: [...Object.keys(subject), 'invoice_id'],
  properties: { ...subject, invoice_id: id, charge_month: month },
} as const;
const downloadRequest = {
  type: 'object', additionalProperties: false,
  required: [...Object.keys(subject), 'invoice_id', 'document_id'],
  properties: { ...subject, invoice_id: id, document_id: id },
} as const;
const list = {
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'generated_at', 'subject',
    'charge_month', 'invoices', 'next_cursor'],
  properties: {
    schema_version: { const: 1 }, generated_at: datetime,
    subject: { type: 'object', additionalProperties: false,
      required: Object.keys(subject), properties: subject },
    charge_month: month,
    invoices: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: summaryRequired, properties: summaryProperties,
      allOf: [summaryAvailability] } },
    next_cursor: { anyOf: [id, { type: 'null' }] },
  },
} as const;
const detail = {
  type: 'object', additionalProperties: false,
  allOf: [summaryAvailability, {
    if: { properties: { status: { const: 'pending_document' } } },
    then: { properties: { document: { type: 'null' } } },
    else: { properties: { document: { type: 'object' } } },
  }],
  required: [...summaryRequired, 'schema_version', 'payments', 'charges', 'document'],
  properties: {
    ...summaryProperties, schema_version: { const: 1 },
    payments: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['payment_id', 'paid_at', 'amount'],
      properties: { payment_id: id, paid_at: datetime, amount: nonnegativeMoney },
    } },
    charges: { type: 'array', minItems: 1, items: {
      type: 'object', additionalProperties: false,
      required: ['line_id', 'kind', 'label', 'amount', 'credits_purchased'],
      properties: {
        line_id: id, kind: { enum: ['prepaid_credits', 'service_charge', 'adjustment'] },
        label: { type: 'string', minLength: 1 }, amount: money,
        credits_purchased: { anyOf: [
          { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]{1,6})?$' },
          { type: 'null' },
        ] },
      },
    } },
    document: { anyOf: [{ type: 'object', additionalProperties: false,
      required: ['document_id', 'format', 'number', 'issued_at', 'download_action'],
      properties: {
        document_id: id, format: { const: 'pdf' }, number: id, issued_at: datetime,
        download_action: { type: 'object', additionalProperties: false,
          required: ['method', 'path', 'body'],
          properties: { method: { const: 'POST' },
            path: { const: BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH },
            body: downloadRequest },
        },
      },
    }, { type: 'null' }] },
  },
} as const;

export const billingCustomerInvoicesListRequestV1JsonSchema = listRequest;
export const billingCustomerInvoiceDetailRequestV1JsonSchema = detailRequest;
export const billingCustomerInvoiceDownloadRequestV1JsonSchema = downloadRequest;
export const billingCustomerInvoicesListV1JsonSchema = list;
export const billingCustomerInvoiceDetailV1JsonSchema = detail;
export const billingCustomerInvoicesProtocolV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: BILLING_CUSTOMER_INVOICES_SCHEMA_PATH,
  title: 'UOA actual customer charge invoices',
  description: 'Actual issued payment documents only; usage evidence stays in separate breakdowns.',
  type: 'object', additionalProperties: false,
  properties: {
    list_request: listRequest, list_response: list,
    detail_request: detailRequest, detail_response: detail,
    download_request: downloadRequest,
  },
} as const;
