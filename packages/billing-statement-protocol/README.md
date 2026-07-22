# `@unlikeotherai/billing-statement-protocol`

Public, open-source-safe consumer contracts for UOA's display-ready
`BillingStatementV1`, `BillingStatementV2`, shared `BillingCreditsV1`, recurring
add-ons, and customer billing actions.

V1 remains frozen for existing consumers. V2 adds a complete team-wide
connected-service portfolio, already aggregated and labelled by UOA, while
retaining the same UOA-owned commercial statement. Products render either
version without calculating usage shares, customer prices, markup, totals, or
cancellation choices.

The action contract covers the normalized hosted redirect response,
cancellation selection, exact preview and `confirm_action`, confirmation
request/response, and minimal error envelope. Every object schema rejects
unknown properties. The package contains only protocol constants, TypeScript
types, JSON Schema, OpenAPI 3.1 components, and synthetic conformance fixtures.
It has no server imports, credentials, tenant data, or billing implementation.

UOA is the source of truth. The API imports this package; consumers must not
import from UOA's private `API/` source. Until registry publication is approved,
another product can vendor this complete directory or consume a tarball created
with:

```bash
pnpm --filter @unlikeotherai/billing-statement-protocol build
pnpm --filter @unlikeotherai/billing-statement-protocol pack
```

The public HTTP artifacts are:

- `/schemas/billing-statement-v1.json`
- `/schemas/billing-statement-v1.example.json`
- `/schemas/billing-statement-v1.openapi.json`
- `/schemas/billing-statement-v2.json`
- `/schemas/billing-statement-v2.example.json`
- `/schemas/billing-statement-v2.openapi.json`
- `/schemas/billing-consumer-actions-v1.json`
- `/schemas/billing-consumer-actions-v1.example.json`
- `/schemas/billing-consumer-actions-v1.openapi.json`
- `/schemas/billing-credits-v1.json`
- `/schemas/billing-credits-v1.example.json`
- `/schemas/billing-credits-v1.openapi.json`
- `/schemas/billing-recurring-addons-v1.json`
- `/schemas/billing-recurring-addons-v1.example.json`
- `/schemas/billing-recurring-addons-v1.openapi.json`

TypeScript consumers use the package root:

```ts
import {
  BILLING_STATEMENT_SCHEMA_VERSION,
  type BillingCreditsV1,
  type BillingCancellationPreviewV1,
  type BillingHostedRedirectResponse,
  type BillingRecurringAddonsV1,
  type BillingStatementV1,
  type BillingStatementV2,
  billingCreditsV1JsonSchema,
  billingCancellationPreviewV1JsonSchema,
  billingRecurringAddonProtocolV1JsonSchema,
  billingStatementV1JsonSchema,
  billingStatementV2JsonSchema,
} from '@unlikeotherai/billing-statement-protocol';
```

New consumers request `POST /billing/v2/customer-statement`. Its
`connected_service_usage` model contains display-ready totals for every
metered service in the exact team and month, the service's origin-product
shares, and per-user shares. UOA derives the requested product's rating and all
of those totals from one pinned user-grouped Ledger portfolio snapshot.
Other-service totals are explanatory only and never become line items on the
requested product's commercial statement.
Indirect use such as Nessie calling DeepWater can appear as a Nessie origin
share, but it is not direct DeepWater access and cannot create a related
cancellation option. A null legacy origin is displayed as `Unattributed
origin`; it does not create a service or cancellation option. Frozen V1 uses
the string `unattributed` only in its display-only attribution field.

Upgrade, portal, and cancellation controls continue to use the v1 action
contract. Products whitelist the supplied action ID/path pair, proxy the
server-pinned body to UOA, and render UOA's response. They do not own Stripe or
subscription state.

`BillingCreditsV1` displays the exact team's one shared cross-service balance
under the required heading `Remaining credits`. The fixed public conversion is
1,000 credits = US$1.00. Credit quantities are always whole integers. UOA keeps
sub-credit usage in its exact internal rated remainder and deducts it only when
the cumulative service/user amount reaches another complete credit. The USD
equivalent remains an exact decimal derived from the whole-credit quantity.
UOA supplies fixed top-up offers and every complete auto-top-up action. The
consumer relays the frozen action body unchanged and never chooses an offer or
option by rebuilding its subject.

`BillingCreditsV1` is an unreleased, coordinated launch contract. Its four
initial consumers must update from the earlier unpublished draft together. The
privacy-hardening shape in this package supersedes that draft before the first
release, so the protocol remains version `1.0.0`; this is not presented as a
compatible minor update to a published contract.

Both credits and recurring add-ons use manager/member discriminated unions.
Managers can receive exact-user breakdowns, payment-method display data, and
enabled commercial actions. Members receive only their own usage plus
categorical team/unattributed aggregates, payment-method status without card
identity, the shared remaining/pending credit quantities without a pending
payment amount, and no offers, prices, thresholds, caps, consent details, or
enabled money actions. Zero-activity teams may have empty usage-breakdown and
recent-entry arrays; the outer viewer-role discriminator remains authoritative
for selecting the manager or member privacy shape. Free-form labels and
descriptions must not encode another user's identity or payment-instrument
details.

Recurring add-ons support organisation, team, and subscribing-user entitlement
scopes. An organisation-scoped purchase or cancellation requires an active
organisation owner/admin; exact-team managers can act only on team or
subscribing-user scopes. DeepWater's privacy subscription is represented as an
ordinary versioned US$50/month offer, not product-local billing logic.

Run `pnpm generate` after an intentional protocol change. Build and test fail if
the committed JSON Schema, example, or OpenAPI artifact drifts from the typed
source. Breaking protocol changes require a new schema version and package
major; additive non-breaking package changes use normal semantic versioning.
