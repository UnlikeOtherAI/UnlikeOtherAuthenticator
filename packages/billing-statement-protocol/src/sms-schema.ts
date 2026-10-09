import { billingSubjectActionBodySchema, unsignedDecimalPattern } from './funding-schema-primitives.js';

const id = { type: 'string', minLength: 1, maxLength: 160 } as const;
const nullableId = { anyOf: [id, { type: 'null' }] } as const;
const decimal = { type: 'string', pattern: unsignedDecimalPattern, maxLength: 80 } as const;
const phone = { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' } as const;
const fingerprint = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const account = { type: 'string', pattern: '^AC[a-fA-F0-9]{32}$' } as const;
const message = { type: 'string', pattern: '^SM[a-fA-F0-9]{32}$' } as const;
const scope = {
  country: { type: 'string', pattern: '^[A-Z]{2}$' },
  number_type: { const: 'mobile' },
  direction: { enum: ['monthly', 'inbound', 'outbound'] },
  destination: { anyOf: [phone, { type: 'null' }] },
  carrier: nullableId, mcc: nullableId, mnc: nullableId,
} as const;
function exact(properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } as const;
}

export const billingSmsQuoteRequestV1JsonSchema = billingSubjectActionBodySchema(scope, Object.keys(scope));
export const billingSmsVerifyQuoteRequestV1JsonSchema = billingSubjectActionBodySchema(
  { ...scope, quote_id: id }, [...Object.keys(scope), 'quote_id'],
);
export const billingSmsFinalQuoteV1JsonSchema = exact({
  id, amount: decimal, currency: { const: 'USD' }, expires_at: { type: 'string', format: 'date-time' },
  rate_basis: { enum: ['monthly_mobile', 'inbound_mobile', 'maximum_mobile_carrier'] },
  scope: exact({ organisation_id: id, ...scope }),
});
const binding = {
  dispatch_id: id, request_fingerprint: fingerprint, number_id: id, allocation_id: id,
  account_sid: account, from: phone, to: phone, quote_id: id,
  max_segments: { type: 'integer', minimum: 1, maximum: 100 },
  grant_id: nullableId,
  delegate_id: nullableId,
} as const;
export const billingSmsReserveRequestV1JsonSchema = billingSubjectActionBodySchema(binding, Object.keys(binding));
const read = { product: id, dispatch_id: id } as const;
const claim = { ...read, request_fingerprint: fingerprint } as const;
export const billingSmsReservationReadRequestV1JsonSchema = exact(read);
export const billingSmsClaimRequestV1JsonSchema = exact(claim);
export const billingSmsReceiptRequestV1JsonSchema = exact({ ...claim, message_sid: message });
export const billingSmsReleaseRequestV1JsonSchema = exact({
  ...claim, proof: { const: 'no_provider_dispatch' }, dispatch_token: nullableId,
});
export const billingSmsReservationV1JsonSchema = exact({
  dispatch_id: id, reservation_id: id,
  state: { enum: ['reserved', 'dispatching', 'uncertain', 'settled', 'released', 'reconciliation'] },
  dispatch_token: nullableId, reserved_credits: decimal,
  consumed_credits: { anyOf: [decimal, { type: 'null' }] },
  message_sid: { anyOf: [message, { type: 'null' }] },
});
export const billingSmsDispatchCancellationV1JsonSchema = exact({
  dispatch_id: id, state: { const: 'released' }, can_dispatch: { const: false },
});
export const billingSmsReleaseResultV1JsonSchema = {
  anyOf: [billingSmsReservationV1JsonSchema, billingSmsDispatchCancellationV1JsonSchema],
} as const;
export const billingSmsNumberBeginRequestV1JsonSchema = billingSubjectActionBodySchema(
  { resource_id: id, quote_id: id, phone_number: phone }, ['resource_id', 'quote_id', 'phone_number'],
);
export const billingSmsNumberStatusRequestV1JsonSchema = billingSubjectActionBodySchema(
  { resource_id: id }, ['resource_id'],
);
export const billingSmsNumberRuntimeStatusRequestV1JsonSchema = exact({ product: id, resource_id: id });
export const billingSmsResourceNotFoundV1JsonSchema = exact({
  code: { const: 'BILLING_SMS_RESOURCE_NOT_FOUND' }, resource_id: id,
});
export const billingSmsInsufficientCreditsV1JsonSchema = exact({
  code: { const: 'BILLING_SMS_INSUFFICIENT_CREDITS' },
  reason: { const: 'insufficient_prepaid_credits' },
  can_dispatch: { const: false },
});
export const billingSmsNumberAttachRequestV1JsonSchema = exact({
  product: id, resource_id: id, account_sid: account,
  phone_number_sid: { type: 'string', pattern: '^PN[a-fA-F0-9]{32}$' },
});
export const billingSmsNumberEndRequestV1JsonSchema = exact({
  product: id, resource_id: id, reason: { enum: ['released', 'acquisition_unavailable'] },
});
export const billingSmsNumberV1JsonSchema = exact({
  resource_id: id, organisation_id: id, phone_number: phone,
  state: { enum: ['payment_required', 'payment_pending', 'paid', 'active', 'ending', 'ended',
    'recovery_required', 'refund_required'] },
  quote: billingSmsFinalQuoteV1JsonSchema, acquisition_authorized: { type: 'boolean' },
  checkout_url: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] },
  disabled_reason: nullableId,
});
export const billingSmsNumberCancellationV1JsonSchema = exact({
  resource_id: id, state: { const: 'ended' }, acquisition_authorized: { const: false },
});
export const billingSmsNumberEndResultV1JsonSchema = {
  anyOf: [billingSmsNumberV1JsonSchema, billingSmsNumberCancellationV1JsonSchema],
} as const;

