import {
  billingCycleDetailV1ConformanceFixture,
  billingCycleDownloadRequestV1ConformanceFixture,
  billingCyclesListV1ConformanceFixture,
} from './cycle-conformance-fixture.js';
import {
  billingCycleDetailRequestV1JsonSchema,
  billingCycleDetailV1JsonSchema,
  billingCycleDownloadRequestV1JsonSchema,
  billingCyclesListRequestV1JsonSchema,
  billingCyclesListV1JsonSchema,
} from './cycle-schema.js';
import { BILLING_CYCLES_PROTOCOL_VERSION } from './cycle-types.js';

export const billingCyclesV1OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'UOA customer billing cycles protocol',
    version: BILLING_CYCLES_PROTOCOL_VERSION,
    description: 'Exact product-scoped monthly history, documents, and download actions.',
  },
  paths: {},
  components: {
    schemas: {
      BillingCyclesListRequestV1: billingCyclesListRequestV1JsonSchema,
      BillingCyclesListV1: billingCyclesListV1JsonSchema,
      BillingCycleDetailRequestV1: billingCycleDetailRequestV1JsonSchema,
      BillingCycleDetailV1: billingCycleDetailV1JsonSchema,
      BillingCycleDownloadRequestV1: billingCycleDownloadRequestV1JsonSchema,
    },
    examples: {
      BillingCyclesListV1Conformance: {
        summary: 'Synthetic paid subscription with prepaid usage',
        value: billingCyclesListV1ConformanceFixture,
      },
      BillingCycleDetailV1Conformance: {
        summary: 'Synthetic finalized cycle with invoice and measured-usage breakdown',
        value: billingCycleDetailV1ConformanceFixture,
      },
      BillingCycleDownloadRequestV1Conformance: {
        summary: 'Exact document download action body',
        value: billingCycleDownloadRequestV1ConformanceFixture,
      },
    },
  },
} as const;
