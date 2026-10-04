import { BILLING_CREDIT_PURCHASE_SCHEMA_PATH, BILLING_CREDIT_PURCHASE_STATES } from './presentation-types.js';

export const billingCreditPurchaseStatusV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: BILLING_CREDIT_PURCHASE_SCHEMA_PATH,
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'purchase_id', 'state', 'title', 'message', 'awaiting_confirmation'],
  properties: {
    schema_version: { const: 1 },
    purchase_id: { type: 'string', minLength: 1, maxLength: 256 },
    state: { enum: BILLING_CREDIT_PURCHASE_STATES },
    title: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
    awaiting_confirmation: { type: 'boolean' },
  },
} as const;
