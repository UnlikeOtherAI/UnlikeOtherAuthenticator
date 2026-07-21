# Organisation Contract Invoicing

## Status and authority

UOA is the sole commercial authority for organisation contracts and manual
invoices. Ledger supplies immutable raw usage and selected provider-cost facts;
it does not own a contract, markup, monthly price, invoice, tax, payment, or
customer price. Product services never calculate contract invoices.

This control plane is platform-superuser-only. Its invoice response and PDF are
customer-safe even though the operator is privileged: they contain only final
price per service, legal party snapshots, totals, and separate settlement
totals. Provider cost, token/search/research units, calls, markup, Ledger
cursor/hash, and the calculation digest are private calculation evidence and
must never cross that boundary.

## Contract model

An organisation may have at most one active contract. A contract has a stable
operator reference and append-only, forward-effective versions. The database
serializes version creation per contract, requires contiguous version numbers,
and requires each effective month to be strictly later than its predecessor. A
version pins:

- one organisation-wide usage markup in basis points;
- one exact three-letter currency;
- payment terms in days;
- an effective UTC month;
- the complete service set and one monthly minor-currency price per service.

The operator-facing contract editor may show the markup. No invoice DTO or PDF
may show it.

Activating a version atomically creates one immutable tariff per covered service
with `mode=CUSTOM`, `collection_mode=MANUAL`, the version markup/currency, and
that service's monthly amount. It also moves the service's organisation tariff
assignment to the generated tariff and inserts the immutable service term.
Activation rejects:

- a version whose `effective_from_month` has not arrived in UTC, so its current
  organisation assignment cannot rate early;
- an existing team assignment for any covered service;
- an open/creating Stripe Checkout, or a completed Checkout whose subscription
  reconciliation is absent/nonterminal, for a covered service and organisation;
- any nonterminal Stripe subscription for that scope;
- an inactive/missing service or a duplicate service selection;
- a drifted live assignment that cannot be safely retired from the prior version;
- a terminated contract or an already-active version with different terms.

Service-term creation, the final `DRAFT` → `ACTIVE` transition, and every Stripe Checkout/subscription projection take the same
service/organisation advisory lock. Reciprocal database triggers prevent a
Checkout or subscription from becoming commercially live after a manual
contract covers that scope, including the completed-Checkout reconciliation
window.

Future versions may be authored in advance, but the operator activates them on
or after the first instant of their effective UTC month. Before any tariff or
assignment write, activation verifies that every carried assignment still has
the exact organisation, service, tariff, organisation scope, null team, and
scope key pinned by the prior service term.

An organisation assignment is a mutable current-deployment pointer reused by a
later contract version. It is not historical commercial evidence. The service
term's immutable `tariff_id` is authoritative for that version. When a later
version removes a service, activation deletes that service's live organisation
assignment and the historical term retains a nullable provenance pointer.
Generic tariff management rejects organisation/team overrides and removal of an
assignment protected by the current active version.

## Explicit legal profiles

UOA never seeds or infers a legal issuer. Issuance requires an active explicit
issuer profile containing a legal name, billing email, postal address, and
invoice-number prefix. Trading name, tax identifier, and company registration
number are optional explicit values.

Each contracted organisation requires an explicit buyer profile with legal
name, accounts-payable email, and billing address. Tax identifier and purchase
order reference are optional explicit values. Calculation snapshots the exact
issuer and buyer values, so later profile edits cannot rewrite an invoice.

UOA performs no tax determination and no FX conversion. The v1 calculator uses
an explicit zero tax amount. Currency mismatch or a need for tax/FX handling is
an operator-visible fail-closed condition, never an inferred conversion.

## Closed-month calculator

Only a month whose UTC end is at or before the current instant can be
calculated. For the effective version, UOA fetches one immutable
`metering-usage-v1?group_by=service` snapshot for each covered billing product,
scoped to the exact organisation with no `team_id`. This intentionally covers
all teams without summing team snapshots.

