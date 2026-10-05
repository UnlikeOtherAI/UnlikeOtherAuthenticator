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
      { id: 'line-second', serviceIdentifier: 'nessie', serviceName: 'Nessie seats',
        amountMinor: 1000n, currency: 'USD', position: 2 },
    ],
    paymentEvents: [], manualCreditNotes: [],
  } as unknown as ManualInvoiceSource;
}

describe('customer manual invoice source projection', () => {
  it('shows actual product-bound legal charges and explicit gross/tax/credit arithmetic', () => {
    const invoice = source(BillingInvoiceStatus.ISSUED);
    const summary = projectManualCustomerInvoiceSummary(invoice);
    const detail = projectManualCustomerInvoiceDetail(invoice, subject);
    expect(summary.product_identifiers).toEqual(['nessie']);
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

  it('includes a later payment month without changing the original legal document', () => {
    const invoice = source(BillingInvoiceStatus.ISSUED);
    invoice.paymentEvents = [{ id: 'later-payment', kind: 'PAYMENT', amountMinor: 1000n,
      currency: 'USD', occurredAt: new Date('2026-12-05T12:00:00.000Z'),
    } as ManualInvoiceSource['paymentEvents'][number]];
    const detail = projectManualCustomerInvoiceDetail(invoice, subject, '2026-12');
    expect(detail).toMatchObject({ invoice_id: 'manual:invoice', charge_month: '2026-12',
      issued_at: '2026-11-01T00:00:00.000Z',
      payments_in_charge_month: { amount_minor: '1000' } });
    expect(detail.document.document_id).toBe('manual:invoice');
    expect(() => projectManualCustomerInvoiceDetail(invoice, subject, '2027-01')).toThrow();
  });

  it('rejects unsigned service disclosure and unproven invoice totals', () => {
    const invoice = source(BillingInvoiceStatus.ISSUED);
    expect(() => projectManualCustomerInvoiceDetail(invoice,
      { ...subject, product: 'other' })).toThrow();
    invoice.lines[1]!.serviceIdentifier = 'water';
    expect(() => projectManualCustomerInvoiceDetail(invoice, subject)).toThrow();
    invoice.lines[1]!.serviceIdentifier = 'nessie';
    invoice.totalMinor = 1n;
    expect(() => projectManualCustomerInvoiceSummary(invoice)).toThrow();
  });

  it('keeps accepted payment and original PDF frozen across full and partial refunds', () => {
    const invoice = source(BillingInvoiceStatus.ISSUED);
    const payment = { id: 'payment', kind: 'PAYMENT', amountMinor: 2800n,
      currency: 'USD', occurredAt: new Date('2026-11-05T12:00:00.000Z'),
    } as ManualInvoiceSource['paymentEvents'][number];
    const refund = { ...payment, id: 'refund', kind: 'REFUND', amountMinor: 800n };
    invoice.paymentEvents = [payment, refund];
    const partial = projectManualCustomerInvoiceSummary(invoice);
    expect(partial.status).toBe('partially_refunded');
    expect(partial.payments_in_charge_month.amount_minor).toBe('2800');
    expect(projectManualCustomerInvoiceDetail(invoice, subject).payments)
      .toMatchObject([{ payment_id: 'payment', amount: { amount_minor: '2800' } }]);
    expect(partial.totals).toMatchObject({ total_paid: { amount_minor: '2800' },
      refunded_amount: { amount_minor: '800' }, outstanding: { amount_minor: '0' } });
    invoice.paymentEvents = [payment, { ...refund, amountMinor: 2800n }];
    const full = projectManualCustomerInvoiceSummary(invoice);
    expect(full.status).toBe('refunded');
    expect(full.number).toBe(partial.number);
    expect(full.totals.outstanding.amount_minor).toBe('0');

    invoice.paymentEvents = [{ ...payment, amountMinor: 1000n },
      { ...refund, amountMinor: 400n }];
    const partlyPaid = projectManualCustomerInvoiceSummary(invoice);
    expect(partlyPaid.status).toBe('partially_refunded');
    expect(partlyPaid.totals.total_paid.amount_minor).toBe('1000');
    expect(partlyPaid.totals.outstanding.amount_minor).toBe('1800');
  });
});
