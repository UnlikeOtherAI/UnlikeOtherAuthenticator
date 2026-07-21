import {
  billingCreditsAutoTopUpDisableActionJsonSchema,
  billingCreditsAutoTopUpRecoverActionJsonSchema,
  billingCreditsAutoTopUpSetupActionJsonSchema,
  billingCreditsAutoTopUpUpdateActionJsonSchema,
  billingCreditsTopUpActionJsonSchema,
  nullableBillingCreditsAction,
} from './credits-action-schema.js';
import { creditAmountSchema, moneySchema } from './funding-schema-primitives.js';
import {
  billingCreditsManagerRecentEntriesJsonSchema,
  billingCreditsManagerSummaryJsonSchema,
  billingCreditsManagerConsentJsonSchema,
  billingCreditsManagerPaymentMethodJsonSchema,
  billingCreditsMemberRecentEntriesJsonSchema,
  billingCreditsMemberSummaryJsonSchema,
  billingCreditsMemberPaymentMethodJsonSchema,
  billingCreditsMemberAutomaticTopUpJsonSchema,
  billingCreditsVisibilityDiscriminatorJsonSchema,
} from './credits-visibility-schema.js';
import { BILLING_CREDITS_SCHEMA_PATH, BILLING_CREDITS_SCHEMA_VERSION } from './credits-types.js';

const signedCredits = creditAmountSchema({ signed: true });
const positiveCredits = creditAmountSchema({ positive: true });
const unsignedCredits = creditAmountSchema();
const usdMoney = moneySchema({ usdOnly: true });
const positivePaymentMoney = moneySchema({ positive: true, usdOnly: true });

