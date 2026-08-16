import { BILLING_CONSUMER_ACTION_SCHEMA_PATH } from './action-types.js';

const billingCancellationSelectionValues = [
  'current_service',
  'current_and_related_direct_services',
] as const;

export const billingCancellationSelectionJsonSchema = {
  type: 'string',
  enum: billingCancellationSelectionValues,
} as const;

export const billingHostedRedirectResponseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['redirect_url'],
  properties: {
    redirect_url: {
      type: 'string',
      format: 'uri',
      pattern: '^https://',
    },
  },
} as const;

export const billingCancellationPreviewV1JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'preview_token',
    'expires_at',
    'title',
    'message',
    'choice_required',
    'choices',
    'direct_services',
    'indirect_services',
    'confirm_action',
  ],
  properties: {
    schema_version: { const: 1 },
    preview_token: { type: 'string', minLength: 32, maxLength: 256 },
    expires_at: { type: 'string', format: 'date-time' },
    title: { type: 'string' },
    message: { type: 'string' },
    choice_required: { type: 'boolean' },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label', 'description', 'service_ids'],
        properties: {
          id: billingCancellationSelectionJsonSchema,
          label: { type: 'string' },
          description: { type: 'string' },
          service_ids: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    direct_services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'service_id',
          'product',
          'name',
          'display_name',
          'direct_user_count',
          'subscription_status',
        ],
        properties: {
          service_id: { type: 'string', minLength: 1 },
          product: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          display_name: { type: 'string' },
          direct_user_count: { type: 'integer', minimum: 0 },
          subscription_status: { type: 'string' },
        },
      },
    },
    indirect_services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product', 'name', 'display_name', 'impact'],
        properties: {
          product: { type: 'string', minLength: 1 },
          name: { type: ['string', 'null'] },
          display_name: { type: 'string' },
          impact: { type: 'string' },
        },
      },
    },
    confirm_action: {
      type: 'object',
      additionalProperties: false,
      required: [
        'method',
        'path',
        'label',
        'idempotency_key',
        'selection_required',
        'default_selection',
      ],
      properties: {
        method: { const: 'POST' },
        path: { const: '/billing/v1/cancellation/confirm' },
        label: { type: 'string' },
        idempotency_key: { type: 'string', minLength: 16, maxLength: 200 },
        selection_required: { type: 'boolean' },
        default_selection: {
          enum: ['current_service', null],
        },
      },
    },
  },
} as const;

export const billingCancellationConfirmRequestJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['preview_token', 'idempotency_key', 'selection'],
  properties: {
    preview_token: { type: 'string', minLength: 32, maxLength: 256 },
    idempotency_key: { type: 'string', minLength: 16, maxLength: 200 },
    selection: {
      enum: [...billingCancellationSelectionValues, null],
    },
  },
} as const;

export const billingCancellationConfirmationV1JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'status',
    'title',
    'message',
    'cancelled_services',
    'indirect_services',
  ],
  properties: {
    schema_version: { const: 1 },
    status: { const: 'confirmed' },
    title: { type: 'string' },
    message: { type: 'string' },
    cancelled_services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['service_id', 'product', 'name', 'display_name', 'status', 'effective_at'],
        properties: {
          service_id: { type: 'string', minLength: 1 },
          product: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          display_name: { type: 'string' },
          status: { type: 'string' },
          effective_at: {
            anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
          },
        },
      },
    },
    indirect_services: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product', 'display_name', 'impact'],
        properties: {
          product: { type: 'string', minLength: 1 },
          display_name: { type: 'string' },
          impact: { type: 'string' },
        },
      },
    },
  },
} as const;

const hostedReturnUrlSchema = {
  type: 'string',
  format: 'uri',
  pattern: '^https://',
  maxLength: 2048,
} as const;

const billingSubjectActionRequestProperties = {
  product: { type: 'string', minLength: 1, maxLength: 100 },
  organisation_id: { type: 'string', minLength: 1, maxLength: 256 },
  team_id: { type: 'string', minLength: 1, maxLength: 256 },
  user_id: { type: 'string', minLength: 1, maxLength: 256 },
} as const;

const billingSubjectActionRequestRequired = [
  'product',
  'organisation_id',
  'team_id',
  'user_id',
] as const;

export const billingCheckoutSessionRequestJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...billingSubjectActionRequestRequired, 'success_url', 'cancel_url'],
  properties: {
    ...billingSubjectActionRequestProperties,
    success_url: hostedReturnUrlSchema,
    cancel_url: hostedReturnUrlSchema,
  },
} as const;

export const billingCheckoutTariffJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'key',
    'version',
    'mode',
    'collection_mode',
    'markup_bps',
    'markup_percent',
    'usage_price_multiplier_bps',
    'monthly_subscription',
    'usage_billing_enabled',
    'payment_collection_enabled',
    'raw_usage_preserved',
  ],
  properties: {
    id: { type: 'string', minLength: 1 },
    key: { type: 'string', minLength: 1 },
    version: { type: 'integer', minimum: 0 },
    mode: { type: 'string', enum: ['standard', 'free', 'at_cost', 'custom'] },
    collection_mode: { type: 'string', enum: ['stripe', 'manual', 'none'] },
    markup_bps: { type: 'integer', minimum: 0 },
    markup_percent: { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$' },
    usage_price_multiplier_bps: { type: 'integer', minimum: 0 },
    monthly_subscription: {
      type: 'object',
      additionalProperties: false,
      required: ['amount_minor', 'currency'],
      properties: {
        amount_minor: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      },
    },
    usage_billing_enabled: { type: 'boolean' },
    payment_collection_enabled: { type: 'boolean' },
    raw_usage_preserved: { const: true },
  },
} as const;

export const billingCheckoutSessionResponseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['checkout_session_id', 'checkout_url', 'expires_at', 'tariff'],
  properties: {
    checkout_session_id: { type: 'string', minLength: 1 },
    checkout_url: { type: 'string', format: 'uri', pattern: '^https://' },
    expires_at: { type: 'string', format: 'date-time' },
    tariff: billingCheckoutTariffJsonSchema,
  },
} as const;

export const billingPortalSessionRequestJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...billingSubjectActionRequestRequired, 'return_url'],
  properties: {
    ...billingSubjectActionRequestProperties,
    return_url: hostedReturnUrlSchema,
  },
} as const;

export const billingPortalSessionResponseJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['portal_url'],
  properties: {
    portal_url: { type: 'string', format: 'uri', pattern: '^https://' },
  },
} as const;

export const billingErrorEnvelopeJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: { type: 'string', minLength: 1 },
  },
} as const;

export const billingConsumerActionProtocolV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: BILLING_CONSUMER_ACTION_SCHEMA_PATH,
  title: 'UOA billing consumer action protocol v1',
  description:
    'Exact public schemas for product-hosted billing redirects and the UOA cancellation interaction.',
  oneOf: [
    { $ref: '#/$defs/BillingHostedRedirectResponse' },
    { $ref: '#/$defs/BillingCheckoutSessionRequest' },
    { $ref: '#/$defs/BillingCheckoutSessionResponse' },
    { $ref: '#/$defs/BillingPortalSessionRequest' },
    { $ref: '#/$defs/BillingPortalSessionResponse' },
    { $ref: '#/$defs/BillingCancellationPreviewV1' },
    { $ref: '#/$defs/BillingCancellationConfirmRequest' },
    { $ref: '#/$defs/BillingCancellationConfirmationV1' },
    { $ref: '#/$defs/BillingErrorEnvelope' },
  ],
  $defs: {
    BillingCancellationSelection: billingCancellationSelectionJsonSchema,
    BillingHostedRedirectResponse: billingHostedRedirectResponseJsonSchema,
    BillingCheckoutSessionRequest: billingCheckoutSessionRequestJsonSchema,
    BillingCheckoutTariff: billingCheckoutTariffJsonSchema,
    BillingCheckoutSessionResponse: billingCheckoutSessionResponseJsonSchema,
    BillingPortalSessionRequest: billingPortalSessionRequestJsonSchema,
    BillingPortalSessionResponse: billingPortalSessionResponseJsonSchema,
    BillingCancellationPreviewV1: billingCancellationPreviewV1JsonSchema,
    BillingCancellationConfirmRequest: billingCancellationConfirmRequestJsonSchema,
    BillingCancellationConfirmationV1: billingCancellationConfirmationV1JsonSchema,
    BillingErrorEnvelope: billingErrorEnvelopeJsonSchema,
  },
} as const;