The shared rating core used by canonical statements and Stripe exports applies:

```text
customer usage price = selected provider cost × (10000 + markup_bps) / 10000
```

For each service, the calculator adds into its gross final service price:

1. centrally rated organisation-wide usage;
2. the version's monthly service amount;

It then rounds exactly once to the contract currency's minor-unit boundary. A
missing selected cost, wrong billing product, wrong currency, negative service
total, or overflow rejects the calculation. No raw cost or usage quantity is
persisted in the customer line. The invoice stores:

- one final `amount_minor` line per service;
- one separately labelled aggregate `credits_applied_minor` settlement value;
- separately collected recurring add-on display lines that are excluded from
  the invoice subtotal, total, credits, and amount due;
- private snapshot cursor/hash/capture-time evidence per service;
- an internal calculation digest for idempotency;
- exact legal party snapshots and totals.

The calculated header, lines, and private evidence freeze when their creation
transaction commits, including while status remains `DRAFT`. Repeated identical
calculation returns that existing draft. A changed immutable snapshot, legal
profile, canonical funding settlement, add-on subscription, or term creates the
next revision. Revision allocation takes a contract/month advisory lock and the
database independently requires `max(revision)+1`, so concurrent calculations
cannot select the same revision. An issued invoice is corrected by a new
revision; it is never edited.

Prepaid credits/top-ups are a distinct customer balance and are not folded into
or renamed as a service price. `credits_applied` is aggregated only from the
latest `APPLIED` canonical exact-team usage-settlement adjustments for the
contract's exact tariff/service/month. The underlying append-only credit debit
already proved sufficient available balance; uncovered rated usage remains in
the settlement and therefore remains in the invoice's gross service price.
Negative refund/dispute debt, an unconsumed balance, a subscription-bound
settlement, and a settlement already projected to a Stripe credit line are not
credits applied. The invoice stores private settlement/adjustment references,
never raw microcredit evidence in a DTO or PDF. Issuance and Stripe projection
share a per-settlement collector lock and reciprocal database guard, so the same
funded usage cannot be credited on both a manual invoice and Stripe. The fixed
customer conversion is 1,000 credits = US$1 and does not alter contract line
calculation.

Recurring add-ons come only from UOA's canonical paid and activated
`BillingRecurringAddonSubscription`. The invoice snapshots the service, offer
identity/version, catalog, final monthly price, currency, and scope. JSON and
PDF label these rows as collected separately and exclude them from the manual
balance due, preventing a second collector for the Stripe-paid subscription.

## Issuance and immutable PDF

Issuance is a recoverable two-phase operation:

1. a serializable transaction claims the draft, atomically increments the exact
   issuer/year sequence, and sets issue/due dates;
2. UOA generates a deterministic, wrapping-safe PDF from the customer-safe
   invoice model using vendored DejaVu Unicode fonts, then writes it with
   create-only semantics to private storage;
3. UOA records the object key, SHA-256, template version, and issued state.

A retry resumes `ISSUING` with the same invoice number and object key. An
already-present object is accepted only if its exact SHA-256 matches. Download
rechecks the stored bytes. Issued commercial fields, lines, private evidence,
and PDF identity are immutable. Invoice number, issue date, and due date freeze
as soon as issuance begins; active/terminated contract timestamps are likewise
database-frozen. A void retains the number and PDF. A settled invoice cannot be
voided.

`BILLING_INVOICE_STORAGE_PROVIDER` defaults to `disabled`; calculation remains
available but issuance returns a fail-closed error. Filesystem storage is local/
test only and rejected in production. Production uses a dedicated GCS bucket
with public access prevention and create/read permissions restricted to the UOA
runtime identity. The application never deletes issued invoice objects.

## Settlement events

