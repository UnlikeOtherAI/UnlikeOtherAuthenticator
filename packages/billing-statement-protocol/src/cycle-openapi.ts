import {
  billingCycleDetailV2ConformanceFixture,
  billingCycleDownloadRequestV2ConformanceFixture,
  billingCyclesListV2ConformanceFixture,
} from './cycle-conformance-fixture.js';
import {
  billingCycleDetailRequestV2JsonSchema,
  billingCycleDetailV2JsonSchema,
  billingCycleDownloadRequestV2JsonSchema,
  billingCyclesListRequestV2JsonSchema,
  billingCyclesListV2JsonSchema,
} from './cycle-schema.js';
import { BILLING_CYCLES_PROTOCOL_VERSION } from './cycle-types.js';

export const billingCyclesV2OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'UOA customer billing cycles protocol',
    version: BILLING_CYCLES_PROTOCOL_VERSION,
    description: 'Exact product-scoped monthly history, documents, and download actions.',
  },
  paths: {},
  components: {
    schemas: {
      BillingCyclesListRequestV2: billingCyclesListRequestV2JsonSchema,
      BillingCyclesListV2: billingCyclesListV2JsonSchema,
      BillingCycleDetailRequestV2: billingCycleDetailRequestV2JsonSchema,
      BillingCycleDetailV2: billingCycleDetailV2JsonSchema,
      BillingCycleDownloadRequestV2: billingCycleDownloadRequestV2JsonSchema,
    },
    examples: {
      BillingCyclesListV2Conformance: {
        summary: 'Synthetic paid subscription with prepaid usage',
        value: billingCyclesListV2ConformanceFixture,
      },
      BillingCycleDetailV2Conformance: {
        summary: 'Synthetic finalized cycle with invoice and measured-usage breakdown',
        value: billingCycleDetailV2ConformanceFixture,
      },
      BillingCycleDownloadRequestV2Conformance: {
        summary: 'Exact document download action body',
        value: billingCycleDownloadRequestV2ConformanceFixture,
      },
    },
  },
} as const;
