import { createHash } from 'node:crypto';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { invoiceResponseSchema } from '../../src/routes/internal/admin/billing-contract-invoice-response-schemas.js';
import { generateBillingInvoicePdf } from '../../src/services/billing-invoice-pdf.service.js';
import {
  serializeCustomerSafeInvoice,
  type CustomerSafeInvoice,
} from '../../src/services/billing-invoice-view.service.js';

const now = new Date('2026-07-01T00:00:00.000Z');

function invoice(): CustomerSafeInvoice {
  return {
    id: 'invoice_1',
    orgId: 'org_1',
    contractId: 'contract_1',
    contractVersionId: 'version_1',
    billingMonth: '2026-06',
    revision: 1,
    status: 'ISSUED',
    invoiceNumber: 'UOA-2026-000001',
    issueDate: now,
    dueDate: new Date('2026-07-31T00:00:00.000Z'),
    currency: 'USD',
    subtotalMinor: 6250n,
    taxAmountMinor: 0n,
    totalMinor: 6250n,
    creditsAppliedMinor: 250n,
    issuerSnapshot: {
      profile_id: 'issuer_1',
      legal_name: 'Unlike Other AI Ltd',
      trading_name: null,
      billing_email: 'billing@example.com',
      address: {
        line1: '1 Example Street',
        city: 'London',
        postal_code: 'N1 1AA',
        country: 'GB',
      },
      tax_identifier: null,
      company_registration_number: null,
      provider_cost: 'SECRET_PROVIDER_COST',
      ledger_snapshot_cursor: 'SECRET_CURSOR',
    },
    buyerSnapshot: {
      profile_id: 'buyer_1',
      legal_name: 'Customer Ltd',
      billing_email: 'ap@customer.example',
      billing_address: {
        line1: '2 Customer Road',
        city: 'Bristol',
        postal_code: 'BS1 1AA',
        country: 'GB',
      },
      tax_identifier: null,
      purchase_order_reference: null,
      usage_markup_bps: 4000,
      token_units: 'SECRET_TOKENS',
    },
    issuedAt: now,
    voidedAt: null,
    voidReason: null,
    createdAt: now,
    lines: [
      {
        id: 'line_1',
        serviceIdentifier: 'deepwater',
        serviceName: 'DeepWater',
        amountMinor: 6250n,
        currency: 'USD',
        position: 1,
      },
    ],
    addonLines: [
      {
        id: 'addon_line_1',
        serviceIdentifier: 'deepwater',
        serviceName: 'DeepWater',
        offerKey: 'privacy',
        offerName: 'DeepWater Privacy',
        monthlyAmountMinor: 5000n,
        currency: 'USD',
        scope: 'ORGANISATION',
        collection: 'STRIPE_SEPARATE',
        position: 1,
      },
    ],
    paymentEvents: [],
  };
}

describe('customer-safe contract invoice view', () => {
  it('contains final service prices only and strips private calculation evidence', () => {
    const value = serializeCustomerSafeInvoice(invoice());
    const serialized = JSON.stringify(value);

    expect(value.lines).toEqual([
      {
        id: 'line_1',
        service: { identifier: 'deepwater', name: 'DeepWater' },
        price: { amount_minor: '6250', amount: '62.5', currency: 'USD', display: '$62.5' },
      },
    ]);
    expect(value.totals.credits_applied).toEqual({
      amount_minor: '250',
      amount: '2.5',
      currency: 'USD',
      display: '$2.5',
    });
    expect(value.separately_billed_add_ons).toEqual([
      {
        id: 'addon_line_1',
        service: { identifier: 'deepwater', name: 'DeepWater' },
        offer: { key: 'privacy', name: 'DeepWater Privacy' },
        scope: 'organisation',
        collection: 'collected_separately',
        monthly_price: { amount_minor: '5000', amount: '50', currency: 'USD', display: '$50' },
        note: 'Collected separately; not included in this invoice total.',
      },
    ]);
    expect(value.totals.outstanding.amount_minor).toBe('6000');
    expect(value.payment_status).toBe('partially_paid');
    for (const forbidden of [
      'provider_cost',
      'SECRET_PROVIDER_COST',
      'ledger_snapshot',
      'SECRET_CURSOR',
      'usage_markup',
      'token_units',
      'SECRET_TOKENS',
      'calculation_digest',
      'addonSubscriptionId',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(invoiceResponseSchema);
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...value, calculation_digest: 'private' })).toBe(false);
    expect(validate({ ...value, issuer: { ...value.issuer, provider_cost: 'private' } })).toBe(
      false,
    );
  });

  it('renders deterministic immutable bytes without private snapshot fields', async () => {
    const bytes = await generateBillingInvoicePdf(invoice());
    const retriedBytes = await generateBillingInvoicePdf(invoice());
    const raw = Buffer.from(bytes).toString('latin1');
    const document = await PDFDocument.load(bytes);

    expect(Buffer.from(retriedBytes)).toEqual(Buffer.from(bytes));
    expect(createHash('sha256').update(retriedBytes).digest('hex')).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    expect(document.getAuthor()).toBe('Unlike Other AI Ltd');
    expect(document.getSubject()).toBe('Customer service invoice');
    expect(raw).not.toContain('SECRET_PROVIDER_COST');
    expect(raw).not.toContain('SECRET_CURSOR');
    expect(raw).not.toContain('SECRET_TOKENS');
  });

  it('preserves Unicode metadata and wraps long invoice content across pages', async () => {
    const unicodeName = 'Zażółć Gęślą Jaźń — Καλημέρα — Пример';
    const longInvoice = invoice();
    longInvoice.issuerSnapshot = {
      ...(longInvoice.issuerSnapshot as Record<string, unknown>),
      legal_name: unicodeName,
      address: {
        line1: `Długa ulica ${'bardzo '.repeat(45)}`,
        city: 'Łódź',
        postal_code: '90-001',
        country: 'PL',
      },
    };
    longInvoice.lines = Array.from({ length: 70 }, (_, index) => ({
      id: `line_${index}`,
      serviceIdentifier: `service-${index}`,
      serviceName: `Usługa badawcza ${index} ${'z długim opisem '.repeat(8)}`,
      amountMinor: 100n,
      currency: 'USD',
      position: index + 1,
    }));
    longInvoice.subtotalMinor = 7000n;
    longInvoice.totalMinor = 7000n;

    const first = await generateBillingInvoicePdf(longInvoice);
    const second = await generateBillingInvoicePdf(longInvoice);
    const document = await PDFDocument.load(first);

    expect(document.getAuthor()).toBe(unicodeName);
    expect(document.getPageCount()).toBeGreaterThan(1);
    expect(Buffer.from(second)).toEqual(Buffer.from(first));
  });
});
