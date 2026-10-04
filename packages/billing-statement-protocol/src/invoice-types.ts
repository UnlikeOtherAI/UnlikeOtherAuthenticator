import type { ExactMoney } from './types.js';
import type { BillingSubjectRequest } from './funding-schema-primitives.js';

export const BILLING_CUSTOMER_INVOICES_PROTOCOL_VERSION = '1.0.0' as const;
export const BILLING_CUSTOMER_INVOICES_SCHEMA_VERSION = 1 as const;
export const BILLING_CUSTOMER_INVOICES_SCHEMA_PATH =
  '/schemas/billing-customer-invoices-v1.json' as const;
export const BILLING_CUSTOMER_INVOICES_EXAMPLE_PATH =
  '/schemas/billing-customer-invoices-v1.example.json' as const;
export const BILLING_CUSTOMER_INVOICES_OPENAPI_PATH =
  '/schemas/billing-customer-invoices-v1.openapi.json' as const;
export const BILLING_CUSTOMER_INVOICES_LIST_PATH = '/billing/v1/invoices/list' as const;
export const BILLING_CUSTOMER_INVOICES_DETAIL_PATH = '/billing/v1/invoices/detail' as const;
export const BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH = '/billing/v1/invoices/download' as const;

export type BillingCustomerInvoiceMoney = ExactMoney & { amount_minor: string };
export type BillingCustomerInvoiceScope = {
  organisation_id: string;
  team_id: string | null;
  scope_type: 'team' | 'organisation';
};
export type BillingCustomerInvoiceTotals = {
  currency: string;
  gross_total: BillingCustomerInvoiceMoney;
  tax: BillingCustomerInvoiceMoney | null;
  credits_applied: BillingCustomerInvoiceMoney;
  voided_amount: BillingCustomerInvoiceMoney;
  total_due: BillingCustomerInvoiceMoney;
  total_paid: BillingCustomerInvoiceMoney;
  refunded_amount: BillingCustomerInvoiceMoney;
  disputed_amount: BillingCustomerInvoiceMoney;
  write_off: BillingCustomerInvoiceMoney;
  outstanding: BillingCustomerInvoiceMoney;
};
export type BillingCustomerInvoiceSummaryV1 = {
  invoice_id: string;
  kind: 'prepaid_purchase' | 'monthly_service' | 'adjustment' | 'credit_note';
  status: 'pending_document' | 'issued' | 'paid' | 'partially_paid' |
    'voided' | 'refunded' | 'partially_refunded' | 'disputed' |
    'partially_disputed' | 'written_off';
  number: string | null;
  charged_at: string;
  issued_at: string | null;
  scope: BillingCustomerInvoiceScope;
  product_identifiers: string[];
  totals: BillingCustomerInvoiceTotals;
  document_available: boolean;
};
export type BillingCustomerInvoicesListRequestV1 = BillingSubjectRequest & {
  charge_month: string;
  limit?: number;
  cursor?: string;
};
export type BillingCustomerInvoicesListV1 = {
  schema_version: typeof BILLING_CUSTOMER_INVOICES_SCHEMA_VERSION;
  generated_at: string;
  subject: BillingSubjectRequest;
  charge_month: string;
  invoices: BillingCustomerInvoiceSummaryV1[];
  next_cursor: string | null;
};
export type BillingCustomerInvoiceDetailRequestV1 = BillingSubjectRequest & {
  invoice_id: string;
};
export type BillingCustomerInvoiceChargeV1 = {
  line_id: string;
  kind: 'prepaid_credits' | 'service_charge' | 'adjustment';
  label: string;
  amount: BillingCustomerInvoiceMoney;
  credits_purchased: string | null;
};
export type BillingCustomerInvoiceDownloadActionV1 = {
  method: 'POST';
  path: typeof BILLING_CUSTOMER_INVOICES_DOWNLOAD_PATH;
  body: BillingSubjectRequest & { invoice_id: string; document_id: string };
};
export type BillingCustomerInvoiceDocumentV1 = {
  document_id: string;
  format: 'pdf';
  number: string;
  issued_at: string;
  download_action: BillingCustomerInvoiceDownloadActionV1;
};
export type BillingCustomerInvoiceDetailV1 = BillingCustomerInvoiceSummaryV1 & {
  schema_version: typeof BILLING_CUSTOMER_INVOICES_SCHEMA_VERSION;
  charges: BillingCustomerInvoiceChargeV1[];
  document: BillingCustomerInvoiceDocumentV1 | null;
};
export type BillingCustomerInvoiceDownloadRequestV1 =
  BillingCustomerInvoiceDetailRequestV1 & { document_id: string };
