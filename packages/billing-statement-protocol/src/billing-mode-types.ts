/** Opt in on reads. Relay the displayed token unchanged on the later action. */
export const BILLING_MODE_PROTOCOL_HEADER = 'x-uoa-billing-mode-protocol' as const;
export const BILLING_MODE_PROTOCOL_VERSION = '1.0.0' as const;
export const BILLING_CONTEXT_MAX_LENGTH = 2048 as const;
export type BillingModeBoundAction = { billing_context?: string };
export const billingModeContextProperties = {
  billing_context: { type: 'string', minLength: 1, maxLength: BILLING_CONTEXT_MAX_LENGTH },
} as const;
export const BILLING_CONTEXT_ERROR_CODES = [
  'BILLING_CONTEXT_REQUIRED', 'BILLING_CONTEXT_STALE', 'BILLING_CONTEXT_INVALID',
] as const;
