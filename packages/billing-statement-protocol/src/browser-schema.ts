import { billingSubjectActionBodySchema } from './funding-schema-primitives.js';
const id = { type: 'string', minLength: 1, maxLength: 160 } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date-time' } as const;
const seconds = { type: 'integer', minimum: 60, maximum: 1800 } as const;
const decimal = { type: 'string', pattern: '^[0-9]+(?:\\.[0-9]+)?$', maxLength: 80 } as const;
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] });
function exact(properties: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  } as const;
}
export const billingBrowserTariffRequestV1JsonSchema = billingSubjectActionBodySchema({ project_id: uuid }, [
  'project_id',
]);
export const billingBrowserReserveRequestV1JsonSchema = billingSubjectActionBodySchema(
  {
    project_id: uuid,
    dispatch_id: uuid,
    max_duration_seconds: seconds,
    budget_context: nullable(
      exact({
        project_id: nullable(uuid),
        run_id: uuid,
        run_started_at: nullable(date),
        run_owner_sub: nullable(id),
        budget_run_id: nullable(uuid),
        budget_run_started_at: nullable(date),
        budget_run_owner_sub: nullable(id),
      }),
    ),
  },
  ['project_id', 'dispatch_id', 'max_duration_seconds', 'budget_context'],
);
const read = { product: id, dispatch_id: uuid };
export const billingBrowserReadRequestV1JsonSchema = exact(read);
export const billingBrowserReleaseRequestV1JsonSchema = {
  oneOf: [
    exact({ ...read, proof: { const: 'no_provider_dispatch' } }),
    exact({
      ...read,
      proof: { const: 'provider_rejected' },
      provider_http_status: { enum: [400, 401, 403, 404, 422, 429] },
    }),
  ],
};
export const billingBrowserReceiptRequestV1JsonSchema = exact({
  ...read,
  project_id: uuid,
  session_id: uuid,
  status: { enum: ['COMPLETED', 'ERROR', 'TIMED_OUT'] },
  started_at: date,
  ended_at: date,
  proxy_bytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
});
export const billingBrowserTariffV1JsonSchema = exact({
  policy_id: id,
  project_id: uuid,
  currency: { const: 'USD' },
  provider_price_per_hour: decimal,
  customer_price_per_minute: decimal,
  markup_bps: { const: 1000 },
  minimum_seconds: { const: 60 },
  rounding_seconds: { const: 60 },
  valid_until: date,
});
export const billingBrowserReservationV1JsonSchema = exact({
  reservation_id: id,
  dispatch_id: uuid,
  policy_id: id,
  state: { enum: ['reserved', 'dispatching', 'settled', 'released', 'reconciliation'] },
  can_dispatch: { type: 'boolean' },
  reserved_credits: decimal,
  consumed_credits: nullable(decimal),
  session_id: nullable(uuid),
  max_duration_seconds: seconds,
  claim_expires_at: date,
});

export const billingBrowserReleasedV1JsonSchema = exact({ dispatch_id: uuid, released: { const: true } });
