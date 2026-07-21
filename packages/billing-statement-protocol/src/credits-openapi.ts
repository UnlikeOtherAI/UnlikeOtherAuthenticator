import {
  billingErrorEnvelopeJsonSchema,
  billingHostedRedirectResponseJsonSchema,
} from './action-schema.js';
import { billingCreditsV1ConformanceFixture } from './credits-conformance-fixture.js';
import { billingCreditsV1JsonSchema } from './credits-schema.js';
import {
  billingSubjectActionBodySchema,
  billingSubjectRequestJsonSchema,
} from './funding-schema-primitives.js';
import {
  BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH,
  BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH,
  BILLING_CREDITS_PROTOCOL_VERSION,
  BILLING_CREDITS_READ_PATH,
  BILLING_CREDITS_TOP_UP_PATH,
} from './credits-types.js';

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

function requestBody(selector: 'offer_id' | 'option_id' | null) {
  const schema = selector
    ? billingSubjectActionBodySchema({ [selector]: { type: 'string', minLength: 1 } }, [selector])
    : billingSubjectRequestJsonSchema;
  return {
    required: true,
    content: {
      'application/json': { schema },
    },
  } as const;
}

const hostedRedirectResponse = {
  description: 'A normalized HTTPS URL for UOA-hosted Stripe Checkout or recovery.',
  headers: { 'Cache-Control': noStoreHeader },
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/BillingHostedRedirectResponse' } },
  },
} as const;

const mutationResponses = {
  204: {
    description: 'The exact UOA-managed configuration was updated.',
    headers: { 'Cache-Control': noStoreHeader },
  },
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  409: errorResponse,
  503: errorResponse,
} as const;

export const billingCreditsV1OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'UOA BillingCreditsV1 consumer API',
    version: BILLING_CREDITS_PROTOCOL_VERSION,
    description:
      'Exact customer-facing shared team credits API. UOA returns display-ready values and capabilities; products never calculate balances, conversion, privacy filtering, or authorization.',
  },
  paths: {
    [BILLING_CREDITS_READ_PATH]: {
      post: {
        ...authenticatedOperation,
        operationId: 'getBillingCreditsV1',
        summary: 'Read the exact active team credit projection',
        description:
          'The product posts the exact subject bound into X-UOA-Actor. Every active exact-team member may read remaining, pending, and current-period aggregate credits. UOA returns full-team user detail only to billing managers; ordinary members receive a privacy-safe own-plus-team-aggregate projection.',
        requestBody: requestBody(null),
        responses: {
          200: {
            description: 'Display-ready BillingCreditsV1.',
            headers: { 'Cache-Control': noStoreHeader },
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/BillingCreditsV1' } },
            },
          },
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
          503: errorResponse,
        },
      },
    },
    [BILLING_CREDITS_TOP_UP_PATH]: {
      post: {
        ...authenticatedOperation,
        operationId: 'createBillingCreditTopUpCheckout',
        summary: 'Create Checkout for one UOA-defined credit offer',
        description:
          'Products re-fetch the projection and relay the complete frozen action body unchanged. UOA verifies its subject against the app key and actor, then derives idempotency from the exact team, actor assertion, and offer.',
        'x-uoa-idempotency': 'server-derived-exact-scope',
        requestBody: requestBody('offer_id'),
        responses: {
          200: hostedRedirectResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          503: errorResponse,
        },
      },
    },
    [BILLING_CREDITS_AUTO_TOP_UP_SETUP_PATH]: {
      post: {
        ...authenticatedOperation,
        operationId: 'createBillingCreditAutoTopUpSetup',
        summary: 'Create Setup Checkout for one bounded automatic top-up option',
        description:
          'Retry-safe: UOA recovers the exact open Setup Checkout using server-owned idempotency and leases.',
        'x-uoa-idempotency': 'server-derived-exact-scope',
        requestBody: requestBody('option_id'),
        responses: {
          200: hostedRedirectResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          503: errorResponse,
        },
      },
    },
    [BILLING_CREDITS_AUTO_TOP_UP_UPDATE_PATH]: {
      post: {
        ...authenticatedOperation,
        operationId: 'updateBillingCreditAutoTopUp',
        summary: 'Consent to one bounded UOA option using the verified payment method',
        description: 'Idempotently selects one immutable UOA consent revision.',
        'x-uoa-idempotency': 'server-derived-exact-scope',
        requestBody: requestBody('option_id'),
        responses: mutationResponses,
      },
    },
    [BILLING_CREDITS_AUTO_TOP_UP_DISABLE_PATH]: {
      post: {
        ...authenticatedOperation,
        operationId: 'disableBillingCreditAutoTopUp',
        summary: 'Disable future automatic top-ups for the exact team',
        description: 'Idempotent; repeated calls leave automatic top-up disabled.',
        'x-uoa-idempotency': 'server-derived-exact-scope',
        requestBody: requestBody(null),
        responses: mutationResponses,
      },
    },
    [BILLING_CREDITS_AUTO_TOP_UP_RECOVER_PATH]: {
      post: {
        ...authenticatedOperation,
        operationId: 'recoverBillingCreditAutoTopUp',
        summary: 'Open UOA-hosted recovery for the exact pending payment',
        requestBody: requestBody(null),
        responses: {
          200: hostedRedirectResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          409: errorResponse,
          503: errorResponse,
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
      BillingCreditsV1: billingCreditsV1JsonSchema,
      BillingHostedRedirectResponse: billingHostedRedirectResponseJsonSchema,
      BillingErrorEnvelope: billingErrorEnvelopeJsonSchema,
    },
    examples: {
      BillingCreditsV1Conformance: {
        summary: 'Shared team credits with fixed conversion and bounded automatic top-up',
        value: billingCreditsV1ConformanceFixture,
      },
    },
  },
} as const;

export type BillingCreditsV1OpenApiDocument = typeof billingCreditsV1OpenApiDocument;
