import {
  billingCustomerInvoiceDetailV1ConformanceFixture,
  billingCustomerInvoicePendingDetailV1ConformanceFixture,
  billingCustomerInvoiceDownloadRequestV1ConformanceFixture,
  billingCustomerInvoicesListV1ConformanceFixture,
} from './invoice-fixture.js';
import {
  billingCustomerInvoiceDetailRequestV1JsonSchema,
  billingCustomerInvoiceDetailV1JsonSchema,
  billingCustomerInvoiceDownloadRequestV1JsonSchema,
  billingCustomerInvoicesListRequestV1JsonSchema,
  billingCustomerInvoicesListV1JsonSchema,
} from './invoice-schema.js';
import { BILLING_CUSTOMER_INVOICES_PROTOCOL_VERSION } from './invoice-types.js';

export const billingCustomerInvoicesV1OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'UOA actual customer charge invoices',
    version: BILLING_CUSTOMER_INVOICES_PROTOCOL_VERSION,
    description: 'One actual issued document per payment source; no usage breakdown on legal invoices.' },
  'x-uoa-presentation': { version: '1.5.0', locales: ['cs', 'en-US', 'en-GB', 'de', 'es', 'fr', 'it'],
    scope: 'Generated read labels and money displays only; immutable financial facts and documents unchanged.' },
  paths: {},
  components: {
    schemas: {
      BillingCustomerInvoicesListRequestV1: billingCustomerInvoicesListRequestV1JsonSchema,
      BillingCustomerInvoicesListV1: billingCustomerInvoicesListV1JsonSchema,
      BillingCustomerInvoiceDetailRequestV1: billingCustomerInvoiceDetailRequestV1JsonSchema,
      BillingCustomerInvoiceDetailV1: billingCustomerInvoiceDetailV1JsonSchema,
      BillingCustomerInvoiceDownloadRequestV1: billingCustomerInvoiceDownloadRequestV1JsonSchema,
    },
    examples: {
      BillingCustomerInvoicesListV1: { value: billingCustomerInvoicesListV1ConformanceFixture },
      BillingCustomerInvoiceDetailV1: { value: billingCustomerInvoiceDetailV1ConformanceFixture },
      BillingCustomerInvoicePendingDetailV1:
        { value: billingCustomerInvoicePendingDetailV1ConformanceFixture },
      BillingCustomerInvoiceDownloadRequestV1:
        { value: billingCustomerInvoiceDownloadRequestV1ConformanceFixture },
    },
  },
} as const;