export const billingCreditsV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: BILLING_CREDITS_SCHEMA_PATH,
  title: 'UOA billing credits consumer contract v1',
  description:
    'Display-ready shared team credits, fixed top-up offers, bounded automatic top-up options, and immutable entry history.',
  type: 'object',
  additionalProperties: false,
  oneOf: billingCreditsVisibilityDiscriminatorJsonSchema.oneOf,
  required: [
    'schema_version',
    'credit_account_id',
    'generated_at',
    'storefront',
    'subject',
    'viewer',
    'capabilities',
    'conversion',
    'current_period',
    'collection',
    'credit_balance',
    'pending_credits',
    'credit_summary',
    'funding_policy',
    'automatic_top_up',
    'recent_entries',
  ],
  properties: {
    schema_version: { const: BILLING_CREDITS_SCHEMA_VERSION },
    credit_account_id: { type: 'string', minLength: 1 },
    generated_at: { type: 'string', format: 'date-time' },
    storefront: {
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
      required: ['role', 'usage_visibility', 'description'],
      properties: {
        role: { enum: ['member', 'billing_manager'] },
        usage_visibility: { enum: ['own_plus_team_aggregate', 'full_team'] },
        description: { type: 'string' },
      },
    },
    capabilities: {
      type: 'object',
      additionalProperties: false,
      required: ['can_top_up', 'can_manage_automatic_top_up'],
      properties: {
        can_top_up: { type: 'boolean' },
        can_manage_automatic_top_up: { type: 'boolean' },
      },
    },
    conversion: {
      type: 'object',
      additionalProperties: false,
      required: ['credits_per_usd', 'settlement_currency', 'description'],
      properties: {
        credits_per_usd: { const: '1000' },
        settlement_currency: { const: 'USD' },
        description: { type: 'string' },
      },
    },
    current_period: {
      type: 'object',
      additionalProperties: false,
      required: ['starts_at', 'ends_at'],
      properties: {
        starts_at: { type: 'string', format: 'date-time' },
        ends_at: { type: 'string', format: 'date-time' },
      },
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
    credit_balance: {
      ...signedCredits,
      required: [...signedCredits.required, 'state', 'label', 'description'],
      properties: {
        ...signedCredits.properties,
        state: { enum: ['available', 'zero', 'debt'] },
        label: { const: 'Remaining credits' },
        description: { type: 'string' },
      },
    },
    pending_credits: {
      type: 'object',
      additionalProperties: false,
      required: ['top_up_count', 'payment_amount', 'credits_received', 'label', 'description'],
      properties: {
        top_up_count: { type: 'integer', minimum: 0 },
        payment_amount: { oneOf: [usdMoney, { type: 'null' }] },
        credits_received: unsignedCredits,
        label: { type: 'string' },
        description: { type: 'string' },
      },
    },
    credit_summary: {
      anyOf: [billingCreditsManagerSummaryJsonSchema, billingCreditsMemberSummaryJsonSchema],
    },
    funding_policy: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'top_up_enabled',
            'automatic_top_up_enabled',
            'title',
            'description',
            'offers',
          ],
          properties: {
            top_up_enabled: { type: 'boolean' },
            automatic_top_up_enabled: { type: 'boolean' },
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
                  'name',
                  'description',
                  'payment_amount',
                  'credits_received',
                  'available',
                  'unavailable_reason',
                  'action',
                ],
                properties: {
                  id: { type: 'string', minLength: 1 },
                  key: { type: 'string', minLength: 1 },
                  name: { type: 'string' },
                  description: { type: 'string' },
                  payment_amount: positivePaymentMoney,
                  credits_received: positiveCredits,
                  available: { type: 'boolean' },
                  unavailable_reason: { type: ['string', 'null'] },
                  action: {
                    oneOf: [billingCreditsTopUpActionJsonSchema, { type: 'null' }],
                  },
                },
              },
            },
          },
        },
        { type: 'null' },
      ],
    },
    automatic_top_up: {
      oneOf: [
        billingCreditsMemberAutomaticTopUpJsonSchema,
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'state',
            'display_status',
            'description',
            'threshold',
            'refill_offer_id',
            'monthly_cap',
            'charged_this_month',
            'remaining_monthly_cap',
            'payment_method',
            'consent',
            'options',
            'disable_action',
            'recover_action',
          ],
          properties: {
            state: { enum: ['disabled', 'active', 'paused', 'requires_action', 'needs_review'] },
            display_status: { type: 'string' },
            description: { type: 'string' },
            threshold: { oneOf: [unsignedCredits, { type: 'null' }] },
            refill_offer_id: { type: ['string', 'null'] },
            monthly_cap: { oneOf: [positivePaymentMoney, { type: 'null' }] },
            charged_this_month: usdMoney,
            remaining_monthly_cap: { oneOf: [usdMoney, { type: 'null' }] },
            payment_method: {
              oneOf: [
                billingCreditsManagerPaymentMethodJsonSchema,
                billingCreditsMemberPaymentMethodJsonSchema,
              ],
            },
            consent: {
              oneOf: [billingCreditsManagerConsentJsonSchema],
            },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'selected',
                  'label',
                  'description',
                  'threshold',
                  'refill_offer_id',
                  'refill_payment_amount',
                  'refill_credits_received',
                  'monthly_cap',
                  'setup_action',
                  'update_action',
                ],
                properties: {
                  selected: { type: 'boolean' },
                  label: { type: 'string' },
                  description: { type: 'string' },
                  threshold: unsignedCredits,
                  refill_offer_id: { type: 'string', minLength: 1 },
                  refill_payment_amount: positivePaymentMoney,
                  refill_credits_received: positiveCredits,
                  monthly_cap: positivePaymentMoney,
                  setup_action: nullableBillingCreditsAction(
                    billingCreditsAutoTopUpSetupActionJsonSchema,
                  ),
                  update_action: nullableBillingCreditsAction(
                    billingCreditsAutoTopUpUpdateActionJsonSchema,
                  ),
                },
              },
            },
            disable_action: nullableBillingCreditsAction(
              billingCreditsAutoTopUpDisableActionJsonSchema,
            ),
            recover_action: nullableBillingCreditsAction(
              billingCreditsAutoTopUpRecoverActionJsonSchema,
            ),
          },
        },
      ],
    },
    recent_entries: {
      anyOf: [
        billingCreditsManagerRecentEntriesJsonSchema,
        billingCreditsMemberRecentEntriesJsonSchema,
      ],
    },
  },
} as const;
