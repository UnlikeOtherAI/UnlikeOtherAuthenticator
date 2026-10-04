import type {
  BillingCustomerInvoiceDetailV1,
  BillingCustomerInvoiceDownloadRequestV1,
  BillingCustomerInvoicesListV1,
} from './invoice-types.js';
import { BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH } from './invoice-types.js';

const subject = {
  product: 'nessie', organisation_id: 'org_example',
  team_id: 'team_example', user_id: 'user_example',
};
const money = (amount: string, amountMinor: string) => ({
  amount, amount_minor: amountMinor, currency: 'USD', display: `US$${amount}`,
});
const summary = {
  invoice_id: 'invoice_topup_1', kind: 'prepaid_purchase' as const,
  status: 'paid' as const, number: 'UOA-2026-000001',
  charged_at: '2026-10-03T23:59:59.000Z',
  issued_at: '2026-10-04T10:00:00.000Z',
  scope: { organisation_id: subject.organisation_id,
    team_id: subject.team_id, scope_type: 'team' as const },
  product_identifiers: ['nessie'],
  totals: { currency: 'USD', gross_total: money('50', '5000'),
    tax: money('0', '0'), credits_applied: money('0', '0'),
    voided_amount: money('0', '0'),
    total_due: money('50', '5000'), total_paid: money('50', '5000'),
    write_off: money('0', '0'),
    outstanding: money('0', '0') },
  document_available: true,
};
const pending = {
  ...summary, invoice_id: 'payment_auto_2', status: 'pending_document' as const,
  charged_at: '2026-10-31T23:59:59.000Z',
  number: null, issued_at: null,
  totals: { ...summary.totals, tax: null }, document_available: false,
};
export const billingCustomerInvoicesListV1ConformanceFixture: BillingCustomerInvoicesListV1 = {
  schema_version: 1, generated_at: '2026-11-01T12:00:00.000Z', subject,
  charge_month: '2026-10', invoices: [summary, pending], next_cursor: null,
};
export const billingCustomerInvoiceDetailV1ConformanceFixture: BillingCustomerInvoiceDetailV1 = {
  ...summary, schema_version: 1,
  charges: [{ line_id: 'line_topup_1', kind: 'prepaid_credits',
    label: 'Prepaid credits purchase', amount: money('50', '5000'),
    credits_purchased: '50000' }],
  document: { document_id: 'document_topup_1', format: 'pdf',
    number: summary.number, issued_at: summary.issued_at,
    download_action: { method: 'POST', path: BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH,
      body: { ...subject, invoice_id: summary.invoice_id,
        document_id: 'document_topup_1' } } },
};
export const billingCustomerInvoiceDownloadRequestV1ConformanceFixture:
BillingCustomerInvoiceDownloadRequestV1 = {
  ...subject, invoice_id: summary.invoice_id, document_id: 'document_topup_1',
};
export const billingCustomerInvoicePendingDetailV1ConformanceFixture:
BillingCustomerInvoiceDetailV1 = {
  ...pending, schema_version: 1,
  charges: [{ line_id: 'line_auto_2', kind: 'prepaid_credits',
    label: 'Automatic prepaid credits purchase', amount: money('50', '5000'),
    credits_purchased: '50000' }],
  document: null,
};
