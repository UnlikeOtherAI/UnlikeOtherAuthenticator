# Billing Tariffs and Product Entitlements

## Status and ownership

UOA is the canonical commercial control plane for tariffs. Ledger records raw
usage and booked charges; Nessie, DeepWater, DeepSignal, DeepTest, and future
products consume UOA's effective-tariff snapshots. Products and Ledger must not
maintain independent tariff tables or infer a tariff from usage.

This slice defines tariff storage, assignment, app authentication, signed
entitlement reads, and the immutable intent for how payment will be collected.
It deliberately does not yet create Stripe customers, subscriptions, invoices,
payment methods, or webhooks. The stored collection mode and monthly
subscription amount are commercial inputs for that later integration.

## Product and tariff model

A billing service is a product identified by a stable lowercase identifier such
as `deepwater`. Every active service has exactly one default tariff.

A tariff is an immutable version row. Its identity is the tuple
`(service, key, version)`; changing commercial terms creates the next version
instead of modifying historical terms. Assignments point to one exact version.
The `is_default` pointer may move between versions without changing their terms.

Each tariff contains:

| Field | Meaning |
|---|---|
| `mode` | `standard`, `free`, `at_cost`, or `custom` |
| `collection_mode` | `stripe`, `manual`, or `none`; independent of usage rating |
| `markup_bps` | Price markup in basis points; 2,000 means 20.00% |
| `monthly_subscription.amount_minor` | Monthly fixed charge in currency minor units; `"0"` means no monthly charge |
| `monthly_subscription.currency` | Three-letter uppercase ISO-style currency code |

Mode rules:

* `standard` and `custom` may apply a non-negative markup.
* `at_cost` fixes markup at zero and bills usage at 100% of provider cost. It may
  still include a monthly subscription.
* `free` fixes markup and monthly subscription to zero and disables usage
  billing. It always uses `collection_mode = none`.

Collection rules:

* `stripe` means the later Stripe subscription/invoice integration is expected
  to collect payment.
* `manual` means payment is expected but is collected outside the automated
  Stripe flow.
* `none` means no payment is collected. Rating and cost visibility remain
  active for any non-free tariff, so `usage_billing_enabled` can be true while
  `payment_collection_enabled` is false.
* `at_cost + none + monthly_subscription.amount_minor = "0"` is the explicit
  special plan for showing 100% provider cost with no payment.
* Pricing mode and collection mode are separate immutable tariff-version terms.
  A collection change creates a new version.

This model supports a service default plus negotiated organisation or team
terms. There is no per-user tariff override. User identity remains in the
lookup and snapshot so Ledger can attribute and aggregate usage per user inside
the selected team.

## Resolution precedence

For an active user, organisation, and team, UOA resolves exactly one tariff:

1. team assignment for the requested product;
2. organisation assignment for the requested product;
3. that product's default tariff.

The team must belong to the organisation. The user must exist and hold active
membership in both the organisation and team. A missing membership, mismatched
product credential, inactive service, or missing default fails closed.

## Raw usage, billable units, and price presentation

Raw provider usage is immutable accounting evidence. Token counts, search
requests, storage bytes, and other metered quantities must never be overwritten
or relabeled to represent markup.

The snapshot exposes one signed `usage_price_multiplier_bps`:

* `free`: `0`
* `at_cost`: `10000`
* `standard` or `custom`: `10000 + markup_bps`

Ledger applies that multiplier to the provider cost while retaining the
original usage quantities. It may also expose a separately labeled
customer-facing billable unit:

```text
customer_billable_units =
  raw_metered_units × usage_price_multiplier_bps / 10000
```

That value is a derived commercial unit, not provider output. Ledger must
calculate it with decimal-safe arithmetic and retain the exact raw-unit
numerator and denominator (or an equivalent exact decimal) so display or
invoice rounding never mutates the raw evidence. Its customer-facing label
follows the underlying meter: billable token-equivalent units for token-metered
AI, billable search-equivalent units for SERP, and billable
research-equivalent units for DeepWater. Consumer pages show immutable raw
units with their original label, separately labeled customer billable units,
and the customer-facing monetary amount. They must never present a derived unit
as provider output or relabel one meter as another.

## Individual product credentials

Every connection from an application to UOA uses that application's own billing
app key. Keys must not be shared between products or reused as a general
platform credential. Multiple independently deployed callers for one product
should receive separate named keys so they can be revoked and audited
independently.

An app key:

* starts with `uoa_app_`;
* is returned in plaintext only when created;
* is stored only as a keyed digest plus a display prefix;
* is bound to exactly one billing service;
* may expire and may be revoked immediately;
* is bound to one actor issuer, actor audience, RS256 public JWK, and `kid`.

The app key authenticates the calling product. It does not identify the user.
Each lookup therefore also carries an independently signed actor assertion.
Webhook signing secrets remain a separate credential class and must never be
used as product request API keys (or vice versa).

## Effective-tariff API

### Request

`POST /billing/v1/effective-tariff`

Headers:

```http
X-UOA-App-Key: uoa_app_<individual product key>
X-UOA-Actor: <short-lived RS256 JWT>
Content-Type: application/json
```

`Authorization: Bearer uoa_app_…` is accepted as a transport alternative to
`X-UOA-App-Key`. Callers should use only one credential header.

Body:

```json
{
  "product": "deepwater",
  "organisation_id": "org_123",
  "team_id": "team_123",
  "user_id": "user_123"
}
```

