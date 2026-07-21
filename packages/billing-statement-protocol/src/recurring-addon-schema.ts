import {
  billingSubjectActionBodySchema,
  moneySchema,
  nullableDateTimeSchema,
} from './funding-schema-primitives.js';
import {
  BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH,
  BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH,
  BILLING_RECURRING_ADDONS_CHECKOUT_PATH,
  BILLING_RECURRING_ADDONS_SCHEMA_PATH,
  BILLING_RECURRING_ADDONS_SCHEMA_VERSION,
} from './recurring-addon-types.js';
import {
  billingRecurringAddonManagerSubscriptionJsonSchema,
  billingRecurringAddonMemberSubscriptionJsonSchema,
  billingRecurringAddonVisibilityDiscriminatorJsonSchema,
} from './recurring-addon-visibility-schema.js';

const actionBaseProperties = {
  label: { type: 'string' },
  description: { type: 'string' },
  enabled: { type: 'boolean' },
  disabled_reason: { type: ['string', 'null'] },
} as const;

const actionBaseRequired = [
  'id',
  'kind',
  'label',
  'description',
  'enabled',
  'disabled_reason',
  'request',
] as const;

export const billingRecurringAddonCheckoutActionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: actionBaseRequired,
  properties: {
    id: { const: 'subscribe' },
    kind: { const: 'hosted_redirect' },
    ...actionBaseProperties,
    request: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'path', 'body'],
      properties: {
        method: { const: 'POST' },
        path: { const: BILLING_RECURRING_ADDONS_CHECKOUT_PATH },
        body: billingSubjectActionBodySchema(
          { offer_id: { type: 'string', minLength: 1, maxLength: 256 } },
          ['offer_id'],
        ),
      },
    },
  },
} as const;

export const billingRecurringAddonCancelActionJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: actionBaseRequired,
  properties: {
    id: { const: 'cancel' },
    kind: { const: 'confirmation_dialog' },
    ...actionBaseProperties,
    request: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'path', 'body'],
      properties: {
        method: { const: 'POST' },
        path: { const: BILLING_RECURRING_ADDONS_CANCELLATION_PREVIEW_PATH },
        body: billingSubjectActionBodySchema(
          { subscription_id: { type: 'string', minLength: 1, maxLength: 256 } },
          ['subscription_id'],
        ),
      },
    },
  },
} as const;

const monthlyMoney = moneySchema({ positive: true });

export const billingRecurringAddonsV1JsonSchema = {
  type: 'object',
  additionalProperties: false,
  oneOf: billingRecurringAddonVisibilityDiscriminatorJsonSchema.oneOf,
  required: [
    'schema_version',
    'generated_at',
    'product',
    'subject',
    'viewer',
    'capabilities',
    'collection',
    'title',
    'description',
    'offers',
  ],
  properties: {
    schema_version: { const: BILLING_RECURRING_ADDONS_SCHEMA_VERSION },
    generated_at: { type: 'string', format: 'date-time' },
    product: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'identifier', 'name'],
      properties: {
        id: { type: 'string', minLength: 1 },
        identifier: { type: 'string', minLength: 1 },
        name: { type: 'string', minLength: 1 },
      },
    },
    subject: {
      type: 'object',
      additionalProperties: false,
      required: ['user_id', 'organisation_id', 'team_id'],
      properties: {
        user_id: { type: 'string', minLength: 1 },
        organisation_id: { type: 'string', minLength: 1 },
        team_id: { type: 'string', minLength: 1 },
      },
    },
    viewer: {
      type: 'object',
      additionalProperties: false,
      required: ['role', 'entitlement_visibility', 'description'],
      properties: {
        role: { enum: ['member', 'billing_manager'] },
        entitlement_visibility: { enum: ['own_plus_team_status', 'full_team'] },
        description: { type: 'string' },
      },
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      required: ['can_manage_addons'],
      properties: { can_manage_addons: { type: 'boolean' } },
    },
    collection: {
      type: 'object',
      additionalProperties: false,
      required: ['stripe_collection_enabled', 'stripe_mode'],
      properties: {
        stripe_collection_enabled: { type: 'boolean' },
        stripe_mode: { enum: ['test', 'live', null] },
      },
    },
    title: { type: 'string' },
    description: { type: 'string' },
    offers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'key',
          'version',
          'name',
          'description',
          'benefits',
          'monthly_price',
          'interval',
          'available',
          'unavailable_reason',
          'entitlement',
          'subscription',
          'actions',
        ],
        properties: {
          id: { type: 'string', minLength: 1 },
          key: { type: 'string', minLength: 1 },
          version: { type: 'integer', minimum: 1 },
          name: { type: 'string' },
          description: { type: 'string' },
          benefits: { type: 'array', items: { type: 'string' } },
          monthly_price: monthlyMoney,
          interval: { const: 'month' },
          available: { type: 'boolean' },
          unavailable_reason: { type: ['string', 'null'] },
          entitlement: {
            type: 'object',
            additionalProperties: false,
            required: ['state', 'display_status', 'description'],
            properties: {
              state: { enum: ['inactive', 'pending', 'active', 'unavailable'] },
              display_status: { type: 'string' },
              description: { type: 'string' },
            },
          },
          subscription: {
            oneOf: [
              billingRecurringAddonManagerSubscriptionJsonSchema,
              billingRecurringAddonMemberSubscriptionJsonSchema,
              { type: 'null' },
            ],
          },
          actions: {
            type: 'array',
            items: {
              oneOf: [
                billingRecurringAddonCheckoutActionJsonSchema,
                billingRecurringAddonCancelActionJsonSchema,
              ],
            },
          },
        },
      },
    },
  },
} as const;

