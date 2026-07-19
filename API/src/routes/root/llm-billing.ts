export const llmBillingMarkdown = `## Canonical tariff and entitlement control plane

Tariffs live in UOA. Ledger and product backends consume signed, content-free effective
tariff snapshots; they do not maintain independent tariff truth.

### Commercial semantics

- Precedence is deterministic: **team assignment → organisation assignment → service default**.
- Tariff versions are immutable. A new revision appends a version; changing a default or
  assignment changes only the pointer used for later snapshots.
- Modes are \`standard\`, \`free\`, \`at_cost\`, and \`custom\`.
- \`markup_bps\` is a price adjustment: 2,000 bps means 20.00%. \`free\` has a usage-price
  multiplier of 0; \`at_cost\` has 10,000; \`standard\`/\`custom\` have
  \`10,000 + markup_bps\`.
- The optional monthly component is an exact integer minor-unit string plus ISO currency.
  A \`free\` tariff has zero markup and zero monthly amount. An \`at_cost\` tariff may have a
  separate monthly subscription, but its usage component remains provider cost.
- **Raw token, request, byte, and search counts are never multiplied or rewritten.** Ledger
  keeps immutable raw usage, applies \`usage_price_multiplier_bps\` only when rating money,
  and labels customer-facing billable value separately.

### Dedicated product app keys

A platform superuser creates one UOA app key per consuming product/environment at:

\`POST /internal/admin/billing/services/:serviceId/app-keys\`

The request binds the opaque \`uoa_app_…\` key to exactly one product and one RS256 actor
public JWK, issuer, and audience. The plaintext key is returned once; UOA stores only a
peppered HMAC digest. The same Ledger signing JWK may be bound to multiple credentials,
but Nessie, DeepWater, DeepSignal, and DeepTest must keep distinct app secrets so every
connection is independently revocable and attributable.

### Resolve an effective tariff

\`POST /billing/v1/effective-tariff\`

Headers:

- \`X-UOA-App-Key: uoa_app_…\`
- \`X-UOA-Actor: <RS256 JWT>\`

Body:

\`\`\`json
{
  "product": "deepwater",
  "organisation_id": "org_123",
  "team_id": "team_123",
  "user_id": "usr_123"
}
\`\`\`

The actor JWT has \`iss\`/\`aud\` exactly equal to the credential binding,
\`sub=user_id\`, and matching \`product\`, \`organisation_id\`, and \`team_id\`, plus
non-empty \`jti\` and \`iat\`/\`exp\` no more than 60 seconds apart. UOA verifies the
signature and re-resolves the ACTIVE org and team memberships before returning anything.

The response is \`{ snapshot, payload }\`. \`snapshot\` is an RS256 JWT with
\`typ=uoa-tariff+jwt\`, \`iss=PUBLIC_BASE_URL\`, \`aud=actor_issuer\`, and a five-minute
expiry. Its business claims mirror \`payload\`:

\`\`\`json
{
  "schema_version": 1,
  "snapshot_id": "uuid",
  "product": { "id": "svc_123", "identifier": "deepwater" },
  "subject": {
    "user_id": "usr_123",
    "organisation_id": "org_123",
    "team_id": "team_123"
  },
  "tariff": {
    "id": "tariff_123",
    "key": "standard",
    "version": 2,
    "mode": "standard",
    "markup_bps": 2000,
    "markup_percent": "20.00",
    "usage_price_multiplier_bps": 12000,
    "monthly_subscription": { "amount_minor": "2000", "currency": "USD" },
    "usage_billing_enabled": true,
    "raw_usage_preserved": true
  },
  "assignment": { "scope": "team", "id": "assignment_123" },
  "issued_at": "2026-07-19T00:00:00.000Z",
  "expires_at": "2026-07-19T00:05:00.000Z"
}
\`\`\`

Verify the JWT through \`GET /billing/v1/jwks.json\`, including algorithm, \`kid\`,
issuer, audience, type, expiry, subject, and exact business-claim agreement with the
returned payload. Never accept the unsigned payload on its own.

All tariff catalog/default/assignment/key mutations are platform-superuser-only and are
written to the UOA admin audit log. See [/api](/api) for exact mutation contracts.

---
`;