The actor JWT is credential-bound and must use:

* protected header `alg=RS256` and the app key's configured `kid`;
* exact configured `iss` and `aud`;
* `sub = user_id`;
* claims `product`, `organisation_id`, and `team_id` exactly matching the body;
* non-empty `jti`;
* integer `iat` and `exp`, with a maximum lifetime of 60 seconds.

UOA permits five seconds of clock tolerance. The app key and actor JWT are both
required; one never substitutes for the other.

### Response

Successful responses are `Cache-Control: private, no-store` and contain a
content-free business payload plus its RS256 signature:

```json
{
  "snapshot": "<uoa-tariff+jwt>",
  "payload": {
    "schema_version": 1,
    "snapshot_id": "uuid",
    "product": {
      "id": "service-id",
      "identifier": "deepwater"
    },
    "authorized_party": {
      "app_key_id": "app-key-id"
    },
    "subject": {
      "user_id": "user_123",
      "organisation_id": "org_123",
      "team_id": "team_123"
    },
    "tariff": {
      "id": "tariff-id",
      "key": "standard",
      "version": 1,
      "mode": "standard",
      "collection_mode": "stripe",
      "markup_bps": 2000,
      "markup_percent": "20.00",
      "usage_price_multiplier_bps": 12000,
      "monthly_subscription": {
        "amount_minor": "0",
        "currency": "GBP"
      },
      "usage_billing_enabled": true,
      "payment_collection_enabled": true,
      "raw_usage_preserved": true
    },
    "assignment": {
      "scope": "team",
      "id": "assignment-id"
    },
    "issued_at": "2026-07-19T00:00:00.000Z",
    "expires_at": "2026-07-19T00:05:00.000Z"
  }
}
```

`assignment.scope` is `team`, `organisation`, or `service_default`; a default
has `id: null`.

The snapshot JWT:

* has protected header `alg=RS256`, a rotation-safe `kid`, and
  `typ=uoa-tariff+jwt`;
* uses UOA's `PUBLIC_BASE_URL` as issuer;
* uses the calling credential's actor issuer as audience;
* uses the UOA user ID as subject and the snapshot ID as `jti`;
* expires after five minutes;
* contains the exact response payload plus standard JWT claims.

Consumers verify the JWT against `GET /billing/v1/jwks.json`, check algorithm,
`kid`, type, issuer, audience, expiry, subject, and schema version, then require
the signed `product.id`, `product.identifier`, `authorized_party.app_key_id`,
and all three `subject` identifiers to match the exact expected request and
credential. A snapshot for another product or app key is rejected even when
both products use the same Ledger issuer or actor-signing JWK. Consumers also
require exact agreement between the signed business payload and the duplicate
response payload; the unsigned payload is never authoritative on its own.

The JWKS route is enabled only when both
`TARIFF_SNAPSHOT_PRIVATE_JWK` and
`TARIFF_SNAPSHOT_PUBLIC_JWKS_JSON` are configured. The public set contains the
current public key and any retired keys still needed during overlap; it must
contain the exact public pair for the private key's current `kid`. UOA imports
the private key and every published public key during process startup, failing
before serving when any configured RSA material is unusable.

The payload intentionally contains no email address, person name, organisation
name, team name, usage, provider prompt, response, or research content.

## Platform-superuser administration

Tariff control-plane mutations are currently restricted to a platform
superuser authenticated through the existing `/internal/admin/*` access-token
guard. Org/team owners and admins do not receive tariff mutation access in this
slice.

| Method and path | Purpose |
|---|---|
| `GET /internal/admin/billing/services` | List services, versions, assignments, and app-key metadata |
| `POST /internal/admin/billing/services` | Create a service and its initial default tariff |
| `POST /internal/admin/billing/services/:serviceId/tariffs` | Append a tariff version; optionally make it default |
| `PUT /internal/admin/billing/services/:serviceId/default-tariff` | Move the service default pointer |
| `PUT /internal/admin/billing/services/:serviceId/assignments` | Upsert an organisation or team assignment |
| `DELETE /internal/admin/billing/services/:serviceId/assignments/:assignmentId` | Remove an override and fall back through precedence |
| `GET /internal/admin/billing/services/:serviceId/app-keys` | List credential metadata, never plaintext secrets |
| `POST /internal/admin/billing/services/:serviceId/app-keys` | Mint a product-bound key and bind its actor verification key |
| `DELETE /internal/admin/billing/services/:serviceId/app-keys/:keyId` | Revoke a product credential |

Every mutation writes the existing global admin audit log. Tariff and credential
tables are denied to the tenant runtime database role and accessed only through
the bypass-RLS admin connection.

## Stripe follow-on

The next billing phase may map exact tariff versions to Stripe Prices and create
subscriptions at organisation/team scope. That phase must preserve these rules:

* UOA remains the tariff and entitlement source of truth.
* Ledger remains the raw-usage and booked-charge source of truth.
* Stripe is a payment processor, not an identity, tariff, or usage authority.
* A booked charge records the immutable tariff version and signed snapshot used.
* Free and at-cost exceptions remain explicit tariff modes, not hidden Stripe
  discounts.
* `collection_mode` controls payment orchestration without changing rating:
  `stripe` is automated collection, `manual` is externally collected, and
  `none` collects nothing.
* Each product continues to use its own app key.
