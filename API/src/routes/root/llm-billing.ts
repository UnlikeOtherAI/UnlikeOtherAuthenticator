import { llmBillingHistoryMarkdown } from './llm-billing-history.js';
export const llmBillingMarkdown = `## Canonical tariff and entitlement control plane

### Private paid-usage exception recovery

When a selected immutable Ledger provider receipt exceeds the original frozen
cost bound, ordinary settlement remains held. The exact product-bound Ledger
RuntimeKey calls \`POST /billing/v1/ledger/reservations/:dispatchId/exception\`
with the selected receipt, exact USD actual cost and lowercase SHA-256 digest.
The digest is over compact JSON of
\`[dispatchId,receiptId,rawActualFixed18,"USD",requestFingerprint,rawBoundFixed18,contextDigest]\`.
Paid reserve and original product-bound decision lookup expose the exact
private frozen \`context_digest\`; Ledger persists it before provider egress.
It creates only a held private exception, never a customer debit or release.
\`GET\` at the same path returns the held or exact terminal decision to Ledger.

Platform superusers review the oldest held receipts in Admin Billing → Usage
exceptions or \`GET /internal/admin/billing/paid-usage-exceptions\`. A freshly
issued (at most five minutes old), live-epoch superuser token may POST the exact
evidence digest, stable idempotency key and written reason to
\`/internal/admin/billing/paid-usage-exceptions/:dispatchId/write-off\`.
UOA books the frozen gross rated liability once, charges at most the original
reserved microcredits, explicitly waives the excess, and still counts gross
usage against credit budgets. PREPAID wallet debits only the collectible part.
Unknown actual cost, missing historical rating or a changed selected receipt
remain held for further evidence; no operator can turn unknown into zero.

Platform superusers configure append-only prepaid legal invoice tax policy at
\`GET/POST /internal/admin/billing/credit-invoice-tax-policies\`. A policy binds
one Stripe account, active legal issuer, issuer jurisdiction, inclusive tax
rate or documented no-tax treatment, legal basis and UTC effective time.
Accepted credit payments fund the wallet once and create one durable invoice
obligation. Missing buyer, issuer or tax facts leave a pending document; UOA
never adds tax to the already charged amount or fabricates a legal invoice.

Tariffs live in UOA. Ledger and product backends consume signed, content-free effective
tariff snapshots; they do not maintain independent tariff truth.

### Model price estimates

Products may POST backend-loaded Ledger catalogue cards to \`/billing/v1/model-prices\`
with a customer_lifecycle app key and exact endpoint-audience actor. UOA resolves
current exact-subject monthly terms and returns customer credits per million input,
output and cached input tokens, including labelled conditional dimensions.
Responses bind product, organisation, team and user and expire in five minutes.
They grant no spending authority. Products accept only model identifiers from their
browser and load the cards from Ledger themselves; no browser-supplied cost is trusted.
USD fixed token cards use the existing microcredit rating quantum; other currencies,
meters, dynamic pricing and missing rates remain explicitly unavailable. UOA returns
no provider cost, markup or tariff identifiers. Independent Ledger evidence still owns
actual settlement; these rates neither reserve funds nor freeze future charges.

### Commercial semantics

- UOA resolves immutable monthly terms by team assignment, organisation assignment,
  then service default. Only UOA rates selected Ledger provider cost.
- The customer receives exact usage charges, credit consumption,
  monthly subscription price, collection status, and payer scope. Provider cost,
  markup, margin, rate multipliers, and cost-basis modes stay inside UOA.
- Product backends verify signed entitlement binding and render UOA-authored
  customer statements. They do not calculate a customer price or credit debit.

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
DeepSignal, DeepTest, and DocGen must keep distinct app secrets so every connection is
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

The actor JWT has \`iss\` exactly equal to the credential binding, \`sub=user_id\`, and
matching \`product\`, \`organisation_id\`, and \`team_id\`, plus non-empty \`jti\` and
\`iat\`/\`exp\` no more than 60 seconds apart. UOA verifies the signature and re-resolves
the ACTIVE org and team memberships before returning anything.

**\`aud\` must name the endpoint you are calling.** Mint it per request as
\`\${PUBLIC_BASE_URL}\` joined with the exact request path — \`.../billing/v1/effective-tariff\`
here, \`.../billing/v2/customer-statement\` there, and so on for every endpoint below.
Do not pin one audience and reuse it: an assertion whose audience names another
endpoint is refused with 401 \`BILLING_ACTOR_AUDIENCE_MISMATCH\`, which is what stops a
captured read assertion being spent at a funding or cancellation endpoint inside its
60-second window. Deployments in the \`BILLING_ACTOR_AUDIENCE_MODE=warn\` transition
still accept the single legacy audience
\`\${PUBLIC_BASE_URL}/billing/v1/effective-tariff\` everywhere and log each use;
\`enforce\` refuses it. Move to per-endpoint audiences now — they are accepted in both
modes.

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
    "collection_mode": "stripe",
    "monthly_subscription": {
      "amount_minor": "2000", "currency": "USD", "charge_basis": "per_seat",
      "seat_policy": "fixed", "seat_timing": "prorated",
      "amount_role": "per_seat_unit"
    },
    "usage_billing_enabled": true,
    "usage_payment_mode": "prepaid",
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

### Organisation billing replaces team statements

UOA is the sole commercial billing engine. Ledger returns only immutable
\`metering-usage-v1\` facts; it never returns tariff, subscription, markup,
billable-unit, customer-charge, add-on, credit, payment, or cancellation fields.

\`GET /schemas/billing-statement-v1.json\` publishes the Draft 2020-12 response
schema. \`GET /schemas/billing-statement-v2.json\` adds the complete SSO-filled,
team-wide connected-service portfolio. Package 4.0.0 removes the public pinned
tariff identity and adds monthly cycles; strict consumers must update before UOA
serves the revised schemas. The open-source-safe
\`@unlikeotherai/billing-statement-protocol\` package
is the TypeScript source used by UOA itself; it has no private server imports or
credentials. Until registry publication, consumers can vendor/pack that package
directory or fetch the matching synthetic fixture from
\`GET /schemas/billing-statement-v2.example.json\` and its exact OpenAPI 3.1
component from \`GET /schemas/billing-statement-v2.openapi.json\`. These strict
artifacts remain available for pinned historical clients. The former read:

\`POST /billing/v2/customer-statement\`

with its own \`customer_lifecycle\` app key, a fresh bound \`X-UOA-Actor\`, and the
same product/organisation/team/user subject body (plus optional \`billing_month\`)
now checks current manager authority and returns409
\`BILLING_ORGANISATION_OVERVIEW_REQUIRED\`. The v1 statement and old credits read
do the same. Use \`/billing/v1/organisation/overview\`; preserve the session and
the original displayed action context or absence. The former response described exact plan and subscription, customer
charges, credit consumption, monthly/usage/add-on/credit lines, exact currency
totals, capabilities, and action descriptors. V2 includes connected-service
customer credit totals without exposing token counts or provider costs. UOA
rates only the requested product. Other-service totals are explanatory and
never become line items or charges on the current statement. One pinned,
user-grouped \`metering-portfolio-v1\` snapshot covers the exact team and month;
UOA derives the private rating evidence and public credit totals from it.

### Customer display language

Cycles and invoice list/detail reads accept the same optional
X-UOA-Billing-Presentation: 1.5.0 and X-UOA-Billing-Locale headers as statements
and credits. Supported locales are cs, en-US, en-GB, de, es, fr, it. Locale is
outside the signed subject. Only generated labels and exact decimal money
displays change, after source integrity checks. Stored snapshots, charge/rating
facts, line identities and legal PDF/CSV bytes stay immutable. Authored service
names, Stripe line descriptions and stored adjustment reasons remain verbatim.

${llmBillingHistoryMarkdown}

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
closed. The operator must attest the invoice's tax treatment, exact rate and legal
basis before draft calculation; those facts and cumulative per-line tax are frozen.
UOA performs no FX inference. A later manual usage correction creates only a
delta-only supplemental invoice through
\`/internal/admin/billing/cycle-corrections\`, with the original issued tax policy
and legal invoice retained. Negative provider-cost differences remain held
without a separate verified correction source; immutable paid receipts do not
decrease. For an issuer-authorized cancellation of a paid, single-product manual
invoice with no wallet offset, Admin can prepare a separate legal credit note
against the exact original amount and frozen tax policy with a required reason.
POST /internal/admin/billing/invoices/:invoiceId/credit-note/prepare freezes it,
POST /internal/admin/billing/credit-notes/:id/issue allocates a separate legal
number/PDF, and GET /internal/admin/billing/credit-notes/:id/pdf downloads it.
The original invoice and accepted payment stay immutable. Verified refunds and
customer credit still due appear in an append-only customer cycle revision;
the note never mints prepaid wallet credits.

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
activated. A draft is ready only for a future effective month; scheduled means
an activated version will take effect in that future month.

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

Automatic top-up disable remains available during an unresolved payment. Only the
original verified lifecycle event may settle that older attempt; settlement never
restores disabled consent. Recovery uses a bounded exact-account Stripe Events
scan and the existing validation and deduplication path, never a replacement charge.

### Customer language and exact credit purchase status

Presentation-capable clients send \`x-uoa-billing-presentation: 1.5.0\` and
\`x-uoa-billing-locale\` (cs, en-US, en-GB, de, es, fr, it) on billing reads,
previews and actions. These headers affect display only; signed subjects and frozen
action bodies stay unchanged. Legacy clients retain English and the old redirect
envelope. Negotiated credit Checkout additionally returns an opaque \`purchase_id\`.
Read it via \`POST /billing/v1/credits/purchase-status\` with the exact subject and
fresh endpoint-bound actor. The strict public schema is
\`/schemas/billing-credit-purchase-status-v1.json\`. A successful redirect or
Stripe PaymentIntent does not prove that credits were added: only the durable
credit entry plus its verified completion event yields \`succeeded\`. Read failures
must not be presented as declined payments. Poll only \`awaiting_confirmation\`
within a finite return window. When Stripe still reports the exact bound Checkout
open, the response may include \`continuation\` with the same opaque \`purchase_id\`;
opening it resumes that session without creating another Checkout or charge.
Current authority, account/customer/service/app-key binding and private no-store
responses prevent cross-context disclosure.
New hosted Stripe sessions receive the requested language. Resuming an existing
session preserves it; subscription Checkout retries reuse their saved locale.
`;
