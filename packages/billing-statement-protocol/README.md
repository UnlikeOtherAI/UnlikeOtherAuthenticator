# `@unlikeotherai/billing-statement-protocol`

Public, open-source-safe consumer contracts for UOA's display-ready
`BillingStatementV1`, `BillingStatementV2`, shared `BillingCreditsV1`, recurring
add-ons, customer billing actions, monthly billing cycles, and actual charge invoices.

Package 5.11.0 adds strict company Standard seat plan read and explicit checkout
acceptance contracts in `commercial-policy-v1.json`. Current agreement terms,
unique human count and independently effective usage terms are separate from
published prospective offers. A product relays the exact offered action; it
never assigns a tariff, multiplies a seat price into an invoice total or treats a
Checkout return as payment proof. Member reads omit all plan/usage details.
`terms_collectible` describes effective collection terms, not available credits
or a provider execution grant. Producers independently admit funded execution.

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
their immutable charge month. Each row carries `payments_in_charge_month` so an
invoice paid in several months never counts its full legal total as fresh cash
in each month. `/detail` returns the verified payment history and accepts an
optional `charge_month` to preserve the selected list context. A prepaid
payment uses its accepted payment time even if legal issuance finishes in the
next month. Each successful prepaid purchase, including every automatic
recharge, has its own invoice; reading this API never creates one.
`/detail` contains legal customer charge lines only, and `/download` returns
only verified immutable PDF bytes after fresh payer authorization. Usage and
credit consumption remain in the separate cycle/account view and are never
re-invoiced when prepaid credits are spent. A multi-product legal invoice stays
in UOA organisation finance; a single-product credential never relays its whole
PDF or other-product lines.
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
A verified manual cancellation credit note may include positive
`totals.customer_credit_due`: accepted original cash less actual refunds.
Its `gross_total` describes canceled charges, not a promise to repay that
gross amount. The field is absent when no repayment obligation is established.

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
Credit protocol 2.1.0 (package 5.5.0) keeps that status and adds top-ups in the
billing region's currency; see "Credits bought in the region currency" below.

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
`credits_consumed` and, when verified, `credits.waived`; no raw usage dimensions
or provider/service pricing keys.
Raw token counts, reasoning, cache and modality evidence remain private to
Ledger and UOA reconciliation and never enter customer JSON or downloads.
Credit budgets are a separate customer credit-only contract; their policies
and spent/held/remaining amounts never expose token units or provider costs.

Run `pnpm generate` after an intentional protocol change. Build and test fail if
the committed JSON Schema, example, or OpenAPI artifact drifts from the typed
source. Breaking protocol changes require a protocol major and package major. The
`schema_version` integer identifies the stable v1/v2 route family; each family
has an independent semantic protocol version.

# Cycle pagination

The first page may contain an open preview before persisted cycles. Its
`YYYY-MM:preview` cursor resumes at the first persisted team or organisation
cycle, including one in that same month. Persisted pages use the team or
organisation cursor and never repeat the preview.

## Localized presentation and credit purchase return (5.1.0)

Package 5.1 preserves the optional `billing_status` shape and
`x-uoa-billing-credits-protocol: 2.0.0` capability already consumed by Nessie.
Presentation negotiation is independent of that reconciliation capability.
This additive contract integration changes no reconciliation, tariff, seat or
storage implementation; the source that owns reconciliation continues to own
when that optional status is returned.

Consumers opt in with `x-uoa-billing-presentation: 1.5.0` and may select
`x-uoa-billing-locale: cs|en-US|en-GB|de|es|fr|it`. Requests without presentation
negotiation retain English display and the original strict redirect envelope.
Unsupported versions or locales fail with 400. Locale changes display only:
the actor subject, amounts and frozen action request bodies remain unchanged.
All customer responses remain `private, no-store`.

A negotiated credit top-up redirect may also carry `purchase_id`, an opaque
reference to the exact existing checkout, including a resumed checkout. Keep it
only in the person's API/organisation/team scope. POST the normal billing subject
and this id to `/billing/v1/credits/purchase-status` using a fresh assertion for
that exact endpoint. The read rechecks current billing-manager authority and exact
account, team, storefront and app-key scope. It returns display-ready title and
message, `state`, and `awaiting_confirmation`. Only the committed credit entry
can yield `succeeded`; an open browser, success URL or Stripe intent alone cannot.
Poll only while confirmation is pending, with a finite limit and an explicit
retry. When Stripe still reports the exact bound Checkout open, the response may
include `continuation` with the same `purchase_id` and its bounded hosted URL.
Opening that redirect resumes the same Checkout. Reading a status never creates
a payment or restarts the person's work.

The purchase status schema is exported as
`./schema/billing-credit-purchase-status-v1.json` and included in the credits
OpenAPI document. Non-credit redirects retain their existing response shape.

