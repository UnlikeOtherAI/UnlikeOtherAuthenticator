# `@unlikeotherai/billing-statement-protocol`

Public, open-source-safe consumer contracts for UOA's display-ready
`BillingStatementV1`, `BillingStatementV2`, shared `BillingCreditsV1`, recurring
add-ons, customer billing actions, and monthly billing cycles.

Package 4.0.0 removes the public pinned tariff identity and adds the version 2
monthly cycle contract. The v1 and v2 statement route
names remain, but both statement schemas omit raw provider cost, markup,
cost-basis mode, multipliers and derived billable units. V2 adds a team-wide
connected-service portfolio of raw usage and attribution shares. Products
render UOA-authored customer charges, subscription prices and credit balances
without calculating prices, totals or cancellation choices. Strict consumers
must update their validators and field mappings before the producer deploys.
`plan.monthly_subscription.amount_role` distinguishes a flat monthly total
from a per-seat monthly unit price. `charge_basis`, seat policy/timing, and
`usage_payment_mode` are customer plan facts; a seat unit amount is never an
invoice total without a frozen seat quantity and billing period.

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
- `/schemas/billing-cycles-v2.json`
- `/schemas/billing-cycles-v2.example.json`
- `/schemas/billing-cycles-v2.openapi.json`

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
  type BillingCycleDetailV2,
  billingCycleDetailV2JsonSchema,
  billingCreditsV1JsonSchema,
  billingCancellationPreviewV1JsonSchema,
  billingRecurringAddonProtocolV1JsonSchema,
  billingStatementV1JsonSchema,
  billingStatementV2JsonSchema,
} from '@unlikeotherai/billing-statement-protocol';
```

`POST /billing/v1/cycles/list` returns product-scoped monthly summaries for the
selected team, plus organisation-wide subscription cycles to verified
organisation billing managers. `scope.cycle_scope` identifies which kind;
`scope.payer_scope` separately identifies who pays. An organisation-paid team
cycle still contains only the selected team's measured usage. A nullable
`scope.team_id` denotes only the organisation-wide subscription cycle, never
a wildcard over other teams. The cursor includes both month and cycle scope
so both rows in one month remain reachable.
`POST /billing/v1/cycles/detail` returns frozen subscription seat evidence,
measured usage, credit movements, actual payment documents, and explicit later
adjustments. Available documents carry exact server-authored POST actions for
`/billing/v1/cycles/download`; clients relay them unchanged. An open preview
never has a final invoice download. Consumed prepaid credits reduce outstanding
usage liability and do not create a second payment invoice. Public payloads
contain customer charges and seat prices, never provider cost or markup.

New consumers request `POST /billing/v2/customer-statement`. Its
`connected_service_usage` model contains display-ready totals for every
metered service in the exact team and month, the service's origin-product
shares, and per-user shares. UOA derives the requested product's rating and all
of those totals from one pinned user-grouped Ledger portfolio snapshot.
Other-service raw usage totals are explanatory only and never become line items on the
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
1,000 credits = US$1.00. Credit quantities retain up to six fractional digits (microcredits), and the
USD equivalent retains up to nine fractional digits. UOA deducts the exact
settled microcredit amount. Display currency can round to cents while machine
amounts remain exact.
UOA supplies fixed top-up offers and every complete auto-top-up action. The
consumer relays the frozen action body unchanged and never chooses an offer or
option by rebuilding its subject.

Credit protocol 2.0.0 callers opt in to UOA's reconciliation status with
`x-uoa-billing-credits-protocol: 2.0.0`. Older consumers receive the legacy
shape and a reconciliation hold until they negotiate the status revision.

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

`controlled_by` (1.3.0, optional, statement v1/v2 and credits) says that an
organisation has taken billing over from its teams. UOA composes it: render
`message` verbatim, and offer the single action named by `manage_action_id`
only when `can_manage` is true — a UOA verdict about the exact caller, never a
role the session or browser claims. While the block is present, a caller who
cannot manage receives an empty action list and no funding controls at all, so
a consumer still on 1.2.0 renders a read-only surface rather than controls that
would 403.

`organisation_scope` (1.3.0, optional, statement v2) is the organisation
roll-up an organisation billing manager receives: every team, each with its own
pinned `metering-portfolio-v1` snapshot, and organisation totals that are the
sum of the team totals. It sits beside the requested team's own fields and
never replaces them, so a consumer that predates it cannot read
organisation-wide numbers as if they were the team's.

The consumer-action contract also publishes the checkout-session and
portal-session request and response envelopes (1.3.0). The bodies still come
from UOA inside a statement action's `request.body`; publishing their shape
lets a product validate what it relays and what it receives, instead of
hand-writing a parallel schema.

Run `pnpm generate` after an intentional protocol change. Build and test fail if
the committed JSON Schema, example, or OpenAPI artifact drifts from the typed
source. Breaking protocol changes require a new schema version and package
major; additive non-breaking package changes use normal semantic versioning.
