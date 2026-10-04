import { BillingInvoiceStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  projectManualCustomerInvoiceDetail,
  projectManualCustomerInvoiceSummary,
  type ManualInvoiceSource,
} from '../../src/services/billing-customer-invoice-manual.service.js';

const subject = { product: 'nessie', organisation_id: 'org',
  team_id: 'selected-team', user_id: 'viewer' };

function source(status: BillingInvoiceStatus): ManualInvoiceSource {
  return {
    id: 'invoice', orgId: 'org', status,
    invoiceNumber: 'UOA-2026-00001',
    issuedAt: new Date('2026-11-01T00:00:00.000Z'),
    issueDate: new Date('2026-11-01T00:00:00.000Z'),
    pdfObjectKey: 'issuer/invoice.pdf', pdfSha256: 'a'.repeat(64),
    issuerSnapshot: { legal_name: 'UOA Ltd' },
    buyerSnapshot: { legal_name: 'Buyer Ltd' },
    currency: 'USD', subtotalMinor: 3000n, taxAmountMinor: 300n,
    creditsAppliedMinor: 500n, totalMinor: 3300n,
    lines: [
      { id: 'line-nessie', serviceIdentifier: 'nessie', serviceName: 'Nessie',
        amountMinor: 2000n, currency: 'USD', position: 1 },
      { id: 'line-water', serviceIdentifier: 'water', serviceName: 'Water',
        amountMinor: 1000n, currency: 'USD', position: 2 },
    ],
    paymentEvents: [],
  } as unknown as ManualInvoiceSource;
}

describe('customer manual invoice source projection', () => {
  it('shows actual multi-product legal charges and explicit gross/tax/credit arithmetic', () => {
    const invoice = source(BillingInvoiceStatus.ISSUED);
    const summary = projectManualCustomerInvoiceSummary(invoice);
    const detail = projectManualCustomerInvoiceDetail(invoice, subject);
    expect(summary.product_identifiers).toEqual(['nessie', 'water']);
    expect(summary.totals).toMatchObject({
      gross_total: { amount_minor: '3300' }, tax: { amount_minor: '300' },
      credits_applied: { amount_minor: '500' }, voided_amount: { amount_minor: '0' },
      total_due: { amount_minor: '2800' }, outstanding: { amount_minor: '2800' },
    });
    expect(detail.charges.map((line) => line.amount.amount_minor)).toEqual(['2000', '1000']);
    expect(detail.document.download_action.body).toEqual({ ...subject,
      invoice_id: 'manual:invoice', document_id: 'manual:invoice' });
    expect(JSON.stringify(detail)).not.toMatch(/provider_cost|markup|raw_units|token_count/i);
  });

  it('keeps original legal charges and zeroes current due only from persisted void', () => {
    const invoice = source(BillingInvoiceStatus.VOID);
    const detail = projectManualCustomerInvoiceDetail(invoice, subject);
    expect(detail.status).toBe('voided');
    expect(detail.charges[0]?.amount.amount_minor).toBe('2000');
    expect(detail.totals).toMatchObject({ voided_amount: { amount_minor: '2800' },
      total_due: { amount_minor: '0' }, outstanding: { amount_minor: '0' } });
  });

  it('rejects unsigned service disclosure and unproven invoice totals', () => {
    const invoice = source(BillingInvoiceStatus.ISSUED);
    expect(() => projectManualCustomerInvoiceDetail(invoice,
      { ...subject, product: 'other' })).toThrow();
    invoice.totalMinor = 1n;
    expect(() => projectManualCustomerInvoiceSummary(invoice)).toThrow();
  });
});