Negotiated credits may include `attention`: stable opaque event keys and safe
reason enums, without amounts or card details. Consumers reconcile these facts
into their existing team-scoped alerts and keep the person's read state.
`funding_request` is an optional source-authorized action for a member who
cannot fund the account. Its frozen body contains only the existing subject.
The source rechecks live authority on POST and returns an opaque daily request
ID plus authorized recipient IDs to the product server. The consumer maps only
active identities and selected-team memberships, deduplicates delivery by the
request ID and reports whether an alert was actually delivered. The result
contains no promise of delivery and must never expose recipient IDs to a browser.
The response schema is `./schema/billing-credit-funding-request-v1.json`.

The 5.0 customer privacy boundary remains unchanged: localized statements never
restore token counts, provider costs, markup, tariff identifiers or raw portfolios.
Localized credits retain all six decimal places and subtract active reservations
from the available balance before projecting attention.


Customer display integration also covers cycle and invoice list/detail reads via
presentation 1.5.0 locale negotiation. Generated cycle subscription/usage labels,
prepaid purchase labels and credit-note cancellation labels use structural source
facts. Exact money displays preserve every decimal digit without converting
financial values to floating point. Read-time display projection occurs after
source integrity validation; stored snapshot hashes, rating, line identities,
PDFs and CSVs are unchanged. Authored plan/service names, Stripe invoice line
labels and stored adjustment reasons remain verbatim because their persisted
contract does not distinguish generated copy from operator text.

## Mobile-number subscriptions and prepaid SMS (5.2.0)

The independent SMS v1 protocol exports exact request/result schemas and the
`schema/billing-sms-v1.json` and `openapi/billing-sms-v1.openapi.json` artifacts.
Only final customer prices cross the public boundary. SMS prices are maxima per
segment; final verified usage can be lower. Monthly exact-number payment belongs
to the organisation. SMS reservations and standing incoming-text funds belong
to the original exact team and allocation. Runtime recovery uses the separately
scoped SMS_RUNTIME credential; lifecycle consent and entitlement keys remain
separate. Missing resource/grant/dispatch/standing retirement proof is explicitly
typed and fenced, never inferred from a generic HTTP status. Unknown provider
outcomes remain held and uncovered incoming charges remain uncollected liability.

## Organisation billing region (5.3.0)

`BillingRegionViewV1` (`billingRegionViewV1JsonSchema`) is the
`billing_region` block of `POST /billing/v1/organisation-billing` and the
response of `POST /billing/v1/organisation-billing/region`
(`BILLING_ORG_REGION_PATH`, body `billingRegionSetRequestV1JsonSchema`: the
subject fields plus `region`). A region (`UK`, `US`, `EUROPE`) is chosen once by
an organisation owner or admin and never changes; it sets the SMS currency
(`GBP`, `USD`, `EUR`). `region` and `currency` are null until chosen;
`suggested_region` prefills the choice; `can_set` says whether this caller may
choose now. A different second choice answers `BILLING_REGION_IMMUTABLE`; SMS
pricing, purchase and top-up answer `BILLING_REGION_REQUIRED` until chosen. AI
usage stays USD in every region.

### Where the suggestion came from (5.6.0, region protocol 1.1.0)

A consumer that sends `x-uoa-billing-region-protocol: 1.1.0`
(`BILLING_REGION_PROTOCOL_HEADER`, `BILLING_REGION_PROTOCOL_VERSION`) on either
endpoint also receives `suggested_from`: `billing_country` when
`suggested_region` came from the organisation's invoice-profile billing country
(any country, US included), or `null` when no billing country is known and the
suggestion is the US default. Render a real country's suggestion as a
prefill and the default as no preference; never infer either from
`suggested_region`. Without the header the view keeps its 1.0.0 fields.

## Region-currency quotes (5.4.0, SMS protocol 1.1.0)

`BillingSmsFinalQuoteV1.currency` is `USD`, `EUR` or `GBP`. A monthly
mobile-number quote is UOA's flat monthly price for the organisation's billing
region currency (EUR 4.99, GBP 4.49, USD 5.49 at release), the same in every
country, and its monthly subscription is charged in that currency. Until the
region is chosen the quote answers `BILLING_REGION_REQUIRED`. Message quotes stay
USD in 5.4.0. Products render the currency the quote carries and never assume USD.

## Credits bought in the region currency (5.5.0, credits protocol 2.1.0)

Credits stay one USD-denominated unit: 1,000 credits per USD, and every balance,
charge and entry is in credits. An organisation whose billing region is UK or
Europe buys them in GBP or EUR. A consumer that sends
`x-uoa-billing-credits-protocol: 2.1.0` receives the one-time offers in the
region's currency (USD until a region is chosen); an older consumer keeps seeing
the USD offers, which stay purchasable.