const standing = { product: id, number_id: id, allocation_id: id } as const;
export const billingSmsStandingReadRequestV1JsonSchema = exact(standing);
export const billingSmsStandingHoldRequestV1JsonSchema = billingSubjectActionBodySchema(
  { number_id: id, allocation_id: id, reserve_credits: decimal, idempotency_key: id },
  ['number_id', 'allocation_id', 'reserve_credits', 'idempotency_key'],
);
export const billingSmsInboundReceiptRequestV1JsonSchema = exact({
  ...standing, message_sid: message, organisation_id: id, team_id: id,
});
export const billingSmsStandingHoldV1JsonSchema = exact({
  id, number_id: id, allocation_id: id, state: { enum: ['active', 'retired', 'reconciliation'] },
  reserved_credits: decimal,
});
export const billingSmsStandingRetirementV1JsonSchema = exact({
  number_id: id, allocation_id: id, state: { const: 'retired' }, can_fund: { const: false },
});
export const billingSmsStandingRetireResultV1JsonSchema = {
  anyOf: [billingSmsStandingHoldV1JsonSchema, billingSmsStandingRetirementV1JsonSchema],
} as const;
export const billingSmsInboundReceiptV1JsonSchema = exact({
  message_sid: message, state: { enum: ['pending', 'funded', 'uncollected', 'reconciliation'] },
  consumed_credits: { anyOf: [decimal, { type: 'null' }] },
  uncollected_credits: { anyOf: [decimal, { type: 'null' }] },
});

const grantBinding = {
  number_id: id, allocation_id: id, delegate_id: id,
  max_segments: { type: 'integer', minimum: 1, maximum: 100 },
} as const;
export const billingSmsGrantRequestV1JsonSchema = billingSubjectActionBodySchema(
  { ...grantBinding, idempotency_key: id }, [...Object.keys(grantBinding), 'idempotency_key'],
);
export const billingSmsGrantReadRequestV1JsonSchema = exact({ product: id, grant_id: id });
export const billingSmsGrantQuoteRequestV1JsonSchema = exact({
  product: id, grant_id: id, country: scope.country, destination: phone,
});
export const billingSmsGrantV1JsonSchema = exact({
  id, ...grantBinding, state: { enum: ['active', 'revoked'] },
});
export const billingSmsGrantRevocationV1JsonSchema = exact({ grant_id: id, state: { const: 'revoked' } });
export const billingSmsGrantRevokeResultV1JsonSchema = {
  anyOf: [billingSmsGrantV1JsonSchema, billingSmsGrantRevocationV1JsonSchema],
} as const;
