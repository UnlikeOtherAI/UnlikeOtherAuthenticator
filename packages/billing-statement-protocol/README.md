# `@unlikeotherai/billing-statement-protocol`

Public, open-source-safe consumer contracts for UOA's display-ready
`BillingStatementV1`, `BillingStatementV2`, shared `BillingCreditsV1`, recurring
add-ons, customer billing actions, monthly billing cycles, and actual charge invoices.

Package 5.0.0 exposes customer charges, exact consumed credits, and monthly
subscription/seat terms. Statement V1/V2 and cycle responses omit raw token,
request, cache, reasoning, modality and provider-cost dimensions. Those facts
remain private UOA/Ledger rating and reconciliation evidence. V2 no longer
exports a connected-service raw usage portfolio. Products render UOA-authored
balances and charges without calculating prices or usage units. Strict
consumers must update validators and field mappings before producer rollout.
`plan.monthly_subscription.amount_role` distinguishes a flat monthly total
from a per-seat monthly unit price; a unit price is never an invoice total
without a frozen seat quantity and billing period.

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
- `/schemas/billing-customer-invoices-v1.json`
- `/schemas/billing-customer-invoices-v1.example.json`
- `/schemas/billing-customer-invoices-v1.openapi.json`

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
cycle still contains only the selected team's customer charges and consumed credits. A nullable
`scope.team_id` denotes only the organisation-wide subscription cycle, never
a wildcard over other teams. The cursor includes both month and cycle scope
so both rows in one month remain reachable.
`POST /billing/v1/cycles/detail` returns frozen subscription seat evidence,
customer usage charges, consumed credits, actual payment documents, and explicit later
adjustments. Available documents carry exact server-authored POST actions for
`/billing/v1/cycles/download`; clients relay them unchanged. An open preview
never has a final invoice download. Consumed prepaid credits reduce outstanding
usage liability and do not create a second payment invoice. Public payloads
contain customer charges and seat prices, never provider cost or markup.

`POST /billing/v1/invoices/list` groups accepted charges and actual issued documents by
their immutable charge month. A prepaid payment uses its accepted payment time
even if legal issuance finishes in the next month. Each successful prepaid purchase, including every
automatic recharge, has its own invoice; reading this API never creates one.
`/detail` contains legal customer charge lines only, and `/download` returns
only verified immutable PDF bytes after fresh payer authorization. Usage and
credit consumption remain in the separate cycle/account view and are never
re-invoiced when prepaid credits are spent. A multi-product legal invoice is
available only to a current organisation billing manager.
An accepted payment awaiting legal issuer or tax evidence appears as
`pending_document`: the actual charged amount and purchased credits remain
visible, while number, issuance time, tax, and PDF download are unavailable.
Invoice totals use positive deductions: gross less credits applied and voided
amount equals due; due less actual paid and written-off amounts equals
outstanding. The original legal PDF and charge lines stay immutable after a
void or later payment event.
Refunds and disputes are positive, separately named verified effects; the
original accepted payment and legal PDF remain visible. A partial effect has
its own status and never becomes an invented legal credit note.

New consumers request `POST /billing/v2/customer-statement`. Its
`usage.lines` and `usage.user_totals` contain customer charges only, rated by
UOA from a pinned private Ledger portfolio. The public statement does not
expose raw usage units, call counts, provider costs, or attribution shares.
Organisation roll-ups retain per-team monetary totals only for an authorised
organisation billing manager.

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
portal-session request and response envelopes. The bodies come from UOA inside
a statement action's `request.body`. For a fixed-seat plan only, the product
adds the customer's explicitly selected `fixed_seat_quantity` (integer 1 to
1,000,000) before relaying checkout. UOA checks whether that field is required
for the plan. All other body fields remain UOA-authored.

Customer cycles show subscription seats, rated usage charges and credits.
An actual invoice void appends a `voided` cycle with zero current liability;
the earlier issued invoice and its original PDF remain immutable history.
`usage_lines` contain `id`, customer-facing `label`, `customer_charge`, and
`credits_consumed`; no raw usage dimensions or provider/service pricing keys.
Raw token counts, reasoning, cache and modality evidence remain private to
Ledger and UOA reconciliation and never enter customer JSON or downloads.
Credit budgets are a separate customer credit-only contract; their policies
and spent/held/remaining amounts never expose token units or provider costs.

Run `pnpm generate` after an intentional protocol change. Build and test fail if
the committed JSON Schema, example, or OpenAPI artifact drifts from the typed
source. Breaking protocol changes require a protocol major and package major. The
`schema_version` integer identifies the stable v1/v2 route family; each family
has an independent semantic protocol version.
