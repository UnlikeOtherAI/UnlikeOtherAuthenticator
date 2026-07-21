import {
  billingErrorEnvelopeJsonSchema,
  billingHostedRedirectResponseJsonSchema,
} from './action-schema.js';
import { billingRecurringAddonV1ConformanceFixtures } from './recurring-addon-conformance-fixtures.js';
import {
  billingSubjectActionBodySchema,
  billingSubjectRequestJsonSchema,
} from './funding-schema-primitives.js';
import {
  billingRecurringAddonCancellationConfirmationV1JsonSchema,
  billingRecurringAddonCancellationConfirmRequestV1JsonSchema,
  billingRecurringAddonCancellationPreviewV1JsonSchema,
  billingRecurringAddonProtocolV1JsonSchema,
  billingRecurringAddonsV1JsonSchema,
} from './recurring-addon-schema.js';
import {
  BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH,
  BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH,
  BILLING_RECURRING_ADDONS_CHECKOUT_PATH,
  BILLING_RECURRING_ADDONS_PROTOCOL_VERSION,
  BILLING_RECURRING_ADDONS_READ_PATH,
} from './recurring-addon-types.js';

const authenticatedOperation = {
  security: [
    { UoaAppKey: [], UoaActor: [] },
    { UoaBearerAppKey: [], UoaActor: [] },
  ],
} as const;

const noStoreHeader = {
  description: 'Customer billing responses are never cacheable.',
  schema: { const: 'no-store' },
} as const;

const errorResponse = {
  description: 'UOA billing error envelope.',
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/BillingErrorEnvelope' } },
  },
} as const;

function selectorBody(selector: 'offer_id' | 'subscription_id') {
  return {
    required: true,
    content: {
      'application/json': {
        schema: billingSubjectActionBodySchema(
          { [selector]: { type: 'string', minLength: 1, maxLength: 256 } },
          [selector],
        ),
      },
    },
  } as const;
}

const commonErrors = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  409: errorResponse,
  503: errorResponse,
} as const;

export const billingRecurringAddonV1OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'UOA recurring add-on consumer API',
    version: BILLING_RECURRING_ADDONS_PROTOCOL_VERSION,
    description:
      'Exact display-ready recurring add-on API. UOA resolves visibility, manager capabilities, paid entitlement, and cancellation; products only render and relay frozen actions.',
  },
  paths: {
    [BILLING_RECURRING_ADDONS_READ_PATH]: {
      post: {
        ...authenticatedOperation,
        operationId: 'getBillingRecurringAddonsV1',
        summary: 'Read add-on offers and team entitlement status',
        description:
          'The product posts the exact subject bound into X-UOA-Actor. Active exact-team members receive a UOA-filtered display projection. Only billing managers receive enabled subscribe or cancel actions.',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: billingSubjectRequestJsonSchema },
          },
        },
        responses: {
          200: {
            description: 'Display-ready recurring add-ons.',
            headers: { 'Cache-Control': noStoreHeader },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BillingRecurringAddonsV1' },
              },
            },
          },
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          503: errorResponse,
        },
      },
    },
    [BILLING_RECURRING_ADDONS_CHECKOUT_PATH]: {
      post: {
        ...authenticatedOperation,
        operationId: 'createBillingRecurringAddonCheckout',
        summary: 'Create Checkout for one exact UOA add-on offer',
        description:
          'Products re-fetch the projection and relay the complete frozen action body unchanged. UOA verifies its subject against the app key and actor, then derives idempotency from the exact scope and offer.',
        'x-uoa-idempotency': 'server-derived-exact-scope',
        requestBody: selectorBody('offer_id'),
        responses: {
          200: {
            description: 'Normalized HTTPS Stripe Checkout redirect.',
            headers: { 'Cache-Control': noStoreHeader },
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BillingHostedRedirectResponse' },
              },
            },
          },
          ...commonErrors,
        },
      },
    },
    [BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH]: {
      post: {
        ...authenticatedOperation,
        operationId: 'previewBillingRecurringAddonCancellation',
        summary: 'Preview cancellation for one exact UOA subscription',
        requestBody: selectorBody('subscription_id'),
        responses: {
          200: {
            description: 'Short-lived UOA cancellation preview.',
            headers: { 'Cache-Control': noStoreHeader },
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/BillingRecurringAddonCancellationPreviewV1',
                },
              },
            },
          },
          ...commonErrors,
        },
      },
    },
    [BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH]: {
      post: {
        ...authenticatedOperation,
        operationId: 'confirmBillingRecurringAddonCancellation',
        summary: 'Confirm one still-valid UOA cancellation preview',
        description:
          'Replay-safe through the opaque UOA preview token and UOA-issued idempotency key returned by the preview.',
        'x-uoa-idempotency': 'uoa-issued-preview-key',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/BillingRecurringAddonCancellationConfirmRequestV1',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Cancellation scheduled or already scheduled.',
            headers: { 'Cache-Control': noStoreHeader },
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/BillingRecurringAddonCancellationConfirmationV1',
                },
              },
            },
          },
          ...commonErrors,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      UoaAppKey: { type: 'apiKey', in: 'header', name: 'X-UOA-App-Key' },
      UoaBearerAppKey: { type: 'http', scheme: 'bearer', bearerFormat: 'uoa_app_…' },
      UoaActor: {
        type: 'apiKey',
        in: 'header',
        name: 'X-UOA-Actor',
        description: 'Fresh credential-bound RS256 actor assertion for the exact user/org/team.',
      },
    },
    schemas: {
      BillingSubjectRequest: billingSubjectRequestJsonSchema,
      BillingRecurringAddonProtocolV1: billingRecurringAddonProtocolV1JsonSchema,
      BillingRecurringAddonsV1: billingRecurringAddonsV1JsonSchema,
      BillingRecurringAddonCancellationPreviewV1:
        billingRecurringAddonCancellationPreviewV1JsonSchema,
      BillingRecurringAddonCancellationConfirmRequestV1:
        billingRecurringAddonCancellationConfirmRequestV1JsonSchema,
      BillingRecurringAddonCancellationConfirmationV1:
        billingRecurringAddonCancellationConfirmationV1JsonSchema,
      BillingHostedRedirectResponse: billingHostedRedirectResponseJsonSchema,
      BillingErrorEnvelope: billingErrorEnvelopeJsonSchema,
    },
    examples: {
      BillingRecurringAddonV1Conformance: {
        summary: 'DeepWater $50 monthly privacy add-on and its exact cancellation flow',
        value: billingRecurringAddonV1ConformanceFixtures,
      },
    },
  },
} as const;

export type BillingRecurringAddonV1OpenApiDocument = typeof billingRecurringAddonV1OpenApiDocument;
