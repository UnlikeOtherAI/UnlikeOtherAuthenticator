import { billingConsumerActionV1ConformanceFixtures } from './action-conformance-fixtures.js';
import {
  billingCancellationConfirmationV1JsonSchema,
  billingCancellationConfirmRequestJsonSchema,
  billingCancellationPreviewV1JsonSchema,
  billingCancellationSelectionJsonSchema,
  billingErrorEnvelopeJsonSchema,
  billingHostedRedirectResponseJsonSchema,
} from './action-schema.js';
import { BILLING_STATEMENT_PROTOCOL_VERSION } from './types.js';

export const billingConsumerActionV1OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'UOA billing consumer action protocol v1',
    version: BILLING_STATEMENT_PROTOCOL_VERSION,
    description:
      'OpenAPI 3.1 components and synthetic fixtures for product-hosted redirects and UOA cancellation.',
  },
  paths: {},
  components: {
    schemas: {
      BillingCancellationSelection: billingCancellationSelectionJsonSchema,
      BillingHostedRedirectResponse: billingHostedRedirectResponseJsonSchema,
      BillingCancellationPreviewV1: billingCancellationPreviewV1JsonSchema,
      BillingCancellationConfirmRequest: billingCancellationConfirmRequestJsonSchema,
      BillingCancellationConfirmationV1: billingCancellationConfirmationV1JsonSchema,
      BillingErrorEnvelope: billingErrorEnvelopeJsonSchema,
    },
    examples: {
      BillingHostedRedirectResponseConformance: {
        summary: 'Synthetic normalized hosted billing redirect',
        value: billingConsumerActionV1ConformanceFixtures.hosted_redirect_response,
      },
      BillingCancellationPreviewV1Conformance: {
        summary: 'Synthetic cancellation preview with a related direct service',
        value: billingConsumerActionV1ConformanceFixtures.cancellation_preview,
      },
      BillingCancellationConfirmRequestConformance: {
        summary: 'Synthetic cancellation confirmation request',
        value: billingConsumerActionV1ConformanceFixtures.cancellation_confirm_request,
      },
      BillingCancellationConfirmationV1Conformance: {
        summary: 'Synthetic confirmed period-end cancellation',
        value: billingConsumerActionV1ConformanceFixtures.cancellation_confirmation,
      },
      BillingErrorEnvelopeConformance: {
        summary: 'Synthetic product-facing billing error',
        value: billingConsumerActionV1ConformanceFixtures.error,
      },
    },
  },
} as const;

export type BillingConsumerActionV1OpenApiDocument =
  typeof billingConsumerActionV1OpenApiDocument;
