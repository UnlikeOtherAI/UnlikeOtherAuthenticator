import { readFile } from 'node:fs/promises';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  BILLING_CUSTOMER_INVOICES_PROTOCOL_VERSION,
  billingCustomerInvoiceDetailV1ConformanceFixture,
  billingCustomerInvoicePendingDetailV1ConformanceFixture,
  billingCustomerInvoiceDetailV1JsonSchema,
  billingCustomerInvoiceDownloadRequestV1ConformanceFixture,
  billingCustomerInvoiceDownloadRequestV1JsonSchema,
  billingCustomerInvoicesListV1ConformanceFixture,
  billingCustomerInvoicesListV1JsonSchema,
  billingCustomerInvoicesProtocolV1JsonSchema,
  billingCustomerInvoicesV1OpenApiDocument,
} from '../src/index.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

function assertPrivateFieldsAbsent(value: unknown): void {
  if (Array.isArray(value)) return value.forEach(assertPrivateFieldsAbsent);
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(key).not.toMatch(/token|raw_units|provider_cost|markup|margin|rate_bps/i);
    if (typeof child === 'string' && /label|display/.test(key)) {
      expect(child).not.toMatch(/provider cost|markup|margin|token/i);
    }
    assertPrivateFieldsAbsent(child);
  }
}

describe('actual customer charge invoice protocol', () => {
  it('accepts a paid prepaid-purchase invoice with exact credit quantity and PDF action', () => {
    for (const [schema, fixture] of [
      [billingCustomerInvoicesListV1JsonSchema, billingCustomerInvoicesListV1ConformanceFixture],
      [billingCustomerInvoiceDetailV1JsonSchema, billingCustomerInvoiceDetailV1ConformanceFixture],
      [billingCustomerInvoiceDetailV1JsonSchema,
        billingCustomerInvoicePendingDetailV1ConformanceFixture],
      [billingCustomerInvoiceDownloadRequestV1JsonSchema,
        billingCustomerInvoiceDownloadRequestV1ConformanceFixture],
    ] as const) {
      const validate = ajv.compile(schema);
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...fixture, provider_cost: '10' })).toBe(false);
      assertPrivateFieldsAbsent(fixture);
    }
    expect(billingCustomerInvoiceDetailV1ConformanceFixture.charges[0]?.credits_purchased)
      .toBe('50000');
    expect(billingCustomerInvoicesListV1ConformanceFixture.charge_month).toBe('2026-10');
    expect(billingCustomerInvoiceDetailV1ConformanceFixture.charged_at)
      .toBe('2026-10-03T23:59:59.000Z');
    expect(billingCustomerInvoicePendingDetailV1ConformanceFixture.document).toBeNull();
    expect(billingCustomerInvoicePendingDetailV1ConformanceFixture.totals.tax).toBeNull();
  });

  it('rejects invented usage evidence and cross-scope shape drift', () => {
    const validate = ajv.compile(billingCustomerInvoiceDetailV1JsonSchema);
    const detail = structuredClone(billingCustomerInvoiceDetailV1ConformanceFixture);
    (detail.charges[0] as unknown as Record<string, unknown>).usage_units = '100';
    expect(validate(detail)).toBe(false);
    delete (detail.charges[0] as unknown as Record<string, unknown>).usage_units;
    detail.scope.scope_type = 'organisation' as 'team';
    expect(validate(detail)).toBe(false);
  });

  it('shows only verified refundable cash on a cancellation note', () => {
    const validate = ajv.compile(billingCustomerInvoiceDetailV1JsonSchema);
    const note = structuredClone(billingCustomerInvoiceDetailV1ConformanceFixture);
    note.kind = 'credit_note';
    note.totals.customer_credit_due = { ...note.totals.total_paid,
      amount: '60', amount_minor: '6000' };
    expect(validate(note), JSON.stringify(validate.errors)).toBe(true);
    note.totals.customer_credit_due.amount_minor = '-6000';
    expect(validate(note)).toBe(false);
  });

  it('keeps one legal invoice while exposing only selected-month accepted cash', () => {
    const validate = ajv.compile(billingCustomerInvoiceDetailV1JsonSchema);
    const detail = structuredClone(billingCustomerInvoiceDetailV1ConformanceFixture);
    detail.charge_month = '2026-09';
    detail.payments_in_charge_month.amount_minor = '2000';
    detail.payments_in_charge_month.amount = '20';
    detail.payments = [
      { payment_id: 'uoa_payment_1', paid_at: '2026-09-30T23:59:59.000Z',
        amount: { ...detail.totals.total_paid, amount_minor: '2000', amount: '20' } },
      { payment_id: 'uoa_payment_2', paid_at: '2026-10-03T23:59:59.000Z',
        amount: { ...detail.totals.total_paid, amount_minor: '3000', amount: '30' } },
    ];
    expect(validate(detail), JSON.stringify(validate.errors)).toBe(true);
    expect(detail.totals.total_paid.amount_minor).toBe('5000');
    expect(detail.payments_in_charge_month.amount_minor).toBe('2000');
    const request = { ...billingCustomerInvoiceDownloadRequestV1ConformanceFixture,
      charge_month: '2026-09' };
    expect(ajv.compile(billingCustomerInvoiceDownloadRequestV1JsonSchema)(request)).toBe(false);
  });

  it('pins schema, examples and OpenAPI artifacts to the same draft contract', async () => {
    const root = new URL('../', import.meta.url);
    const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
    expect(await read('schema/billing-customer-invoices-v1.json'))
      .toEqual(billingCustomerInvoicesProtocolV1JsonSchema);
    expect(await read('fixtures/billing-customer-invoices-v1.example.json')).toEqual({
      list: billingCustomerInvoicesListV1ConformanceFixture,
      detail: billingCustomerInvoiceDetailV1ConformanceFixture,
      pending_detail: billingCustomerInvoicePendingDetailV1ConformanceFixture,
      download_request: billingCustomerInvoiceDownloadRequestV1ConformanceFixture,
    });
    expect(await read('openapi/billing-customer-invoices-v1.openapi.json'))
      .toEqual(billingCustomerInvoicesV1OpenApiDocument);
    expect(BILLING_CUSTOMER_INVOICES_PROTOCOL_VERSION).toBe('1.0.0');
  });
});