export const billingRecurringAddonCancellationPreviewV1JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version',
    'preview_token',
    'idempotency_key',
    'expires_at',
    'title',
    'description',
    'subscription',
    'confirm_action',
  ],
  properties: {
    schema_version: { const: BILLING_RECURRING_ADDONS_SCHEMA_VERSION },
    preview_token: { type: 'string', minLength: 32, maxLength: 256 },
    idempotency_key: { type: 'string', minLength: 16, maxLength: 200 },
    expires_at: { type: 'string', format: 'date-time' },
    title: { type: 'string' },
    description: { type: 'string' },
    subscription: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'offer_name', 'display_status', 'cancellation_effective_at'],
      properties: {
        id: { type: 'string', minLength: 1 },
        offer_name: { type: 'string' },
        display_status: { type: 'string' },
        cancellation_effective_at: nullableDateTimeSchema,
      },
    },
    confirm_action: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'path', 'body'],
      properties: {
        method: { const: 'POST' },
        path: { const: BILLING_RECURRING_ADDONS_CANCELLATION_CONFIRM_PATH },
        body: billingSubjectActionBodySchema(
          {
            preview_token: { type: 'string', minLength: 32, maxLength: 256 },
            idempotency_key: { type: 'string', minLength: 16, maxLength: 200 },
            choice: { const: 'cancel_addon' },
          },
          ['preview_token', 'idempotency_key', 'choice'],
        ),
      },
    },
  },
} as const;

export const billingRecurringAddonCancellationConfirmRequestV1JsonSchema = {
  ...billingSubjectActionBodySchema(
    {
      preview_token: { type: 'string', minLength: 32, maxLength: 256 },
      idempotency_key: { type: 'string', minLength: 16, maxLength: 200 },
      choice: { const: 'cancel_addon' },
    },
    ['preview_token', 'idempotency_key', 'choice'],
  ),
} as const;

export const billingRecurringAddonCancellationConfirmationV1JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'status', 'title', 'description', 'cancellation_effective_at'],
  properties: {
    schema_version: { const: BILLING_RECURRING_ADDONS_SCHEMA_VERSION },
    status: { enum: ['scheduled', 'already_scheduled'] },
    title: { type: 'string' },
    description: { type: 'string' },
    cancellation_effective_at: nullableDateTimeSchema,
  },
} as const;

export const billingRecurringAddonProtocolV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: BILLING_RECURRING_ADDONS_SCHEMA_PATH,
  title: 'UOA recurring add-on consumer protocol v1',
  description:
    'Exact display model and single-add-on subscription cancellation messages. Runtime entitlements remain UOA-resolved.',
  oneOf: [
    { $ref: '#/$defs/BillingRecurringAddonsV1' },
    { $ref: '#/$defs/BillingRecurringAddonCancellationPreviewV1' },
    { $ref: '#/$defs/BillingRecurringAddonCancellationConfirmRequestV1' },
    { $ref: '#/$defs/BillingRecurringAddonCancellationConfirmationV1' },
  ],
  $defs: {
    BillingRecurringAddonsV1: billingRecurringAddonsV1JsonSchema,
    BillingRecurringAddonCancellationPreviewV1:
      billingRecurringAddonCancellationPreviewV1JsonSchema,
    BillingRecurringAddonCancellationConfirmRequestV1:
      billingRecurringAddonCancellationConfirmRequestV1JsonSchema,
    BillingRecurringAddonCancellationConfirmationV1:
      billingRecurringAddonCancellationConfirmationV1JsonSchema,
  },
} as const;
