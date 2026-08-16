import { BILLING_ORG_BILLING_MANAGE_ACTION_ID } from './org-billing-types.js';

export { BILLING_ORG_BILLING_MANAGE_ACTION_ID } from './org-billing-types.js';
export type { BillingControlledByV1 } from './org-billing-types.js';

/**
 * Shared by the statement (v1 and v2) and the credits view. Optional in every
 * parent schema, so a 1.2.0 fixture stays valid and an un-upgraded consumer
 * simply does not see it.
 */
export const billingControlledByJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'scope',
    'organisation_id',
    'organisation_name',
    'message',
    'can_manage',
    'manage_action_id',
  ],
  properties: {
    scope: { const: 'organisation' },
    organisation_id: { type: 'string', minLength: 1, maxLength: 256 },
    organisation_name: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
    can_manage: { type: 'boolean' },
    manage_action_id: {
      oneOf: [{ const: BILLING_ORG_BILLING_MANAGE_ACTION_ID }, { type: 'null' }],
    },
  },
} as const;