- `payment_amount` on an offer and on `pending_credits` is `USD`, `EUR` or `GBP`
  (`BillingCreditPurchaseCurrency`).
- A GBP or EUR offer carries `credit_rate` (`BillingCreditPurchaseRateV1`): USD
  per unit, its source (`stripe` by default, `ecb` when the deployment selects
  it) and a display line. `credits_received` is what today's rate buys; the exact
  credits are fixed when the checkout is created and granted unchanged when the
  payment succeeds. The credits equal the payment times Stripe's base rate,
  rounded down to whole credits, with no buffer and no FX fee taken.
- When no rate can be read the GBP or EUR offers are left out and the funding
  description says so; a checkout answers `503 BILLING_CREDIT_FX_RATE_UNAVAILABLE`.
  UOA never switches rate source on its own.
- Automatic top-up stays USD in 5.5.0; see 5.7.0.

## Reload in the region currency (5.7.0, credits protocol 2.2.0)

A consumer that sends `x-uoa-billing-credits-protocol: 2.2.0` also receives the
automatic reload options in the billing region's currency: one per refill
amount (10, 25, 50, 100 and 1,000), each reloading when the balance is worth
less than a fifth of its refill, up to four reloads a month. 2.2.0 includes
everything in 2.1.0 and 2.0.0.

- A GBP or EUR option carries `threshold_value` (its threshold in its
  currency), `credit_rate`, and `refill_payment_amount` and `monthly_cap` in its
  currency. `threshold` and `refill_credits_received` are what today's rate
  makes of them. While no rate can be read those options are left out.
- `automatic_top_up` carries `threshold_value`, `monthly_cap`,
  `charged_this_month` and `remaining_monthly_cap` in the consented option's
  currency.
- The balance is compared with the threshold as a value: each credit lot at the
  rate it was bought at, credits bought in USD at the rate the region captured
  when it was chosen. Each reload reads the live rate as it is claimed, just
  before its off-session PaymentIntent, and its credits are fixed then.
- A failed reload pauses automatic top-up (`needs_review`) with one
  `payment_action_required` attention item until the card is updated; there is
  no retry.


## Credits valued in the region currency (5.8.0, credits protocol 2.3.0)

A consumer that sends `x-uoa-billing-credits-protocol: 2.3.0` also receives
what credits are worth in the billing region's currency. Charges stay in
credits; these are display values. 2.3.0 includes everything in 2.2.0.

- `credit_balance.value` is the available balance in the region currency, with
  a `label` such as "€42.18 left" (or "€1.20 owed" for debt, where the amount is
  negative). Each credit lot counts at the rate it was bought at, so the value
  never moves with exchange rates. Credits bought in USD before the region was
  chosen count at the rate captured when it was chosen. It is null while that
  rate is needed but not known yet. A US region (or none) sees dollars.
- Each `recent_entries` item carries `value` as a positive amount; `direction`
  gives the sign. A purchase is worth what was paid for it (credits bought in
  USD in a GBP or EUR region, their credits at the captured rate). Any other
  entry is what it drew from (or gave back to) each lot, summed, so a debit that
  spans two lots is the sum of its two parts. It is null for history from
  before lots.
- `region_rate` {currency, usd_per_unit, credits_per_unit, source, as_of,
  display} is the rate the next credits used are valued at, for showing an
  estimate such as "≈ €0.04" beside a price in credits. `source` is `purchase`
  (the oldest remaining credits' purchase rate), `region` (the captured region
  rate, for credits bought in USD and for debt) or `usd`. It is null while the
  rate is not known.
## Product commercial standing (5.10.2)

The additive `commercial-types`, `commercial-schema` and synthetic member fixture
define product entitlement reads, company storage admission/observations and
commercial notification events. A member projection contains functional access
only; private standing and payment recovery are restricted to manager/background
branches. Require exact product/company and returned human subject binding.
`valid_until` bounds in-memory reuse and is never durable subscription authority.
This protocol addition alone does not enable storage collection or create consent.

Manager storage reads include `payment_recoveries` independently of pending
capacity expansion. Every unresolved storage invoice carries its explicit
currency, gross amount, exact recovery URL when open and own grace deadline.
Pending expansion invoices also expose `invoice_currency`. Strict consumers
must adopt these required fields before producer rollout. Member storage reads
exclude all payment and mandate data.

`StorageMandateResultV1` and `StorageRecoveryResultV1` export exact scoped
mutation results and their JSON schemas. Only an `open` mandate result contains
a Stripe Checkout URL and expiry; accepted/processing/expired/revoked results
do not redirect. Re-read current storage management after recovery completes.
