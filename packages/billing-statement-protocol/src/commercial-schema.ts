const id = { type: 'string', minLength: 1, maxLength: 256 } as const;
const bytes = { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;
const nullableDate = { anyOf: [timestamp, { type: 'null' }] } as const;
const boolean = { type: 'boolean' } as const;
const nullableBytes = { anyOf: [bytes, { type: 'null' }] } as const;
const subject = { product: id, organisation_id: id } as const;
function object(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return { type: 'object', additionalProperties: false, required, properties } as const;
}
const dunning = { anyOf: [{ type: 'null' }, object({
  incident_id: id, category: { enum: ['seat', 'storage'] }, failed_at: timestamp,
  grace_ends_at: timestamp, billing_timezone: id,
})] } as const;
const entitlement = {
  ...subject, schema_version: { const: 1 },
  subject: { anyOf: [object({ team_id: id, user_id: id }), { type: 'null' }] },
  access: { enum: ['full', 'limited'] },
  full_access: boolean, history_window_days: { enum: [14, null] }, trial_ends_at: nullableDate,
  seats: object({ policy: { enum: ['free', 'automatic', 'fixed'] },
    capacity: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    admitted: boolean, can_admit_members: boolean }),
  storage: object({ capacity_bytes: bytes, used_bytes: nullableBytes, observed_at: nullableDate,
    can_upload: boolean, expansion_setup_required: boolean }),
  observed_at: timestamp, valid_until: timestamp,
} as const;
const commercial = { dunning,
  standing: { enum: ['free', 'trial', 'subscribed', 'private_at_cost', 'grace', 'restricted'] },
  platform_fees_waived: boolean, third_party_costs_payable: { const: true } } as const;
export const productEntitlementV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://authentication.unlikeotherai.com/schemas/product-entitlement-v1.json',
  oneOf: [object({ ...entitlement, viewer: { const: 'member' }, subject: object({ team_id: id, user_id: id }) }),
    object({ ...entitlement, ...commercial, viewer: { const: 'manager' }, subject: object({ team_id: id, user_id: id }) }),
    object({ ...entitlement, ...commercial, viewer: { const: 'background' } })],
} as const;
export const storageEnsureRequestV1JsonSchema = object({ ...subject, operation_id: id,
  minimum_capacity_bytes: bytes });
export const storageEnsureV1JsonSchema = object({ ...subject, schema_version: { const: 1 },
  operation_id: id, state: { enum: ['admitted', 'setup_required', 'payment_pending',
    'restricted', 'reconciliation_required'] }, capacity_bytes: bytes,
  required_blocks: { type: 'integer', minimum: 0 }, grace_ends_at: nullableDate });
export const storageObservationRequestV1JsonSchema = object({ ...subject,
  observation_id: id, revision: bytes, observed_at: timestamp, measurement_version: id, blob_bytes: bytes,
  database_bytes: bytes });
export const commercialEventsV1JsonSchema = object({ schema_version: { const: 1 },
  events: { type: 'array', maxItems: 100, items: object({ ...subject, event_id: id,
    incident_id: id, category: { enum: ['seat', 'storage', 'phone', 'addon'] },
    stage: { enum: ['initial', 'reminder', 'final_warning', 'restricted', 'resolved', 'release_due'] },
    failed_at: timestamp, grace_ends_at: timestamp, occurred_at: timestamp,
    recipient_user_ids: { type: 'array', items: id, uniqueItems: true },
    channels: { type: 'array', items: { enum: ['alert', 'personal_assistant', 'email'] }, uniqueItems: true },
    resource_id: { anyOf: [id, { type: 'null' }] },
  }) } });
export const commercialAcknowledgementV1JsonSchema = object({ ...subject, event_id: id,
  recipient_user_id: id, channel: { enum: ['alert', 'personal_assistant'] }, receipt_id: id });
export const phoneReleaseRequestV1JsonSchema = object({ ...subject, incident_id: id });
export const phoneReleaseVerdictV1JsonSchema = object({ ...subject, schema_version: { const: 1 },
  incident_id: id, authorized: boolean, resource_id: id,
  account_sid: { anyOf: [{ type: 'string', pattern: '^AC[0-9a-fA-F]{32}$' }, { type: 'null' }] },
  phone_number_sid: { anyOf: [{ type: 'string', pattern: '^PN[0-9a-fA-F]{32}$' }, { type: 'null' }] },
  valid_until: timestamp });
export const commercialProtocolV1JsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://authentication.unlikeotherai.com/schemas/commercial-policy-v1.json',
  $defs: { entitlement: productEntitlementV1JsonSchema, ensure_request: storageEnsureRequestV1JsonSchema,
    ensure_response: storageEnsureV1JsonSchema, observation_request: storageObservationRequestV1JsonSchema,
    events: commercialEventsV1JsonSchema, acknowledgement: commercialAcknowledgementV1JsonSchema,
    phone_release_request: phoneReleaseRequestV1JsonSchema, phone_release_response: phoneReleaseVerdictV1JsonSchema },
} as const;
