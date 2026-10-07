import { billingSubjectRequestJsonSchema } from './funding-schema-primitives.js';
import {
  BILLING_CREDIT_ATTENTION_KINDS,
  BILLING_CREDIT_FUNDING_REQUEST_PATH,
  BILLING_CREDIT_FUNDING_REQUEST_SCHEMA_PATH,
} from './credits-attention-types.js';

const opaqueId = { type: 'string', minLength: 1, maxLength: 256 } as const;

export const billingCreditAttentionV1JsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['event_key', 'kind'],
  properties: { event_key: opaqueId, kind: { enum: BILLING_CREDIT_ATTENTION_KINDS } },
} as const;

export const billingCreditFundingRequestActionV1JsonSchema = {
  type: 'object', additionalProperties: false,
  required: ['label', 'enabled', 'disabled_reason', 'request'],
  properties: {
    label: { type: 'string', minLength: 1 },
    enabled: { type: 'boolean' },
    disabled_reason: { type: ['string', 'null'] },
    request: {
      type: 'object', additionalProperties: false,
      required: ['method', 'path', 'body'],
      properties: {
        method: { const: 'POST' },
        path: { const: BILLING_CREDIT_FUNDING_REQUEST_PATH },
        body: billingSubjectRequestJsonSchema,
      },
    },
  },
} as const;

export const billingCreditFundingRequestV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: BILLING_CREDIT_FUNDING_REQUEST_SCHEMA_PATH,
  type: 'object', additionalProperties: false,
  required: ['schema_version', 'request_id', 'recipient_user_ids'],
  properties: {
    schema_version: { const: 1 },
    request_id: opaqueId,
    recipient_user_ids: { type: 'array', uniqueItems: true, items: opaqueId },
  },
} as const;
