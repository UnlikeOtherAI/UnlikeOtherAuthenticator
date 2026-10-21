import { billingSubjectActionBodySchema } from './funding-schema-primitives.js';
const id = { type: 'string', minLength: 1, maxLength: 160 } as const;
const phone = { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' } as const;
const call = { type: 'string', pattern: '^CA[a-fA-F0-9]{32}$' } as const;
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
const seconds = { type: 'integer', minimum: 1, maximum: 14400 } as const;
const decimal = { type: 'string', pattern: '^[0-9]+(?:\\.[0-9]+)?$', maxLength: 80 } as const;
function exact(properties: Record<string, unknown>) {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } as const;
}
const grant = {
  number_id: id, allocation_id: id, delegate_id: id, direction: { enum: ['inbound', 'outbound'] },
  purpose: { enum: ['agent_call', 'human_transfer'] }, max_duration_seconds: seconds,
  max_concurrent_calls: { type: 'integer', minimum: 1, maximum: 20 },
  destinations: { type: 'array', items: phone, uniqueItems: true, maxItems: 100 },
};
export const billingVoiceGrantRequestV1JsonSchema = billingSubjectActionBodySchema(
  { ...grant, idempotency_key: id }, [...Object.keys(grant), 'idempotency_key']);
export const billingVoiceGrantV1JsonSchema = exact({ ...grant, id, state: { enum: ['active', 'revoked'] },
  billing_origin: nullable(exact({ subject: id, token_version: { type: 'integer', minimum: 0 },
    organisation_id: id, team_id: id, expires_at: { type: 'string', format: 'date-time' } })) });
const grantRead = { product: id, grant_id: id };
export const billingVoiceGrantReadRequestV1JsonSchema = exact(grantRead);
const quote = { ...grantRead, delegate_id: id, from: phone, to: phone, max_duration_seconds: seconds };
export const billingVoiceQuoteRequestV1JsonSchema = { ...exact(quote), properties: { ...quote, media_stream: { type: 'boolean' } } };
const streamTariff = exact({ currency: { const: 'USD' }, price_per_minute: decimal,
  customer_price_per_minute: decimal, rounding_seconds: { const: 60 }, max_streams: { const: 1 },
  disclosure_version: id, basis: { const: 'nessie_duration_rounded_minute' } });
export const billingVoiceQuoteV1JsonSchema = exact({ id, grant_id: id, from: phone, to: phone,
  direction: grant.direction, max_duration_seconds: seconds, reserved_credits: decimal,
  expires_at: { type: 'string', format: 'date-time' }, stream_tariff: nullable(streamTariff) });
const read = { product: id, dispatch_id: id };
const claim = { ...read, request_fingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' } };
const reserveSchema = exact({ ...quote, ...claim, quote_id: id,
  conversation_id: id, leg_id: id, call_sid: nullable(call), parent_reservation_id: nullable(id) });
export const billingVoiceReserveRequestV1JsonSchema = { ...reserveSchema,
  properties: { ...reserveSchema.properties, media_stream: { type: 'boolean' }, stream_disclosure_version: id } };
export const billingVoiceReadRequestV1JsonSchema = exact(read);
export const billingVoiceClaimRequestV1JsonSchema = exact(claim);
export const billingVoiceReceiptRequestV1JsonSchema = exact({ ...claim, call_sid: call });
export const billingVoiceReleaseRequestV1JsonSchema = exact({ ...claim,
  proof: { const: 'no_provider_dispatch' }, dispatch_token: nullable(id) });
export const billingVoiceReservationV1JsonSchema = exact({ reservation_id: id, dispatch_id: id,
  state: { enum: ['reserved', 'dispatching', 'uncertain', 'settled', 'released', 'reconciliation'] },
  dispatch_token: nullable(id), reserved_credits: decimal, consumed_credits: nullable(decimal),
  call_sid: nullable(call), max_duration_seconds: seconds, claim_expires_at: { type: 'string', format: 'date-time' } });

export const billingVoiceStreamRequestV1JsonSchema = exact({ ...claim, call_sid: call,
  stream_sid: { type: 'string', pattern: '^MZ[a-fA-F0-9]{32}$' }, event: { enum: ['start', 'stop'] },
  started_at: { type: 'string', format: 'date-time' }, stopped_at: nullable({ type: 'string', format: 'date-time' }) });
export const billingVoiceStreamReconciliationRequestV1JsonSchema = exact({ product: id,
  account_sid: { type: 'string', pattern: '^AC[a-fA-F0-9]{32}$' },
  billing_month: { type: 'string', pattern: '^20[0-9]{2}-(0[1-9]|1[0-2])$' },
  invoice: nullable(exact({ id, amount_usd: decimal, reference: id })) });
export const billingVoiceStreamReconciliationV1JsonSchema = exact({ account_sid: id, billing_month: id,
  fixed_stream_amount_usd: decimal, pending_streams: { type: 'integer', minimum: 0 },
  invoice_amount_usd: nullable(decimal), invoice_reference: nullable(id),
  difference_usd: nullable({ type: 'string', pattern: '^-?[0-9]+(?:\\.[0-9]+)?$' }),
  status: { enum: ['awaiting_invoice', 'pending_calls', 'matched', 'difference'] }, invoice_source: { const: 'operator_reported' } });