Payment, refund, and write-off events are append-only and use positive integer
minor-currency amounts. Kind supplies the direction. Every event has an
invoice-scoped idempotency key, exact invoice currency, occurrence time, source,
optional external reference, and operator attribution.

The current payment-event source is `MANUAL` only. A Stripe source will not be
introduced until UOA can bind it to immutable account/mode webhook evidence.

Applied credits, payments, refunds, and write-offs form the settlement
calculation while credits remain their own labelled value. The service and
database both reject negative settlement, over-settlement,
over-refund, mutation/deletion, currency mismatch, or settlement on a draft,
issuing, or void invoice. Payments and write-offs are displayed separately from
the immutable service prices. No event rewrites a line or total.

## Admin API

All responses are `Cache-Control: private, no-store` and require an
`ADMIN_AUTH_DOMAIN` platform-superuser token.

| Method     | Path                                                                         | Purpose                                    |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| `GET/POST` | `/internal/admin/billing/contracts`                                          | List/create contracts                      |
| `POST`     | `/internal/admin/billing/contracts/:contractId/versions`                     | Append version                             |
| `POST`     | `/internal/admin/billing/contracts/:contractId/versions/:versionId/activate` | Project and activate service terms         |
| `GET/POST` | `/internal/admin/billing/invoice-issuer-profiles`                            | List/create explicit issuers               |
| `GET/PUT`  | `/internal/admin/billing/organisations/:organisationId/invoice-profile`      | Read/upsert buyer profile                  |
| `POST`     | `/internal/admin/billing/invoices/calculate`                                 | Create/reuse a closed-month draft revision |
| `GET`      | `/internal/admin/billing/invoices`                                           | List safe revisions                        |
| `GET`      | `/internal/admin/billing/invoices/:invoiceId`                                | Read safe detail                           |
| `POST`     | `/internal/admin/billing/invoices/:invoiceId/issue`                          | Issue idempotently                         |
| `GET`      | `/internal/admin/billing/invoices/:invoiceId/pdf`                            | Private verified PDF                       |
| `POST`     | `/internal/admin/billing/invoices/:invoiceId/void`                           | Void unpaid issued invoice                 |
| `POST`     | `/internal/admin/billing/invoices/:invoiceId/payments`                       | Append payment/refund/write-off            |

Invoice DTOs use exact schemas with `additionalProperties: false`, including
the nested issuer and buyer objects. A service line is exactly:

```json
{
  "id": "line_…",
  "service": { "identifier": "deepwater", "name": "DeepWater" },
  "price": {
    "amount_minor": "6250",
    "amount": "62.5",
    "currency": "USD",
    "display": "$62.5"
  }
}
```

The response schema deliberately has no vocabulary for markup, cost, raw or
billable units, calls, private Ledger evidence, or calculation digest.
Recurring add-ons appear in `separately_billed_add_ons` with their customer-safe
service/offer labels, scope, monthly price, and the fixed note `Collected
separately; not included in this invoice total.`

## Database enforcement

The guarded migration independently enforces:

- one active contract per organisation;
- append-only versions and service terms with forward effective months;
- coherent CUSTOM+MANUAL generated tariffs and organisation assignments;
- exact organisation/contract/version/profile/currency invoice scope;
- complete term = line = private-evidence service sets and exact line sums
  before `ISSUING`;
- only one `ISSUING`/`ISSUED` invoice per organisation/month/currency;
- contiguous invoice revisions serialized per contract/month;
- exact latest canonical credit evidence and one manual-or-Stripe collector per
  settlement;
- immutable paid recurring add-on snapshots excluded from manual totals;
- immutable issued fields, lines, private evidence, and PDF identity;
- append-only bounded settlement events and no settled void;
- monotonic issuer/year numbering and advisory contract/version locks;
- forced RLS with deny-all `uoa_app` policy and `uoa_admin` access only.

These controls are not replaced by route validation. Migration tests apply all
migrations to fresh PostgreSQL and exercise the state transitions and rejection
paths.
