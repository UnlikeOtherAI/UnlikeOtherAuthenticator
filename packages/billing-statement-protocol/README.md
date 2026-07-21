# `@unlikeotherai/billing-statement-protocol`

Public, open-source-safe consumer contracts for UOA's display-ready
`BillingStatementV1`, `BillingStatementV2`, and customer billing actions.

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

TypeScript consumers use the package root:

```ts
import {
  BILLING_STATEMENT_SCHEMA_VERSION,
  type BillingCancellationPreviewV1,
  type BillingHostedRedirectResponse,
  type BillingStatementV1,
  type BillingStatementV2,
  billingCancellationPreviewV1JsonSchema,
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

Run `pnpm generate` after an intentional protocol change. Build and test fail if
the committed JSON Schema, example, or OpenAPI artifact drifts from the typed
source. Breaking protocol changes require a new schema version and package
major; additive non-breaking package changes use normal semantic versioning.
