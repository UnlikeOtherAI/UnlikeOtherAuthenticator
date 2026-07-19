# Billing Tariffs and Product Entitlements

## Status and ownership

UOA is the canonical commercial control plane for tariffs. Ledger records raw
usage and booked charges; Nessie, DeepWater, DeepSignal, DeepTest, and future
products consume UOA's effective-tariff snapshots. Products and Ledger must not
maintain independent tariff tables or infer a tariff from usage.

This slice defines tariff storage, assignment, app authentication, signed
entitlement reads, and a fail-closed Stripe collection foundation. UOA can map
an exact immutable tariff version to Stripe products/prices, create a hosted
subscription Checkout, reconcile signed webhooks, and export Ledger-rated usage.
The integration is disabled by default and must not create customers, prices,
subscriptions, or meter events until its explicit production gate and every
credential/reconciliation prerequisite are configured and verified.

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
| `POST /internal/admin/billing/stripe/usage-exports` | Fetch/replay one immutable Ledger subscription-month snapshot and idempotently export its customer-money delta to Stripe |

Every mutation writes the existing global admin audit log. Tariff and credential
tables are denied to the tenant runtime database role and accessed only through
the bypass-RLS admin connection.

## Stripe collection foundation

Stripe resources are projections of UOA and Ledger truth:

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

`STRIPE_BILLING_ENABLED=false` is the process default. Provisioning Stripe
secrets without turning on that gate cannot call Stripe. Enabling the gate also
requires UOA's own dedicated Ledger app key and dedicated billing-assertion key
pair; UOA never borrows a product, user, or webhook credential to collect usage.
Every local Stripe projection is additionally bound to the exact Stripe account
ID and API-key mode that created it. Test and live projections may coexist, but
their customers, catalogs, Prices, Checkout sessions, subscriptions, webhook
event IDs, usage exports, and idempotency keys never overlap. Startup rejects a
Stripe key whose test/live mode cannot be determined.

### Checkout and subscription scope

`POST /billing/v1/stripe/checkout-session` uses the calling product's own
`X-UOA-App-Key` plus its fresh credential-bound `X-UOA-Actor`. The user must be
an active owner/admin at the selected billing scope. A team tariff override
creates a team-scoped subscription; an organisation assignment or service
default creates an organisation-scoped subscription. Return URLs must use an
exact HTTPS origin allowlisted on that individual app-key record.

An organisation-scoped Checkout or non-terminal subscription is mutually
exclusive with every team-scoped Checkout/subscription for the same Stripe
account, product, and organisation. Separate team scopes may subscribe
independently. PostgreSQL advisory locks and constraints serialize these checks
so concurrent org/team requests cannot both win.

Checkout replay is a billing-scope lease, not a permanent lock on the initiating
actor JWT ID. A fresh actor assertion for the same exact app key, tariff source,
assignment, customer, scope, and return URLs recovers the open session. If UOA
crashes after Stripe creates a session but before recording its ID, retry
searches the exact Stripe customer and UOA Checkout metadata and reattaches the
single match. A stale creating lease with no Stripe session is marked abandoned
and releases the scope. Concurrent lease creation recovers the database winner;
Stripe receives the winner's stable account/mode/Checkout idempotency key.

UOA creates one currency-specific Stripe catalog for each product, including:

* an immutable monthly Price for the exact tariff version when its monthly
  amount is non-zero;
* one metered Price for rated customer money;
* a calendar-month billing anchor aligned to Ledger's UTC month;
* no promotion codes, because discounts must be explicit UOA tariff versions.

The hosted Checkout starts the next complete UTC calendar month without
proration. Subscription webhooks are verified against the exact raw request
body with the separate `STRIPE_WEBHOOK_SECRET`, recorded idempotently, and
accepted only when the Stripe customer, product, tariff, scope, and line items
match the immutable UOA mapping.

A subscription is pinned to the exact immutable tariff version, resolved source
(`service_default`, `organisation`, or `team`), and assignment ID recorded by
Checkout until that subscription becomes terminal. UOA does not silently move a
live subscription to a newer default or override. Default changes and assignment
change/removal that would invalidate an open Checkout or live subscription fail
with `STRIPE_TARIFF_PINNED`; operators may append new tariff versions at any
time, but must end the pinned subscription before changing its effective
commercial terms. Automatic next-cycle migration is not part of this foundation.

Lifecycle events are notifications, not authoritative snapshots. UOA verifies
the signature first, resolves the exact account/mode, then retrieves the current
Checkout or Subscription from Stripe. Reordered updates cannot resurrect a
canceled subscription, and a subscription missing at Stripe deterministically
tombstones an existing local row. The current subscription must contain exactly
the UOA monthly item (quantity one, when non-zero) and exactly one metered usage
item, with no extra/duplicate items and no subscription- or item-level
discounts.

### Ledger collection and Stripe meter units

UOA calls `GET /v1/billing/usage?group_by=service` with:

```http
X-Ledger-App-Key: <UOA's dedicated Ledger billing-reader app key>
X-UOA-Service-Assertion: <short-lived RS256 service JWT>
```

The app key authenticates UOA as the calling application. The assertion
independently binds that exact key ID to `scope=billing.read`, the billed
product, organisation, optional team, and one UTC billing month. Ledger
verifies it through UOA's rotation-safe
`GET /billing/v1/service-jwks.json`; those keys are not tariff-snapshot,
OAuth-resource-token, product-app-key, or webhook keys.

Ledger's schema-v4 response is an immutable snapshot. UOA validates its exact
product, scope, calendar boundaries, tariff version, collection mode, and
currency before exporting anything. Each customer charge is an exact
major-currency decimal. UOA converts it to an integer count of
`10^-6` minor-currency units and sends only the delta since the previous
snapshot to Stripe's sum meter, using a stable idempotent event identifier.
Stripe therefore meters rated money—not tokens, searches, research runs, or
their derived billable units. Raw and customer billable usage remain in Ledger
and product UIs.

Snapshot cursors and cumulative/delta exports are stored so retries can be
replayed and audited. A lower corrected cumulative total emits a negative
delta; it does not rewrite prior raw usage.

### Launch gate

Code deployment is not permission to collect money. Production collection
remains blocked until all of the following are demonstrated:

1. distinct live Stripe API and webhook secrets are provisioned;
2. UOA has its own revocable Ledger billing-reader app key;
3. Ledger trusts only UOA's dedicated service-assertion JWKS and exact key ID;
4. per-product app keys and Checkout return origins are provisioned separately;
5. current-month polling, final pre-invoice reconciliation, webhook retries,
   negative corrections, and immutable-cursor replay are exercised in Stripe
   test mode;
6. invoices visibly reconcile UOA tariff terms and Ledger customer charges.

Stripe meter processing is asynchronous. A reviewed scheduler and
pre-finalisation reconciliation run are mandatory before enabling live
collection; a manually successful export alone is insufficient.
