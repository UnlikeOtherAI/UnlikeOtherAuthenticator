export const llmBillingMarkdown = `## Canonical tariff and entitlement control plane

Tariffs live in UOA. Ledger and product backends consume signed, content-free effective
tariff snapshots; they do not maintain independent tariff truth.

### Commercial semantics

- Precedence is deterministic: **team assignment → organisation assignment → service default**.
- Tariff versions are immutable. A new revision appends a version; changing a default or
  assignment changes only the pointer used for later snapshots.
- Modes are \`standard\`, \`free\`, \`at_cost\`, and \`custom\`.
- Payment collection is an independent immutable tariff term:
  \`collection_mode=stripe|manual|none\`. \`none\` keeps usage rating and cost
  visibility while explicitly collecting no payment. \`free\` always requires
  \`none\`; \`at_cost + none + monthly amount 0\` is the canonical
  "provider cost visible, no payment" plan.
- \`markup_bps\` is a price adjustment: 2,000 bps means 20.00%. \`free\` has a usage-price
  multiplier of 0; \`at_cost\` has 10,000; \`standard\`/\`custom\` have
  \`10,000 + markup_bps\`.
- The optional monthly component is an exact integer minor-unit string plus ISO currency.
  A \`free\` tariff has zero markup and zero monthly amount. An \`at_cost\` tariff may have a
  separate monthly subscription, but its usage component remains provider cost.
- **Raw token, request, byte, and search counts are never multiplied, rewritten, or
  relabeled.** Ledger keeps immutable raw usage/provider cost and attribution only.
  UOA applies the signed \`usage_price_multiplier_bps\` when rating money and deriving
  separately labeled customer billable units:
  \`raw_metered_units × usage_price_multiplier_bps / 10000\`. The result is a commercial
  unit, not provider output; Ledger retains exact decimal-safe operands and consumers
  show raw usage, billable units, and money separately. Its label follows the underlying
  meter: token-equivalent for token-metered AI, search-equivalent for SERP, and
  research-equivalent for DeepWater.

### Dedicated product app keys

A platform superuser creates one UOA app key per consuming product/environment at:

\`POST /internal/admin/billing/services/:serviceId/app-keys\`

The request binds the opaque \`uoa_app_…\` key to exactly one product, one endpoint
purpose, and one RS256 actor public JWK, issuer, and audience. \`purpose=entitlement\`
can call only the effective-tariff endpoint and forbids redirect origins.
\`purpose=customer_lifecycle\` can call only direct-session access confirmation,
the canonical customer statement, Checkout, subscription summary, customer portal,
and cancellation preview/confirm endpoints and requires at least one exact HTTPS
return origin.
The plaintext key is returned once; UOA stores only a peppered HMAC digest. The same
Ledger signing JWK may be bound to multiple credentials, but Nessie, DeepWater,
DeepSignal, and DeepTest must keep distinct app secrets so every connection is
independently revocable and attributable.

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
  "authorized_party": { "app_key_id": "app_key_123" },
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
    "collection_mode": "stripe",
    "markup_bps": 2000,
    "markup_percent": "20.00",
    "usage_price_multiplier_bps": 12000,
    "monthly_subscription": { "amount_minor": "2000", "currency": "USD" },
    "usage_billing_enabled": true,
    "payment_collection_enabled": true,
    "raw_usage_preserved": true
  },
  "assignment": { "scope": "team", "id": "assignment_123" },
  "issued_at": "2026-07-19T00:00:00.000Z",
  "expires_at": "2026-07-19T00:05:00.000Z"
}
\`\`\`

Verify the JWT through \`GET /billing/v1/jwks.json\`, including algorithm, \`kid\`,
issuer, audience, type, expiry, subject, and exact business-claim agreement with the
returned payload. Require the signed product ID and identifier, authorized app-key ID,
and user/organisation/team subject to equal the expected credential and request. A
snapshot for another product is invalid even when the same Ledger actor signer is bound
to both products. Never accept the unsigned payload on its own.

The JWKS contains the current and overlapping retired public keys. UOA signs with the
private key whose exact public pair is present in that set and imports every key before
serving, so malformed or incomplete rotation configuration fails at startup.

All tariff catalog/default/assignment/key mutations are platform-superuser-only and are
written to the UOA admin audit log. See [/api](/api) for exact mutation contracts.

### Confirm a direct product session

Every product backend calls \`POST /billing/v1/service-access/confirm\` immediately
after its own successful UOA SSO exchange or session establishment. It supplies its
own \`customer_lifecycle\` app key, a fresh bound actor assertion, and the exact
product/organisation/team/user subject body. UOA rechecks both active memberships
and records direct-access evidence; success is \`204 No Content\`.

This call is forbidden for proxy or agent use of another product. For example, Nessie
using DeepWater through Ledger remains indirect: Nessie must not confirm DeepWater
access. This authenticated direct-session seam, never Ledger metering, determines
which products can appear as related direct cancellation choices.

### Canonical customer statement

UOA is the sole commercial billing engine. Ledger returns only immutable
\`metering-usage-v1\` facts; it never returns tariff, subscription, markup,
billable-unit, customer-charge, add-on, credit, payment, or cancellation fields.

\`GET /schemas/billing-statement-v1.json\` publishes the frozen Draft 2020-12 response
schema. \`GET /schemas/billing-statement-v2.json\` adds the complete SSO-filled,
team-wide connected-service portfolio without mutating v1. The open-source-safe
\`@unlikeotherai/billing-statement-protocol\` package
is the TypeScript source used by UOA itself; it has no private server imports or
credentials. Until registry publication, consumers can vendor/pack that package
directory or fetch the matching synthetic fixture from
\`GET /schemas/billing-statement-v2.example.json\` and its exact OpenAPI 3.1
component from \`GET /schemas/billing-statement-v2.openapi.json\`. Product backends
call:

\`POST /billing/v2/customer-statement\`

with their own \`customer_lifecycle\` app key, a fresh bound \`X-UOA-Actor\`, and the
same product/organisation/team/user subject body (plus optional \`billing_month\`).
The response is display-ready: exact current plan and subscription, raw and billable
usage, service/caller/origin attribution, per-user totals, monthly/usage/add-on/credit
lines, exact currency totals, capabilities, and action descriptors. V2 additionally
contains team-wide raw totals for every connected billing product, complete
\`origin_product\` contributions and shares, and per-user service shares. UOA rates
only the requested product. Other-service totals are explanatory and never become
line items or charges on the current statement. One pinned, user-grouped
\`metering-portfolio-v1\` snapshot covers the exact team and month; UOA derives
commercial rating plus all service, origin, and user totals from it.

Products render the supplied labels, descriptions, totals, shares, and actions
unchanged. They never derive totals, markup wording, direct access, cancellation
choices, or a missing-origin remainder. A Nessie-originated DeepWater call therefore
appears in Nessie’s DeepWater origin share but remains indirect access and cannot
create a related cancellation choice. A null legacy origin renders as
\`Unattributed origin\` and likewise creates no service, access, or choice.

The same package freezes the full product-facing action protocol. Its exact
Draft 2020-12 schema bundle, synthetic fixtures, and OpenAPI 3.1 components are
served at \`/schemas/billing-consumer-actions-v1.json\`,
\`/schemas/billing-consumer-actions-v1.example.json\`, and
\`/schemas/billing-consumer-actions-v1.openapi.json\`. They cover the normalized
hosted redirect, cancellation selection, preview (including the fixed
\`POST /billing/v1/cancellation/confirm\` action), confirm request/response, and
minimal error envelope. Every message object rejects unknown properties.

Action IDs and paths are fixed: \`upgrade\` →
\`/billing/v1/stripe/checkout-session\`, \`portal\` →
\`/billing/v1/stripe/portal-session\`, and \`cancel\` →
\`/billing/v1/cancellation/preview\`. The action body contains the exact subject and
server-pinned allowlisted return URLs. Product backends whitelist the ID/path pair and
proxy the body; browser code receives neither UOA app key nor actor JWT.

Direct access comes only from the explicit direct-session call (or another authenticated
first-party billing call) made with that exact product app key. A Ledger caller/origin
product is indirect and cannot create a direct entitlement.
Cancellation preview returns all dialog copy, affected direct services, explanatory
indirect services, an opaque five-minute token, and a server-generated idempotency key.
It offers a related-direct-products choice only when the team has another same-account
direct subscription. Confirmation uses \`POST /billing/v1/cancellation/confirm\` and
revalidates the pinned subscriptions under lock. The matching idempotency key may
resume/replay; the old one-step cancel route does not exist.

Platform superusers create exact organisation/team one-time or monthly add-ons and
credits in UOA Admin. Values are integer minor-currency strings, audited, and
deactivated rather than deleted. Ledger never receives them.

### Shared team credits and recurring add-ons

\`POST /billing/v1/credits\` is UOA's display-ready shared credit read. A product calls it
with its own \`customer_lifecycle\` app key, a fresh bound actor assertion, and the exact
product/organisation/team/user subject. The first field is always **Remaining credits**.
Billing managers receive the full per-service and per-user breakdown plus safe payment
and consent summaries; members receive their own usage, other-team-member aggregates,
and unattributed totals without another user's identity or card detail.

Before projecting a read, UOA pins one exact user-grouped Ledger portfolio cursor for
the team and settles every service in that snapshot together under a serializable team
credit-account lock. Replay is idempotent. Corrections release prior allocations before
reallocating them deterministically. Available credits never cross below zero from new
usage, but the full centrally rated service/user liability remains recorded; only a
verified reversal can create a debt balance. Products never rate, debit, aggregate, or
reallocate shared credits locally.

Platform superusers can inspect and repair an exact team balance through the Admin
**Team credits** view. \`GET /internal/admin/billing/credit-accounts\` returns only
display-ready remaining credits, organisation/team identity, explicit test/live mode,
stable copyable account/org/team IDs, and recent immutable adjustments. It uses an
opaque immutable \`(created_at DESC, id DESC)\` cursor bound to the complete
organisation/team/search filter set plus exact ID/name search; the UI says how many
rows are loaded while another page exists, never a false total.

\`POST /internal/admin/billing/credit-accounts/:creditAccountId/adjustment-preview\`
accepts a non-zero signed credit decimal (at most five decimal places), required reason,
exact org/team, and stable same-account idempotency key. Under the automatic-top-up
advisory lock and credit-account row lock, UOA rejects any unresolved automatic payment
attempt and returns a display-safe current/change/resulting review. Its two-minute signed
confirmation binds the exact account/org/team/mode, actor/domain, balances, reason,
idempotency key, and automatic-top-up generation/state/threshold/refill consequence.

The final \`POST /internal/admin/billing/credit-accounts/:creditAccountId/adjustments\`
accepts only that confirmation token. It takes the same ordered locks, first validates
and returns an existing exact idempotent adjustment, then rejects an unresolved attempt
before any new mutation, and transactionally revalidates every frozen value before
inserting the immutable adjustment, exact linked credit entry, and one audit event. An
exact retry returns the original adjustment plus the **current** account projection
without another entry or audit even if a later automatic top-up is unresolved; changed
intent under the same key fails with 409. Administrative debits
cannot create or worsen debt. Editing any reviewed field invalidates the browser review,
and live mode requires a separate acknowledgement. These endpoints return no internal
credit storage units, raw usage, provider cost, token counts, or Stripe identifiers.

The exact response schema, synthetic fixture, and OpenAPI 3.1 artifact are public at
\`/schemas/billing-credits-v1.json\`, \`/schemas/billing-credits-v1.example.json\`, and
\`/schemas/billing-credits-v1.openapi.json\`.

Billing-manager mutation actions in that projection are live only when UOA has the
active exact service policy, fixed offer/option, matching active Stripe-account catalog,
and required consent/payment evidence. Products relay the complete action body unchanged:
\`/billing/v1/credits/top-up-checkout\`, \`/billing/v1/credits/auto-top-up/setup\`,
\`/update\`, \`/disable\`, and \`/recover\`. These routes require the product's exact
customer-lifecycle app key, a fresh actor assertion, and current ACTIVE organisation/team
billing-manager membership. A caller can identify only the UOA offer or option shown in
the projection; it cannot supply an amount, Stripe Price, currency, quantity, customer,
metadata, PaymentIntent, or return/recovery URL. UOA writes the immutable local intent
before Stripe, derives account/mode-scoped idempotency, and accepts webhook completion
only when Stripe metadata and stored subject/catalog/customer evidence match exactly.
Checkout responses contain one verified HTTPS \`redirect_url\`; update and disable return
\`204\`. Missing or drifted policy, catalog, consent, payment, or Stripe evidence fails
closed and keeps the matching action disabled in later projections.

\`POST /billing/v1/recurring-addons\` returns UOA-owned offers and exact
organisation/team/subscribing-user subscription projections for that product. Manager
views may contain subscription identity; member views expose only the viewer's
relationship to a subscription and never another user's identity or payment details.
Enabled manager actions relay their frozen UOA body to
\`/billing/v1/recurring-addons/checkout\` or
\`/billing/v1/recurring-addons/cancellation/preview\`. Checkout is one exact licensed
monthly Stripe item with server-derived price, customer, return URLs, and idempotency.
Checkout completion does not activate the entitlement: UOA requires an exact paid,
undiscounted initial invoice. A preview returns an opaque five-minute token and UOA
idempotency key; \`/billing/v1/recurring-addons/cancellation/confirm\` rechecks the actor
and subscription, schedules period-end cancellation, and replays the stored exact result.
The matching public artifacts use the \`billing-recurring-addons-v1\` filenames under
\`/schemas\`. Recurring add-ons, including DeepWater privacy, remain separate from shared
credits and from usage rating.

### Contract invoices

UOA also owns manual organisation-contract invoicing. A platform superuser creates a
contract, appends immutable forward-effective versions, and sets one organisation-wide
usage markup plus one exact currency and payment term. Activating a version atomically
creates an immutable \`CUSTOM + MANUAL\` tariff and organisation assignment for each
selected service. A future-effective version can be authored but cannot be activated
before its UTC month. Activation fails on carried-assignment drift, while any covered
service has a team override, during a nonterminal Stripe Checkout/subscription, or while
a completed Checkout still awaits terminal subscription reconciliation. Stripe
projection and manual activation share the exact service/organisation lock in both
directions. The
service set and monthly price per service are pinned to the version; an assignment
pointer may move for a later version and is not historical proof—the term's immutable
tariff ID is authoritative.

The calculator accepts only a closed UTC month. It fetches one immutable organisation-
scoped \`metering-usage-v1\` snapshot per contracted service (no team filter), applies the
same central exact rating core used by customer statements and Stripe exports, adds that
service's monthly amount, then rounds once at the currency boundary. Credits come only
from the latest canonical funded exact-team usage settlements, remain a separately
labelled aggregate, and never alter a service line. Paid recurring add-ons are shown as
collected separately and never enter the manual invoice total. Currency mismatch, missing selected provider
cost, absent explicit issuer/buyer legal profiles, or unavailable Ledger evidence fails
closed. UOA performs no tax or FX inference.

\`POST /internal/admin/billing/invoices/calculate\` and every invoice list/detail/mutation
return only final customer price per service, legal profile snapshots, totals, and
separate credit/payment/write-off/outstanding settlement totals plus display-only
separately collected recurring add-ons. They never return
provider cost, token or other units, calls, usage markup, Ledger cursor/hash, or the
internal calculation digest. Credits are never folded into or renamed as service prices.
The contract-editor routes are the only place the organisation markup is shown.

Contract and version controls are also server-authored. A contract returns
\`actions.add_version\`, and every version returns
\`actions.{activation_state,activate}\`. The activation state is exactly \`active\`,
\`ready\`, \`scheduled\`, \`superseded\`, or \`contract_terminated\`. Admin clients
render those controls as returned and never decide locally which authored version may be
activated.

Every customer-safe invoice DTO includes a server-authored \`actions\` projection.
\`issue\` is \`issue\` only when UOA's database readiness function proves the active
contract, issuer, exact service/metering/credit evidence, collector exclusivity, and
active-invoice uniqueness; it is \`resume_issue\` for a recoverable issuing invoice,
and otherwise null. \`download_pdf\` and \`void\` are exact booleans.
\`payment_limits\` contains nullable \`payment\`, \`refund\`, and \`write_off\`
maximum Money values. Admin clients render these values and do not reconstruct lifecycle
eligibility, settlement limits, or commercial arithmetic. The private PDF object key and
SHA-256 remain server-only; clients receive only \`download_pdf\` and stream verified bytes
through the PDF endpoint.
Any private positive credit-settlement reference blocks voiding even if its converted
minor-currency display rounds to zero.

Issuance allocates a contiguous contract/month revision and monotonic issuer/year number
under database advisory locks, stores a
private create-only Unicode PDF, and verifies its SHA-256 on download. Every calculated
draft header, line, and private metering reference freezes at calculation commit. Voiding
retains the number and PDF and is forbidden after settlement; changed calculations and
corrections are new revisions.
Manual payment, refund, and write-off events are positive, append-only, idempotent records and
never mutate a service price. All routes are platform-superuser-only and private,
no-store.

### Stripe subscription invariants

Stripe is an account-and-mode-scoped payment projection. Test and live resources never
share local identities or idempotency keys. Checkout is a recoverable billing-scope lease:
a fresh actor JWT for the same exact product key, tariff source/assignment, scope, customer,
and return URLs recovers the winner, including after a crash between Stripe creation and
the local write. Organisation subscriptions exclude team subscriptions for that product
and organisation; independent team scopes may coexist.

A hosted Checkout anchors the subscription to the first day of the next UTC month with
proration disabled. The initial alignment stub is therefore free, the first invoice
covers the first complete UTC calendar month, and later renewals remain calendar-aligned.
Customer applications use \`POST /billing/v1/stripe/subscription-summary\` to read a
safe projection without Stripe IDs, \`POST /billing/v1/stripe/portal-session\` to open
an allowlisted Stripe portal, and the canonical
\`/billing/v1/cancellation/preview\` → \`/billing/v1/cancellation/confirm\` flow to
schedule period-end cancellation.
Portal and cancellation require an owner/admin at the exact billing scope. Summary
remains truthful while collection is disabled by returning the last unambiguous local
projection with \`stripe_collection_enabled=false\`; portal and cancellation fail closed.

A subscription stays pinned to Checkout's immutable tariff version, precedence source,
assignment ID, and billing scope until terminal. Conflicting default or assignment
mutations fail with \`STRIPE_TARIFF_PINNED\`; UOA does not silently reprice the next cycle.
Signed webhooks are reconciled against current Stripe state. Subscriptions require exactly
the expected quantity-one monthly item when non-zero and one metered usage item, with no
extras, duplicates, or discounts. Missing current Stripe state tombstones an existing
local subscription, and reordered updates cannot resurrect canceled state.

### UOA-to-Ledger billing collection

When Stripe collection is explicitly enabled, UOA reads Ledger’s immutable monthly
raw-metering snapshot with **UOA’s own dedicated Ledger app key** in
\`X-Ledger-App-Key\`. It never borrows a Nessie, DeepWater, DeepSignal, DeepTest, user,
or webhook credential. A fresh \`X-UOA-Service-Assertion\` independently binds that app
key ID to \`scope=metering.read\`, the exact product, organisation, optional team, and
UTC billing month. Ledger verifies the assertion through
\`GET /billing/v1/service-jwks.json\`; those keys are dedicated to this service
assertion and rotate with a current/retired overlap.

Stripe export continues to request \`GET /v1/metering/usage?group_by=service\`
for one exact billed product. BillingStatementV2 instead requests
\`GET /v1/metering/portfolio?group_by=user\` with an exact signed team and
\`view=team_portfolio\`, producing one immutable \`metering-portfolio-v1\`
snapshot across billing products. UOA derives commercial rating plus every
service, origin, and user total from that same pinned snapshot. The statement
product in that assertion is a display perspective, never a filter or a tariff grant.
The public product-scoped Ledger schema is
\`https://ledger.unlikeotherai.com/schemas/metering-usage-v1.json\`. Exact
\`mus_…\` cursor/ID snapshots contain string raw units, provider-estimated,
provider-actual, and exact selected cost
(\`SUM(COALESCE(actual, estimated))\`), currency/provenance, and
billing/caller/origin dimensions. UOA rejects unknown
commercial fields and centrally applies the pinned tariff before anything reaches
Stripe. Null caller/origin attribution remains unattributed; it never creates a
service, direct-access record, or cancellation choice.

Platform superusers can exercise or replay one subscription/month through
\`POST /internal/admin/billing/stripe/usage-exports\`. The optional
\`ledger_snapshot_cursor\` replays an exact immutable Ledger snapshot. The response
separates \`billing_product\`, \`caller_product\`, the exact UOA-rated cumulative
customer charge, and cumulative/delta integer Stripe quantities. When
\`STRIPE_BILLING_ENABLED=true\`,
UOA automatically invokes the same idempotent export for active Stripe-paid full calendar
periods, polls at \`STRIPE_USAGE_EXPORT_INTERVAL_MINUTES\`, and schedules an additional
pre-boundary safety pass at \`STRIPE_PRE_BOUNDARY_SAFETY_OFFSET_MINUTES\` once inside
the configured lead window. It skips the free alignment stub and all free/manual/none
tariffs. A non-calendar period after alignment is an operator-visible failure, never
silently treated as free.

The safety pass is not final. For a draft \`subscription_cycle\` invoice, the signed
\`invoice.created\` webhook retrieves current Stripe state, verifies the exact
account/mode/subscription/customer/currency/just-ended calendar period, fetches a fresh
Ledger snapshot, and exports the remaining delta before committing the webhook event.
The retrieved cycle invoice must retain at least one hour between \`created\` and
\`automatically_finalizes_at\`; an absent or shorter window fails closed. Failure returns
non-success and leaves the event uncommitted, so Stripe retries during its
invoice-finalization grace period. \`invoice.finalization_failed\` is also recorded and
logged with structured error/automatic-tax status, and retries post-period export while
the invoice remains a valid draft. Meter-event creation is durable delivery evidence,
not instant aggregate visibility; invoice reconciliation is verified after Stripe
asynchronously recomputes the draft at finalization.

---
`;
