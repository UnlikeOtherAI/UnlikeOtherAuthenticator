import { billingStatementV2ConformanceFixture } from './v2-conformance-fixture.js';
import { billingStatementV2JsonSchema } from './v2-schema.js';
import { BILLING_STATEMENT_V2_PROTOCOL_VERSION, type BillingStatementV2 } from './v2-types.js';

export type BillingStatementV2OpenApiDocument = {
  openapi: '3.1.0';
  info: {
    title: string;
    version: typeof BILLING_STATEMENT_V2_PROTOCOL_VERSION;
    description: string;
  };
  paths: Record<string, never>;
  components: {
    schemas: {
      BillingStatementV2: typeof billingStatementV2JsonSchema;
    };
    examples: {
      BillingStatementV2Conformance: {
        summary: string;
        value: BillingStatementV2;
      };
    };
  };
};

export const billingStatementV2OpenApiDocument: BillingStatementV2OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'UOA BillingStatementV2 consumer contract',
    version: BILLING_STATEMENT_V2_PROTOCOL_VERSION,
    description:
      'OpenAPI 3.1 component and conformance fixture for the SSO-filled customer statement and team-wide connected-service usage portfolio.',
  },
  paths: {},
  components: {
    schemas: {
      BillingStatementV2: billingStatementV2JsonSchema,
    },
    examples: {
      BillingStatementV2Conformance: {
        summary:
          'Display-ready BillingStatementV2 example with team, origin-product, and user usage transparency',
        value: billingStatementV2ConformanceFixture,
      },
    },
  },
};
