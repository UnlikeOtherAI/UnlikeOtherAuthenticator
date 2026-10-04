# Billing Tariffs and Product Entitlements

## Status and ownership

UOA is the canonical commercial control plane and customer billing system of
record. It owns tariffs, rating, subscriptions, statements, add-ons, credits,
customer charges, and billing actions. Ledger records only immutable raw
token/API/SERP/research/provider usage, provider cost, and attribution facts.
Nessie, DeepWater, DeepSignal, DeepTest, and future products consume UOA's
effective-tariff snapshots and display-ready statements. Products and Ledger
must not maintain independent tariff or commercial-rating logic.

This slice defines tariff storage, assignment, app authentication, signed
entitlement reads, and a fail-closed Stripe collection foundation. UOA can map
an exact immutable tariff version to Stripe products/prices, create a hosted
subscription Checkout, reconcile signed webhooks, and export UOA-rated customer
amounts derived from Ledger's raw immutable metering.
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
New service and tariff dialogs prefill a 3,000 basis-point (30%) standard
markup. The prefill is prospective; stored versions and negotiated custom or
at-cost terms are never rewritten by that UI default. Stripe collection stays
an explicit choice.

Commercial selection now has an append-only monthly history as well as the
operator's current default/assignment pointers. A new service's initial default
applies from its creation UTC month. Later default and organisation/team
assignment changes take effect on the first day of the next UTC month; a
same-month edit to a scheduled change appends another decision, with the latest
decision before that month governing it. Removing an assignment appends an
explicit removal so the next lower-precedence term applies. UOA resolves the
requested billing month before rating credits or a customer statement; a
read cannot establish that month's terms. Stripe subscriptions continue to use
their checkout-pinned tariff. Activated manual contract service terms are
resolved by their immutable contract version's explicit effective month for
credit and statement rating as well as manual invoices. Competing contracts
claiming one service/month are held for reconciliation. New manual contract
versions may only be activated for a future UTC billing month. Activation
records their immutable terms without moving the live assignment, so already
dispatched but not yet settled usage in the current month keeps its price.
Legacy activated versions retain their original effective months and terms.
For a terminated manual contract, its explicit terms remain authoritative for
whole UTC months before `terminated_at`. If termination is exactly at a UTC
month start, that month uses the next evidenced ordinary term. A termination
within a month cannot be split from monthly Ledger usage, so that month is
held as `BILLING_CONTRACT_TERMINATION_MONTH_RECONCILIATION_REQUIRED`. Later
months must not inherit a stale assignment to the terminated contract tariff:
they use a separately evidenced effective term or remain held.

The migration starts legacy history only at a month for which the current
pointer can be supported by the service creation, assignment update, and
administrator audit timestamps. A later tariff version moves that boundary
forward; multiple versions without a pricing audit cannot prove the old
default and remain held until a month after migration. It retains existing
tariffs unchanged. Older
months without reliable evidence return
`BILLING_TARIFF_HISTORY_RECONCILIATION_REQUIRED` and require an audited
operator reconciliation; UOA must not infer their price from today's pointer.
Reconciliation needs the executed agreement and activation/termination dates
(if contractual), the contemporaneous tariff or assignment change and its
administrator audit record, and the exact organisation, team, service, and
month in Ledger. The operator must compare existing credits, Stripe exports,
and issued invoices before recording a new append-only effective decision;
settled rows require an explicit adjustment rather than a silent rerating.
No operator endpoint exists yet, so an interval lacking this evidence stays
held. A current pointer or the first statement read is not evidence of an
earlier price.
The administrator write API accepts `markup_percent` as a decimal string with
at most two decimal places (for example `"30.00"`); it converts exactly to
internal basis points. The previous `markup_bps` write field is rejected, including
requests that send both fields, so an operator cannot accidentally enter 30
as basis points. For a `standard` tariff, omitting `markup_percent` uses
30.00% centrally. `custom` requires an explicit value; `free` and
`at_cost` default to zero. Provider cost is reported separately from the
customer rated charge, so free rated base, markup, and total are all zero.

## Paid usage completeness and settlement

Ledger supplies immutable provider cost and attribution, including an explicit
`billingCompleteness` signal for unresolved paid attempts and a
`billingDisposition` for paid versus intentionally nonbillable rows. UOA holds
all paid settlement and export while any paid attempt remains unresolved, and
holds a paid row with missing selected cost or currency. Nonbillable telemetry
is excluded only when Ledger marks it explicitly. UOA alone applies the
tariff's basis points to exact selected provider cost; a 3,000 bps markup on
US$1.00 is US$1.30 before the collection path’s exact credit or Stripe meter rounding.

Credit portfolio snapshots and settlements identify the source team even when
an organisation credit account pays multiple teams. Older ambiguous
organisation settlement rows retain their recorded debit and receive no
invented team lineage. The payer/month is held for explicit reconciliation.
The append-only payer transition history records future assume/release actions;
a monthly aggregate that crosses a payer transition, or predates reconstructable
legacy history, is also held. A durable scheduler revisits source-team/month
portfolios independently of customer page reads, including older periods, and
records its next check, last cursor, and hold reason. Current and previous
months have priority, while older months retain a separate fair work budget.
Watches begin with the source team's creation month even when its credit
account was opened later; dated payer lineage determines which account may
settle each historical month. Existing Stripe reservations prevent later
funding from debiting already exported charges.

For a Stripe subscription, UOA first allocates available prepaid credits to
the rated liability, then reserves only the remaining amount as meter usage.
The reservation and credit allocation share the payer account lock. Once a
meter row is reserved or accepted, later top-ups can fund only new usage not
already reserved for Stripe; refunds do not silently rewrite accepted usage.
Stripe reservation also advances the locked payer row version. This makes a
serializable credit settlement that was already waiting for the row retry with
a fresh snapshot of the newly reserved liability; a lock without a row write
can otherwise let that settlement debit credits for the same usage.
Each exported caller bucket stores gross and net cumulative quantity. Existing
bucket allocations stay fixed, and newly consumed credits are applied only to
new gross usage in that bucket. A legacy export without gross evidence holds
subsequent export for reconciliation instead of guessing its prepaid share.
Stripe delivery records a durable attempt before the external call. An
unconfirmed attempt is retried only inside the identifier safety window measured
from its immutable first possible acceptance, even if later attempts restart;
after that it is held for reconciliation. UOA never assumes a timed-out event
was rejected or sends an unverified negative meter correction.
Platform billing operators use the machine-only
`GET /internal/admin/billing/stripe/usage-reconciliations` report to find
unconfirmed meter rows. `POST` to the same path with `/:exportId` records an
evidence reference, observation time, actor, and one of three decisions:
confirmed accepted, confirmed not accepted (releases one retry generation with
a new identifier only while
Stripe's meter timestamp window remains open), or a verified manual invoice
line for an expired period. Evidence is append-only and the resolution is
written atomically with the export state and admin audit log. The operator must
verify the external Stripe event or invoice before submitting the decision;
UOA cannot infer acceptance from a timeout or recover an expired identifier by
automatic replay.
An operator decision cannot race an active send lease, and an old response can
mark acceptance only for the exact identifier, generation, and attempt it sent.

Subscription-cycle invoices have a separate durable close record keyed by the
Stripe invoice and service month. An unresolved export or incomplete Ledger
coverage pauses a draft invoice's `auto_advance`; the background close cycle
retries export and releases the draft only after it is current. If Stripe has
already finalized the invoice, UOA compares the period's latest net liability
with the **actual finalized usage lines**, rather than treating an accepted
meter event as proof that its amount appeared on the invoice. The close stores
the Ledger cursor, invoice-line IDs and amount, currency, period, and exact
unbilled increment. Later Ledger receipts continue to recheck finalized and
previously compensated closes, including older months. No expired meter event
is replayed into a finalized invoice.

`GET /internal/admin/billing/stripe/invoice-closes` is the machine-only
operator queue. A positive finalized gap requires a paid manual Stripe invoice
with one line, exact rounded amount, customer/account/currency, and metadata on
both invoice and line binding the source close, source invoice, subscription,
service, and period. `POST /internal/admin/billing/stripe/invoice-closes/:closeId/compensate`
verifies that evidence and records the actor, line, paid amount, liability,
and cursor in an append-only resolution. A paid invoice or line can resolve
only one gap. If still later usage arrives, the next close cycle subtracts
earlier paid adjustments and holds only the new incremental liability.

`BillingCreditsV1` 2.0.0 callers opt in with
`x-uoa-billing-credits-protocol: 2.0.0`. On a Ledger or legacy reconciliation
hold, UOA returns confirmed balance and entry history with
`billing_status.settlement_state = pending_reconciliation`; its message says
recent usage is not yet included in the confirmed total. Older strict-schema
callers keep the previous response shape when current and receive a named
503 hold instead of a misleading total when reconciliation is pending.

Each tariff contains:

| Field                               | Meaning                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- |
| `mode`                              | `standard`, `free`, `at_cost`, or `custom`                                  |
| `collection_mode`                   | `stripe`, `manual`, or `none`; independent of usage rating                  |
| `markup_percent` (operator write)  | Exact decimal percentage string; `"20.00"` means 20%                       |
| `markup_bps` (stored/read)          | Internal basis points; 2,000 means 20.00%                                   |
| `monthly_subscription.amount_minor` | Flat monthly charge or per-seat monthly unit price in currency minor units; `"0"` means no monthly charge |
| `monthly_subscription.currency`     | Three-letter uppercase ISO-style currency code                              |
| `monthly_subscription.charge_basis` | `flat` for one scoped monthly charge or `per_seat` for each eligible human seat |
| `monthly_subscription.seat_policy` | For per-seat plans, `automatic` active human members or `fixed` purchased capacity |
| `monthly_subscription.seat_charge_timing` | For per-seat plans, `full_month` or `prorated` UTC membership/capacity intervals |
| `usage_payment_mode`                | `pay_as_you_go` or `prepaid`; independent of the monthly charge               |

Existing immutable tariff versions retain `flat` and `pay_as_you_go` through
the additive migration. Newly configured plans must explicitly choose their
monthly charge basis and usage payment mode. The Admin creation default is
`prepaid`, and a team or organisation assignment continues to determine the
payer scope. A per-seat amount is the price of one eligible seat per month;
the Admin form enters that amount in natural currency units and converts it
exactly to the integer `amount_minor` write contract. New per-seat forms
default to automatic quantity with prorated seat changes. Per-seat terms are
forbidden on flat plans; historical flat tariffs retain null seat terms. Fixed
purchased capacity belongs to each scoped subscription, not to the reusable
tariff. Seat quantity evidence is separate from usage credits.
Each active per-seat agreement has one exact Stripe subscription or manual
contract service-term source, frozen scope, tariff version, unit price, seat
policy and charge timing. Activation captures the current UOA human roster at
that instant; it never treats historical membership creation timestamps as
billing intervals. Automatic billing stores effective-dated UOA membership
intervals once per subject per subscription, so organisation seats deduplicate
the same person across teams. Fixed billing stores explicit positive capacity
revisions; pending invitation capacity and grant enforcement use the effective
revision under an account/scope lock. A missing activation baseline or capacity
revision holds the seat quote.

`quoteMonthlySeatCharge` uses the actual UTC month duration. For automatic
prorated seats it sums each person's non-overlapping active milliseconds,
including leave and rejoin. Full-month automatic counts every person with any
active overlap once. Fixed prorated seats integrate purchased quantity over
time; fixed full-month charges the highest capacity effective in the month,
so increases apply that month and decreases first reduce the following month.
The full month's exact numerator is rounded only once to currency minor units.
The quote retains interval/revision IDs for immutable invoice evidence. A
future manual contract captures the current roster when its terms are scheduled
and tracks changes until its distinct commercial effective month. It never
backfills an uncaptured past roster. A scheduled fixed capacity constrains new
admissions immediately, even though its monthly charge starts at the future
commercial boundary. Manual activation freezes the per-seat terms and explicit
fixed quantity in its service term; Stripe Checkout freezes the fixed quantity
in the customer action, local lease and Stripe metadata. The first verified
active Stripe projection captures the UOA baseline at the observed database
time; terminal evidence closes it once. A missing baseline, unclosed month, or
unproven Stripe billable period holds the finalized quote. The canonical cycle
snapshot must freeze this quote before either Stripe invoice delivery or manual
invoice issue; a live quote alone is never collection authority.
The existing Admin Billing → Contracts → Activate version doorway collects each
service's monthly flat fee or per-seat unit price in natural currency units,
converted exactly to stored minor units, automatic or fixed quantity
policy, full-month or prorated timing, and independent prepaid or pay-as-you-go
usage mode. Fixed terms require an explicit purchased quantity. Activation
readback labels a per-seat amount as a unit price and shows the saved capacity
and payment mode. New operator terms default to prepaid; an older two-field
activation request retains flat/pay-as-you-go semantics on replay. This
operator action rechecks the superuser role and token epoch inside the final
terms transaction, including idempotent replay.
When a later manual term replaces a fixed-capacity agreement, the old
agreement's immutable commercial end removes its admission limit exactly at
the boundary even if the evidence-ending sweep runs later. A newly scheduled
fixed agreement constrains admission from its roster-capture time.
The always-on seat transition scheduler closes the old evidence at its later
observed sweep time, preserving the exact boundary and interval history.

The manual invoice calculator uses the closed-month per-seat quote for its
subscription line, never the per-seat unit price as a whole invoice fee. It
excludes prepaid runtime usage from the manual pay-as-you-go total while
retaining the raw Ledger snapshot reference for audit.

Prepaid usage is funded from the existing scoped credit account before a paid
provider dispatch. It cannot become a positive Stripe usage-meter export when
credits are exhausted or provider liability remains unresolved; the monthly
subscription charge remains separate.

Ledger uses a separately issued, product-bound runtime key for prepaid
admission. A superuser provisions and revokes keys through
`/internal/admin/billing/ledger-runtime-keys`; creation returns the secret
once. Each key pins the product, exact Ledger audience, and original product
source domain. The reserve request carries the original short-lived UOA
delegation with `ai.invoke`, its live subject/team and credential epoch, an
immutable physical dispatch ID, start time, request fingerprint, provider
service ID, and an exact raw-cost upper bound. UOA rechecks the subject on
every POST, including replay, and freezes the tariff, payer account, and UTC
month. A null bound is permitted only to obtain a durable pay-as-you-go mode
decision; prepaid admission rejects it. Prepaid credits support USD without
inventing currency conversion. A billable call may reach the provider only
after the reservation response is confirmed.
Admission holds the live user, organisation, and team membership rows through
its final transaction so credential-epoch and membership revocations serialize
with the decision. The runtime key is rechecked and locked at final admission;
revocation between account resolution and reservation creation refuses the call.
A free tariff remains customer-free even when its raw
provider receipt records a positive cost.

`GET /billing/v1/ledger/reservations/:dispatchId` lets the product-bound
runtime key recover a committed decision after a lost HTTP response. If
absent, Ledger's no-egress release creates a durable cancellation tombstone
under the same dispatch lock, so a delayed reserve cannot strand funds. An
unresolved paid provider attempt retains its reservation; elapsed time never
releases it. Settlement accepts only Ledger's authenticated immutable receipt,
checks actual cost against the frozen bound, and debits the credit account
through an append-only `PREPAID_USAGE` entry linked to the exact reservation.
The account-wide cumulative rated numerator carries sub-microcredit remainders
across dispatches, tariff versions, teams, and months; each new debit is the
delta of the cumulative liability rounded up once to a microcredit. Per-call
reservation bounds round up separately for safety, but do not determine the
customer's debit. Pending holds reduce available credits without changing
confirmed balance. The old portfolio credit allocator and Stripe usage meter
exclude prepaid usage; invoice closure requires complete Ledger usage and
matching settled raw-cost receipts.

Mode rules:

- `standard` and `custom` may apply a non-negative markup.
- `at_cost` fixes markup at zero and bills usage at 100% of provider cost. It may
  still include a monthly subscription.
- `free` fixes markup and monthly subscription to zero and disables usage
  billing. It always uses `collection_mode = none`.

Collection rules:

- `stripe` means the later Stripe subscription/invoice integration is expected
  to collect payment.
- `manual` means payment is expected but is collected outside the automated
  Stripe flow.
- `none` means no payment is collected. Private rating remains active for any
  non-free tariff, so `usage_billing_enabled` can be true while
  `payment_collection_enabled` is false.
- `at_cost + none + monthly_subscription.amount_minor = "0"` is an internal
  tariff combination that collects no payment; it does not display cost basis.
- Pricing mode and collection mode are separate immutable tariff-version terms.
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

## Raw usage and customer price presentation

Raw provider usage is immutable accounting evidence. Token counts, search
requests, storage bytes, and other metered quantities must never be overwritten
or relabeled to represent markup.

UOA rates selected raw provider cost internally using the immutable commercial
term for the billing month. A US$10.00 raw cost at the internal 30% standard
rate yields a US$13.00 customer usage charge, or 13,000 prepaid credits at
1,000 credits per US dollar. Customers see only their original usage units,
credit consumption, exact customer charge, monthly subscription price and
billing scope. Customer statements, Checkout and subscription summaries never
include raw provider cost, cost basis, markup, price multiplier, or derived
billable units. Signed product entitlement snapshots retain only the tariff
identity needed for UOA's Checkout binding, collection and usage-billing flags,
monthly subscription price, and assignment scope. Product backends do not rate
usage; UOA's private Ledger and tariff data remain the financial authority.
Statement adjustment rows use generic customer labels because operator-entered
internal adjustment names are not classified as customer-safe copy.

## Individual product credentials

Every connection from an application to UOA uses that application's own billing
app key. Keys must not be shared between products or reused as a general
platform credential. Multiple independently deployed callers for one product
should receive separate named keys so they can be revoked and audited
independently.

An app key:

- starts with `uoa_app_`;
- is returned in plaintext only when created;
- is stored only as a keyed digest plus a display prefix;
- is bound to exactly one billing service;
- has exactly one endpoint purpose: `entitlement` or `customer_lifecycle`;
- may expire and may be revoked immediately;
- is bound to one actor issuer, actor audience, RS256 public JWK, and `kid`.

Purpose is enforced by middleware and by database constraints, not caller
convention. An `entitlement` key can call only
`POST /billing/v1/effective-tariff` and must have no redirect origins. A
`customer_lifecycle` key can call only direct-session access confirmation, the
canonical customer statement, Stripe Checkout, summary, portal, and
cancellation routes, plus the UOA-owned credits and recurring-add-on customer
surface, and must have at least one exact HTTPS return origin. No key can cross
those endpoint classes. Every request also requires its
credential-bound actor assertion, and the body product must exactly equal the
service bound to the key.

The app key authenticates the calling product. It does not identify the user.
Each lookup therefore also carries an independently signed actor assertion.
Webhook signing secrets remain a separate credential class and must never be
used as product request API keys (or vice versa).

## Durable customer-action authorization

Every customer-triggered commercial mutation crosses one UOA-owned durable
authorization boundary at the first real effect, after frozen-action and
domain-state validation but before UOA creates, changes, or cancels a Stripe
object or applies a local monetary transition. Invalid requests, already-
satisfied no-ops, and idempotent completed/processing replays do not append
unbounded authorization evidence. `BillingCustomerActionIntent` stores only
the exact product/app, user, organisation, team, required manager scope,
operation, actor `jti`, actor credential epoch and expiry, and a canonical
request digest. It never stores an
actor bearer, return URL, preview token, Stripe secret, amount supplied by a
product, or raw Ledger fact.

The insert trigger is the linearization point. In a deterministic order it
locks the lifecycle app key, billing service, user, organisation, requested
team, organisation membership, and team membership, then independently
requires an active, wall-clock-unexpired `customer_lifecycle` key, active
service, an unexpired actor whose stored credential epoch still equals the
locked user's `token_version`, exact team/org binding, active memberships, and
current owner/admin authority for the
operation's organisation or team scope. Concurrent app-key revocation,
membership removal, deactivation, or role downgrade therefore commits either
before the intent and rejects it, or after an already-authorized action. The
row is append-only, forced-RLS commercial evidence unavailable to `uoa_app`.
Cancellation and recurring-add-on cancellation insert it in the same
transaction as the first `AVAILABLE` to `PROCESSING` claim; automatic top-up
update/disable insert it only after the locked predecessor checks and
immediately before their domain effect.

The product must reuse the same actor assertion and `jti` when retrying one
logical HTTP action after a transport failure. UOA then returns the existing
intent only when its complete digest and scope binding match; rebinding the
same action conflicts. The generic row is the pre-effect authorization proof,
not a replacement for stronger domain state machines. Checkout, Setup
Checkout, recurring-add-on cancellation, base cancellation, auto-top-up
attempt, and invoice-event rows remain the durable effect intents. Stripe
mutation idempotency is derived from the relevant durable domain intent (or,
for Portal, the customer-action intent); stable customer/catalog creation is
derived from its durable local resource row. Lost responses therefore replay
the same Stripe request instead of creating another charge or subscription.

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

- protected header `alg=RS256` and the app key's configured `kid`;
- exact configured `iss`;
- `aud` equal to the exact endpoint being called —
  `${PUBLIC_BASE_URL}${request path}`, so `.../billing/v1/effective-tariff` here
  and a different value at every other billing endpoint. One constant audience
  reused across endpoints is the legacy shape: accepted only while the
  deployment runs `BILLING_ACTOR_AUDIENCE_MODE=warn`, logged on every use, and
  refused under `enforce` with `BILLING_ACTOR_AUDIENCE_MISMATCH`. See
  [`Docs/Auth/billing-actor-assertions.md`](../Auth/billing-actor-assertions.md);
- `sub = user_id`;
- claims `product`, `organisation_id`, and `team_id` exactly matching the body;
- non-negative integer `tv` equal to the UOA access-token credential epoch from
  which the product established this exact SSO session;
- non-empty `jti`;
- integer `iat` and `exp`, with a maximum lifetime of 60 seconds.

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
      "collection_mode": "stripe",
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

- has protected header `alg=RS256`, a rotation-safe `kid`, and
  `typ=uoa-tariff+jwt`;
- uses UOA's `PUBLIC_BASE_URL` as issuer;
- uses the calling credential's actor issuer as audience;
- uses the UOA user ID as subject and the snapshot ID as `jti`;
- expires after five minutes;
- contains the exact response payload plus standard JWT claims.

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

| Method and path                                                                | Purpose                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `GET /internal/admin/billing/services`                                         | List services, versions, assignments, and app-key metadata                                                               |
| `POST /internal/admin/billing/services`                                        | Create a service and its initial default tariff                                                                          |
| `POST /internal/admin/billing/services/:serviceId/tariffs`                     | Append a tariff version; optionally make it default                                                                      |
| `PUT /internal/admin/billing/services/:serviceId/default-tariff`               | Move the service default pointer                                                                                         |
| `PUT /internal/admin/billing/services/:serviceId/assignments`                  | Upsert an organisation or team assignment                                                                                |
| `DELETE /internal/admin/billing/services/:serviceId/assignments/:assignmentId` | Remove an override and fall back through precedence                                                                      |
| `GET /internal/admin/billing/services/:serviceId/app-keys`                     | List credential metadata, never plaintext secrets                                                                        |
| `POST /internal/admin/billing/services/:serviceId/app-keys`                    | Mint a product-bound key and bind its actor verification key                                                             |
| `DELETE /internal/admin/billing/services/:serviceId/app-keys/:keyId`           | Revoke a product credential                                                                                              |
| `POST /internal/admin/billing/stripe/usage-exports`                            | Fetch/replay one immutable Ledger subscription-month snapshot and idempotently export its customer-money delta to Stripe |

Every mutation writes the existing global admin audit log. Tariff and credential
tables are denied to the tenant runtime database role and accessed only through
the bypass-RLS admin connection.

The Admin `/billing` screen is the operator surface for this control plane. It
lists product services, immutable tariff versions, scoped assignments, masked
purpose-bound app keys, Stripe catalog readiness, and test/live subscription
state. It can create services with a safe `at_cost + none` default, append
versions, move defaults, assign org/team tariffs, and mint/revoke keys. A new
key's plaintext appears once in a non-recoverable reveal dialog.

## Stripe collection foundation

Stripe resources are projections of UOA commercial truth:

- UOA remains the tariff and entitlement source of truth.
- UOA remains the subscription, statement, rated-charge, and customer-action
  source of truth.
- Ledger remains the immutable raw-usage, raw-provider-cost, and attribution
  source of truth.
- Stripe is a payment processor, not an identity, tariff, or usage authority.
- Every UOA-rated charge records the immutable tariff version and signed raw
  snapshot used.
- Free and at-cost exceptions remain explicit tariff modes, not hidden Stripe
  discounts.
- `collection_mode` controls payment orchestration without changing rating:
  `stripe` is automated collection, `manual` is externally collected, and
  `none` collects nothing.
- Each product continues to use its own app key.

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
`customer_lifecycle` `X-UOA-App-Key` plus its fresh credential-bound
`X-UOA-Actor`. The user must be an active owner/admin at the selected billing
scope. A team tariff override creates a team-scoped subscription; an
organisation assignment or service default creates an organisation-scoped
subscription. Return URLs must use an exact HTTPS origin allowlisted on that
individual app-key record.

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

- an immutable licensed monthly Price for a flat tariff when its monthly amount
  is non-zero; a per-seat tariff keeps its unit price in UOA and has no licensed
  quantity-one Stripe item;
- one metered Price for rated customer money;
- a calendar-month billing anchor aligned to Ledger's UTC month;
- no promotion codes, because discounts must be explicit UOA tariff versions.

The hosted Checkout sets Stripe's billing-cycle anchor to the first day of the
next UTC month and sets `proration_behavior=none`. The partial alignment period
between Checkout and that boundary is free for legacy flat subscriptions.
Per-seat liability is computed by UOA from frozen terms and effective-dated
membership or purchased-capacity evidence, then collected on a subsequent
calendar-cycle invoice. Stripe's live item quantity and proration cannot
replace that evidence. Automatic seats count unique active humans across the
subscribed scope; fixed seats charge contracted capacity. `FULL_MONTH` counts
any active automatic seat once and the greatest fixed capacity in the month;
`PRORATED` sums exact UTC interval overlap and rounds once at the final
currency minor unit. Checkout freezes an explicit positive purchased quantity
only for a fixed per-seat tariff. Later renewals remain calendar-aligned.
This follows Stripe's documented
[billing-cycle anchor](https://docs.stripe.com/billing/subscriptions/billing-cycle)
and [no-proration](https://docs.stripe.com/billing/subscriptions/prorations)
semantics. Subscription webhooks are verified against the exact raw request
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
tombstones an existing local row. A flat subscription must contain exactly the
UOA monthly item (quantity one, when non-zero) and one metered usage item. A
per-seat subscription contains only the metered usage item; its exact monthly
fee is attached to the draft invoice after UOA closes and freezes the prior
month's seat evidence. No extra/duplicate items or subscription- or item-level
discounts are accepted.

### Customer subscription lifecycle API

Customer applications use the same exact product, organisation, team, user,
app-key, and actor binding for all lifecycle operations:

| Method and path                                | Behaviour                                                                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /billing/v1/stripe/subscription-summary` | Returns the effective tariff, assignment, `can_manage`, collection gate/mode, and a safe local subscription projection with no Stripe IDs |
| `POST /billing/v1/stripe/portal-session`       | Creates a Stripe-hosted portal session after billing-manager and exact return-origin checks                                               |
| `POST /billing/v1/cancellation/preview`        | Returns the complete confirmation model and an opaque, short-lived token for exact direct subscriptions                                   |
| `POST /billing/v1/cancellation/confirm`        | Revalidates and idempotently schedules cancellation for the preview's exact selected direct subscriptions                                 |

Summary is useful even while collection is disabled: it returns
`stripe_collection_enabled=false` and the last single account-scoped local
projection. If more than one account projection could match, it returns
`STRIPE_SUBSCRIPTION_ACCOUNT_AMBIGUOUS` instead of guessing. Portal and
cancellation preview/confirmation remain unavailable while the process gate is
off. The
`subscription.billing_phase` field is `free_alignment_period`,
`calendar_month`, or `unknown`.

### Ledger collection and Stripe meter units

UOA calls `GET /v1/metering/usage?group_by=service` with:

```http
X-Ledger-App-Key: <UOA's dedicated Ledger raw-metering reader app key>
X-UOA-Service-Assertion: <short-lived RS256 service JWT>
```

The app key authenticates UOA as the calling application. The assertion
independently binds that exact key ID to `scope=metering.read`, the billed
product, organisation, optional team, and one UTC billing month. Ledger
verifies it through UOA's rotation-safe
`GET /billing/v1/service-jwks.json`; those keys are not tariff-snapshot,
OAuth-resource-token, product-app-key, or webhook keys.

Ledger's `metering-usage-v1` response is an immutable raw snapshot. UOA
validates its exact product, scope, calendar boundaries, grouping, string
quantities/costs, and immutable snapshot identity before rating anything.
Commercial fields are rejected. UOA applies the pinned immutable tariff to raw
provider cost, producing each exact major-currency customer charge. UOA then
converts it to an integer count of
`10^-6` minor-currency units and sends only the delta since the previous
snapshot to Stripe's sum meter, using a stable idempotent event identifier.
Stripe therefore meters rated money—not tokens, searches, or research runs.
Raw facts remain in Ledger; UOA projects only raw usage and customer charge
totals to product UIs.

Snapshot cursors and cumulative/delta exports are stored so retries can be
replayed and audited. If a corrected liability is lower than the amount already
accepted by Stripe, UOA holds the export for reconciliation; it does not send
an unverified negative meter event or rewrite prior raw usage.

### Recurring export, safety pass, and invoice reconciliation

When `STRIPE_BILLING_ENABLED=true`, each API process starts the recurring usage
export scheduler. Cloud Run is configured with one warm instance and
non-throttled CPU in that mode; idempotent database export state and stable
Stripe meter identifiers make overlapping retries safe.

The scheduler:

- polls every `STRIPE_USAGE_EXPORT_INTERVAL_MINUTES` (default 60);
- selects only current, non-terminal subscriptions whose active service and
  immutable tariff still use `collection_mode=stripe` and a non-free mode;
- exports only exact full UTC calendar-month periods;
- deliberately skips the initial free alignment stub;
- reports any other non-calendar period as
  `STRIPE_BILLING_PERIOD_NOT_CALENDAR_ALIGNED` instead of silently making it
  free;
- once a boundary falls inside
  `STRIPE_PRE_BOUNDARY_SAFETY_LEAD_MINUTES`, schedules an additional safety
  export `STRIPE_PRE_BOUNDARY_SAFETY_OFFSET_MINUTES` before period end.

Each run calls the same immutable-cursor, cumulative-delta export path as the
superuser reconciliation endpoint. The pre-boundary pass is not final because
usage can still arrive between it and period end.

For the authoritative post-period reconciliation, the signed
`invoice.created` webhook retrieves the current Stripe invoice and acts only on
a draft, automatically collected `subscription_cycle` invoice whose
subscription, customer, currency, account/mode, and exact just-ended UTC
calendar period match the local immutable projection. The current invoice must
also expose an `automatically_finalizes_at` at least one hour after `created`;
an absent, shorter, or custom-early window fails closed with
`STRIPE_INVOICE_GRACE_PERIOD_INSUFFICIENT`. UOA then fetches a fresh Ledger
snapshot and sends any remaining cumulative delta with a meter timestamp inside
the ended service period. Only after that succeeds does UOA commit the webhook
event and return success. A Ledger, database, or Stripe failure leaves the
event uncommitted and returns a failure so Stripe retries and delays automatic
finalisation. Stable cursor/delta records, meter identifiers, and Stripe
idempotency keys make lost-response retries safe.

This uses Stripe's invoice finalization grace period, during which
subscription-cycle draft invoices include prior-period usage reported before
finalisation. The default is one hour, and a failed `invoice.created` delivery
can delay finalisation for up to 72 hours. UOA also handles
`invoice.finalization_failed`: it records the signed event, logs the invoice ID,
automatic-tax status, and structured finalization error, and re-runs the same
post-period export when the invoice remains a valid draft cycle invoice.
Successful meter-event creation proves durable delivery, not immediate
aggregation visibility: Stripe processes meter events asynchronously and
recomputes the draft invoice at finalisation. Test evidence must inspect the
finalized invoice, not merely the meter-event response. See
Stripe's [grace-period guidance](https://docs.stripe.com/billing/subscriptions/usage-based/configure-grace-period)
and [subscription webhook guidance](https://docs.stripe.com/billing/subscriptions/webhooks).

### Launch gate

Code deployment is not permission to collect money. Production collection
remains blocked until all of the following are demonstrated:

1. distinct live Stripe API and webhook secrets are provisioned;
2. UOA has its own revocable Ledger billing-reader app key;
3. Ledger trusts only UOA's dedicated service-assertion JWKS and exact key ID;
4. per-product app keys and Checkout return origins are provisioned separately;
5. recurring current-month polling, the pre-boundary safety pass,
   authoritative `invoice.created` post-period reconciliation,
   `invoice.finalization_failed` handling,
   the free initial alignment period, calendar-month renewal, cancellation,
   webhook retries,
   correction reconciliation, and immutable-cursor replay are exercised in Stripe
   test mode;
6. invoices visibly reconcile UOA tariff terms and Ledger customer charges.

Stripe meter processing is asynchronous. The scheduler is deployed but inert
while the safety gate is false. Test-mode evidence for the full lifecycle and
an explicit production configuration review remain mandatory before enabling
live collection; a manually successful export alone is insufficient.

## 2026-07-20 canonical statement and raw-metering contract

This section is the authoritative cross-product statement and raw-metering
contract. The lifecycle and export descriptions above use the same boundaries.

### System-of-record boundary

UOA is the only commercial billing engine and system of record. It owns:

- immutable tariff terms and assignment precedence;
- privately rated customer charges, exact totals, and
  currencies;
- monthly subscriptions, add-ons, credits, collection state, and customer
  actions;
- direct product-access evidence and cancellation scope;
- the canonical customer statement and all display wording.

Ledger owns immutable metering facts only: token/API/SERP/research/provider
usage, provider-estimated or provider-actual cost, and exact
user/organisation/team/billing-product/caller-product/origin-product
attribution. Ledger must not return tariff, subscription, markup,
billable-unit, customer-charge, add-on, credit, payment, invoice, or
cancellation fields. Stripe is only the payment processor.

### Ledger raw-metering contracts

UOA calls:

```http
GET https://ledger.unlikeotherai.com/v1/metering/usage?group_by=service
GET https://ledger.unlikeotherai.com/v1/metering/usage?group_by=user
X-Ledger-App-Key: <UOA's dedicated metering-reader app key>
X-UOA-Service-Assertion: <short-lived RS256 service JWT>
```

The service assertion binds the exact UOA key ID, product, organisation,
optional team, UTC month, and `scope=metering.read`. Its protected-header type
is `uoa-billing-service+jwt` and its subject is `uoa-metering-reader`. The
shared type is Ledger's dedicated machine-to-machine billing assertion
contract; the `metering.read` scope and reader subject narrow this credential
to raw metering collection.
Ledger's public Draft 2020-12 schema is
`https://ledger.unlikeotherai.com/schemas/metering-usage-v1.json`.

UOA accepts only schema version 1 with exact string quantities and costs, the
requested scope/grouping, and an immutable `mus_…` snapshot whose `id` equals
its `cursor`. UOA reads at most two mebibytes, rejects redirects and malformed
UTF-8, hashes the exact response bytes, and pins
`cursor`/`id`/`capturedAt`/SHA-256 in the customer statement. Unknown or
commercial fields fail closed.

For `BillingStatementV2`, UOA instead calls the team-wide portfolio endpoint
once:

```http
GET https://ledger.unlikeotherai.com/v1/metering/portfolio?group_by=user
X-Ledger-App-Key: <UOA's dedicated metering-reader app key>
X-UOA-Service-Assertion: <short-lived RS256 service JWT with view=team_portfolio>
```

The exact organisation and team are mandatory. The asserted product is the
statement perspective, not a Ledger filter. Ledger returns every billing
product for that team and UTC month as immutable `metering-portfolio-v1`
rows in one user-grouped snapshot with an `mup_…` ID/cursor. UOA validates and
hashes those exact bytes, rates only rows whose billing product matches the
requested statement product, and derives service, origin, and per-user totals
from that same pinned snapshot. This guarantees that all displayed shares and
the commercial rating use one self-consistent raw fact set. Stripe export
remains product-scoped on `metering-usage-v1`; the portfolio never broadens a
charge or subscription.
Ledger publishes the strict schema and synthetic cross-product fixture at
`https://ledger.unlikeotherai.com/schemas/metering-portfolio-v1.json` and
`https://ledger.unlikeotherai.com/schemas/metering-portfolio-v1.example.json`.
UOA's collector tests pin that fixture, including the mandatory team scope and
intentional absence of `userId`.

Ledger's raw contract exposes an exactly aggregatable selected provider cost
as `rawProviderSelectedCost`; its row-level rule is actual cost when present,
otherwise estimated cost.
This prevents estimate-only rows from disappearing when one aggregate group
also contains actual-cost rows. For Stripe usage export, UOA consumes that raw
selected cost, aggregates by caller and currency, applies the immutable tariff
multiplier centrally, then converts the resulting exact major-currency amount
to Stripe's integer micro-minor meter quantity. Ledger never rates the customer
amount.

Legacy caller/origin attribution may be `null`. V2 preserves that fact and
renders the origin as `Unattributed origin`; it never fabricates a product,
direct-access record, or cancellation choice. Frozen V1 projects a null
caller/origin to the string `unattributed` only inside its display-only
`usage.lines[].attribution` field for compatibility.

### Canonical public customer contract

The v1 and v2 route names remain while their privacy-revised protocol shapes
require strict consumers to update together:

| Method and path                                         | Behaviour                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /schemas/billing-statement-v1.json`                | Public Draft 2020-12 schema for the exact response                                                                                                                             |
| `GET /schemas/billing-statement-v1.example.json`        | Synthetic, credential-free conformance statement for consumer tests                                                                                                            |
| `GET /schemas/billing-statement-v1.openapi.json`        | OpenAPI 3.1 component embedding the exact schema and conformance example                                                                                                       |
| `GET /schemas/billing-statement-v2.json`                | Public Draft 2020-12 schema for the v1 commercial statement plus UOA's team-wide connected-service portfolio                                                                   |
| `GET /schemas/billing-statement-v2.example.json`        | Synthetic, credential-free fixture demonstrating service, origin-product, and per-user transparency                                                                            |
| `GET /schemas/billing-statement-v2.openapi.json`        | OpenAPI 3.1 component embedding the exact v2 schema and fixture                                                                                                                |
| `GET /schemas/billing-consumer-actions-v1.json`         | Public Draft 2020-12 components for normalized hosted redirects, cancellation selection/preview/confirm, and the minimal error envelope                                        |
| `GET /schemas/billing-consumer-actions-v1.example.json` | Synthetic, credential-free fixtures for every billing consumer-action message                                                                                                  |
| `GET /schemas/billing-consumer-actions-v1.openapi.json` | OpenAPI 3.1 components embedding the exact action schemas and fixtures                                                                                                         |
| `POST /billing/v1/service-access/confirm`               | Records one direct product session after exact product-key, actor, and active membership verification                                                                          |
| `POST /billing/v1/customer-statement`                   | Display-ready current/past-month plan, subscription, raw usage, customer charges, cross-service and per-user attribution, commercial lines, exact totals, capabilities, and actions |
| `POST /billing/v2/customer-statement`                   | The same UOA-owned commercial statement plus complete display-ready totals, origins, and users across all services connected to the exact team                                 |
| `POST /billing/v1/cancellation/preview`                 | Complete confirmation-dialog model plus opaque five-minute token and server-generated idempotency key                                                                          |
| `POST /billing/v1/cancellation/confirm`                 | Locked, revalidated, idempotent confirmation for the preview's exact pinned direct subscriptions                                                                               |

All POSTs require the calling product deployment's individual
`customer_lifecycle` app key and a fresh RS256 `X-UOA-Actor` whose product,
user, organisation, and team exactly match the body. The actor lifetime is at
most 60 seconds and its audience is the exact audience stored on the app key.
Product backends inject both credentials; browsers receive neither.
The canonical UOA and Ledger product identifiers are `nessie`, `deepwater`,
`deepsignal`, `deeptest`, and `docgen`. Hyphenated repository or application slugs are
mapped at the product boundary and are never sent in billing subjects.

Products render `BillingStatementV1` or `BillingStatementV2` unchanged. New
consumers use v2. Package 4.0.0, V1 protocol 4.0.0, and V2 protocol 5.0.0
retain the route names but remove the public pinned tariff identity, which is
private financial authority. Consuming products must update their strict
validators before the producer switches. Products must not derive tariff copy,
totals, usage shares, customer charges,
cancellation scope, or action choices. The three action
IDs and fixed routes are:

- `upgrade` → `/billing/v1/stripe/checkout-session`;
- `portal` → `/billing/v1/stripe/portal-session`;
- `cancel` → `/billing/v1/cancellation/preview`.

The customer plan and Checkout tariff include safe `charge_basis`, `seat_policy`,
`seat_timing`, `amount_role`, and `usage_payment_mode`. A `per_seat_unit`
`amount_minor` is the monthly price of one seat, never the customer's total.
The frozen seat quote supplies a closed period's financial subscription line;
an open per-seat statement leaves that line pending rather than displaying the
unit price as a charged total. Provider cost, margin, and markup stay private.

The statement supplies the request body, including server-pinned
allowlisted return URLs. For a fixed-seat plan, a product appends only the
customer-selected `fixed_seat_quantity` (integer 1 to 1,000,000); UOA enforces
that it is required only for this plan. A product may whitelist these ID/path
pairs and proxy the supplied body, but must reject unknown actions. The old
`POST /billing/v1/stripe/subscription/cancel` route no longer exists.

The versioned, MIT-licensed
`packages/billing-statement-protocol` team is UOA's canonical TypeScript
source and is safe to publish, pack, or vendor into an open-source consumer. It
exports only protocol constants, types, JSON Schema, OpenAPI 3.1 components,
and synthetic fixtures for `BillingStatementV1`, `BillingStatementV2`, and the
complete customer-action protocol. The action objects are exact
(`additionalProperties: false`) and include the normalized hosted redirect,
cancellation selection, preview with fixed confirm method/path, confirm
request/response, and minimal error envelope.
It has no UOA server imports, credentials, or tenant data. The API imports this
package rather than maintaining a private duplicate. Build and package tests
fail when any committed JSON artifact drifts from the typed source. Until
registry publication is approved, consumers may vendor the whole package
directory or fetch the public artifacts above. The same package defines
`BillingCyclesV2` (protocol 2.1.0): exact product/selected-team monthly history,
customer subscription and measured usage details, credit application, true
payment documents and explicit later adjustments. The selected-team request
can also return a separate organisation-wide subscription/document cycle to
current organisation billing managers. Its `scope.team_id` is null and
`scope.cycle_scope` is `organisation`; team usage remains in team-scoped
cycles, even if the organisation pays for it. The month-and-scope cursor keeps
both records visible without duplicating the organisation subscription fee
in team totals. The cycle read does not
create a payment invoice. Only an available, persisted document receives a
server-authored download action; open and unreconciled periods cannot claim a
final invoice. Prepaid usage consumption is not a second payment invoice.
For a closed source month, `prepareBillingCycleClose` freezes the contractual
subscription quote and complete immutable Ledger coverage in a pending cycle.
It holds unresolved paid attempts, missing paid costs, currency mismatches and
quote drift. Pending credits are represented as unknown, never zero. This
preparation does not create a payment invoice, mark liability paid, or make
documents downloadable; those transitions require verified collection and
credit evidence in a later immutable revision.
If Ledger adds a late receipt before finalization, preparation appends a new
pending revision and retains the original snapshot. A late receipt after
finalization holds for a separately evidenced financial adjustment. Customer
seat intervals are clipped to the immutable commercial effective/end and
termination window used by the monetary quote.
Replay comparison uses the exact receipt facts, not a new signed Ledger
assertion's cursor, capture time or response hash. A zero-monthly-charge team
without a subscription source can still prepare its own pending measured-usage
cycle from the historically effective tariff and payer; unresolved historical
terms, payer changes and paid costs hold it. This path never checks current
team membership to attribute old usage. Downloaded CSV includes per-seat unit
price/policy/timing, customer charges, paid/outstanding totals and credit
boundaries; spreadsheet formula prefixes are neutralized. PDF labels pending
totals honestly and wraps long source identifiers within the page.

`BillingStatementV1.capabilities` describes UOA-owned billing actions only. A
product runtime capability such as `can_be_private` is not inferred from a
tariff key, mode, local subscription row, or this display contract. It uses
UOA's existing per-App feature-flag resolver
(`GET /apps/:appId/flags?domain=…&userId=…&teamId=…`) through that product's own
domain-hash backend credential and fails closed unless the exact flag is
`true`. The App path value is opaque `App.id`, the domain is the product's
registered config domain, and user/team values are exact UOA IDs. Automatically
bundling a feature with a tariff requires an explicit UOA tariff-to-feature
policy; consumers must never recreate that mapping locally.

### Direct versus indirect access

`billing_service_accesses` is UOA-owned entitlement evidence confirmed only
after a product's own app key and actor have passed membership checks. Every
product backend MUST call `POST /billing/v1/service-access/confirm` immediately
after its own successful UOA SSO exchange or direct session establishment. The
route requires that product's `customer_lifecycle` key and fresh actor, rechecks
the exact active organisation and team memberships, and records the exact
service, organisation, team, and user transactionally. Statement and
cancellation reads count only users whose organisation and team memberships
remain active.

Proxy or agent use of another product MUST NOT call the confirmation route for
that other product. Ledger metering can identify another product as caller or
origin for statement attribution, but that is `indirect` access and never
creates or implies a direct entitlement.

Cancellation preview considers active same-account subscriptions only when at
least one currently active member of the exact organisation/team has an
active, non-revoked direct-access record for that exact service. It offers
`current_and_related_direct_services` only when such a related subscription
exists on the current subscription's Stripe account. A direct record from any
active team user is sufficient; missing, empty, revoked, inactive-membership,
inactive-service, other-team, or other-account evidence is not. Ledger-only
indirect services are listed for explanation but never become a cancellation
choice. With no eligible related direct subscription, the only default is
`current_service`. UOA stores only the SHA-256 digest of the opaque
preview token, pins exact service/subscription IDs plus entitlement and
subscription fingerprints, and confirms under a serializable row lock. A token
is short-lived and single-use; the matching idempotency key and selection may
resume or replay a completed result without repeating the customer-visible
operation.

### Add-ons and credits

`billing_commercial_adjustments` stores UOA-owned organisation/team add-ons and
credits as non-negative integer minor-currency values. Sign is derived from
kind, never accepted as ambiguous input. Lines are one-time or monthly with
explicit effective bounds, deactivated rather than deleted, and audited.
Deactivation records its exact time: already-effective lines remain visible in
historical statements, while future one-time lines cancelled before their
effective instant do not appear.
Applicable lines appear unchanged in the canonical statement. They are never
sent to or accepted from Ledger.

The funding foundation adds a distinct customer term, **Credits**. `Wallet` is
not a public or internal product concept. The conversion never varies by
service or tariff:

```text
1,000 credits = US$1.00
1 cent = 10 credits
1 credit = 1,000,000 internal microcredits
1 Ledger USD micro-minor = 10 internal microcredits
```

The older portfolio collector targets complete credits. Prepaid dispatch
settlement can debit an exact microcredit quantity. UOA retains sub-credit rated usage in the settlement's
exact micro-minor remainder until the same service/user bucket reaches another
whole credit. The older collector settles complete credits, while new prepaid reservations
can settle exact microcredit amounts. Public credit values therefore retain up to
six decimal places and their exact USD equivalents up to nine. The public
contract exposes credits, never internal microcredit counters, raw provider
cost, or private markup.

There is one exact-team credit account per Stripe account/mode and currency,
shared across all connected services. A product can present its own versioned,
fixed top-up offers, but a successful Stripe payment funds that same team
balance. Stripe Products/Prices may be reused when their immutable currency,
payment amount, and credit quantity match; product provenance remains the
calling service's individual `customer_lifecycle` app key and actor assertion.
The customer-facing heading is exactly **Remaining credits**.

UOA alone converts and settles Ledger raw usage into credits. Each settlement
pins one immutable team-wide, user-grouped Ledger portfolio snapshot. One
serializable shared-account transaction rates and settles every service in that
exact cursor, including previously settled services that disappear from a
corrected snapshot. The settlement and its corrections retain exact service,
user, and explicit unattributed allocations without asking Ledger to rate them.
Credit-account creation and portfolio settlement share one bounded serializable
retry policy with exponential full jitter, so concurrent product reads spread
out instead of retrying as a synchronized herd. Exhausted account creation and
settlement raise the internal codes `BILLING_CREDIT_ACCOUNT_RETRY_EXHAUSTED`
and `BILLING_CREDIT_SETTLEMENT_RETRY_EXHAUSTED`, respectively. The public error
handler returns a generic HTTP 503 without exposing either internal code or a
database failure.
Concurrent Ledger fetches can finish out of capture order. After taking the
shared account lock, UOA compares a new cursor with the latest committed
snapshot for that team and month. An authenticated snapshot captured at or
before that latest snapshot is superseded and becomes a successful no-op, so
the product reads the newest projection instead of receiving a database error
or rolling usage backwards. The database stale-snapshot trigger remains the
independent defense against any writer that bypasses this service decision.
Corrections release prior credits before deterministic largest-remainder
reallocation. New usage consumes only the non-negative available balance while
the full rated-but-unfunded liability is retained. Allocation and consumption
are performed in complete-credit units: a cumulative 1.08365-credit rated
amount consumes one credit and retains 0.08365 as unbilled remainder. A later
snapshot crossing the next whole-credit boundary consumes the next credit;
corrected or historical fractional consumption is released automatically by an
append-only correction. Only a verified credit-entry reversal can produce debt.
Same-cursor replay is idempotent, while content drift or a partial cursor
application fails closed. Origin-product
transparency remains in `BillingStatementV2`, derived from its separately
pinned portfolio. Products render UOA's prepared team balance, current-period
consumption, connected-service totals, and privacy-filtered attribution. They
must not duplicate balance, conversion, share, price, or billing-manager logic.

All connected services can expose manual top-up and bounded automatic top-up
through `BillingCreditsV1`. UOA supplies the complete fixed action for every
offer and auto-top-up option; the product whitelists its action/path and relays
the exact body unchanged. Auto-top-up records immutable consent revisions,
threshold, refill offer, monthly charge cap, payment-method proof, every system
attempt, and terminal Stripe evidence. Setup Checkout pins the expected consent
predecessor and account generation. Consent update or disable increments that
generation and abandons every open Setup Checkout under the account lock; a
late SetupIntent webhook can activate consent only with the exact predecessor
and generation through a compare-and-swap update. Attaching a newly created
Stripe session is itself a `CREATING`-state compare-and-swap, and the database
rechecks the locked predecessor on every actionable transition; `COMPLETE`,
`EXPIRED`, and `ABANDONED` Setup Checkouts can never reopen. Refunds and disputes create
exact debit entries and move an enabled auto-top-up account to review. Recovery
requires current Stripe PaymentIntent evidence for the exact attempt. A
replaceable failed intent is safely canceled and terminalized before UOA offers
a replacement Setup Checkout. Cancellation of that PaymentIntent uses the
durable attempt ID as its Stripe idempotency key. A requires-action intent with an unsafe redirect
is likewise canceled only after the returned object passes the complete binding
check, then CAS-terminalized before replacement. An executable action URL is
relayed only while it still matches the current intent. An ordinary active member cannot initiate a
top-up, set/update/recover auto-top-up, or alter consent; the database requires
an active organisation and exact-team billing manager for every
customer-initiated funding or consent mutation. Automatic attempts, Stripe
refunds/disputes, usage settlements, and superuser adjustments use their own
immutable system/admin proof instead of customer manager authority.
Failed or canceled refunds and reinstated disputes create explicit reversal
credit entries. Those entries restore only the principal that remains removed
after all refund and dispute evidence for the original payment is reconciled,
so overlapping adjustments cannot restore the same credits twice. Products
display those UOA-authored entries and the resulting remaining balance without
recalculating either value.

When the Stripe collection gate is enabled, UOA's billing scheduler polls for
exact-team credit accounts whose state is `ACTIVE` and whose locked balance is
below the threshold in their active immutable consent revision. Before it may
dispatch, one database transaction revalidates the current UOA policy, exact
product lifecycle app key/service, consent actor, option, refill offer,
account/mode catalog, fixed amount/credit conversion, and successful charges
already counted against the UTC monthly cap. The database repeats those checks
under the credit-account row lock. No caller supplies an amount, threshold,
payment method, service, user, or cap.

That transaction commits exactly one `PENDING` automatic-top-up attempt before
Stripe is called. A second transaction takes the same per-account PostgreSQL
advisory lock, locks the attempt and all immutable dispatch bindings, then
creates and confirms one off-session PaymentIntent using the consented customer
and payment method. The PaymentIntent carries only
`uoa_credit_auto_top_up_attempt_id`; its Stripe idempotency key is the attempt's
deterministic stored key. Concurrent API replicas therefore serialize per
account. If Stripe accepted the request but its response was lost, later polls
recover the same pending attempt and repeat the same idempotent request rather
than creating another attempt or charge. A returned or Stripe-error-embedded
PaymentIntent must match the exact amount, USD currency, mode, customer,
payment method, and reserved metadata before its ID is attached. Signed Stripe
webhooks remain the only path that changes attempt payment state or credits the
team balance; the scheduler never infers success from a create response.

The automatic-top-up poll uses `STRIPE_AUTO_TOP_UP_INTERVAL_MINUTES` (default
one minute) and shares the existing Stripe scheduler lifecycle. Turning
`STRIPE_BILLING_ENABLED` off prevents the scheduler from starting and makes a
direct non-test cycle fail before database or Stripe work.

Funding and subscription webhooks compare the signed event's reserved UOA
binding metadata with the freshly retrieved Stripe object. Funding bindings
always include the complete service, lifecycle app-key, and credit-account
fingerprint in addition to their local checkout, Setup Checkout, or automatic
attempt identifier; every local write, Stripe create/retrieve/cancel boundary,
and webhook comparison validates the complete fingerprint. An unrelated event
with no UOA markers is acknowledged, while removed, added, partial, or rebound
UOA metadata fails retryably and cannot consume the event id as an ignored event.
The webhook endpoint and Stripe SDK are pinned to API version
`2026-06-24.dahlia`. Immutable amount, currency, customer, payment-method,
charge, SetupIntent, refund, and dispute binding drift also fails retryably.
Invoice reconciliation events received while collection is disabled remain
unconsumed so an operator can replay/reconcile them before enabling collection.

The public credit view is a manager/member discriminated union. A manager may
receive per-user usage, payment-method display data, consent actor details, and
enabled funding actions. An ordinary member receives the shared remaining and
pending credit quantities, their own consumption, the aggregate consumption of
other team members, an explicit unattributed bucket, and payment-method status
only. Member responses have no pending payment amount, offers, prices,
thresholds, refill quantities, monthly caps, consent details, arbitrary user
identifiers, card brand/last four digits, or enabled funding actions. Free-form
labels/details must never smuggle another user's identity or payment-instrument
details into the member shape.

Recurring add-ons are versioned UOA offers with organisation, team, or
subscribing-user entitlement scope and exact Stripe invoice-paid evidence.
DeepWater's privacy option is the ordinary versioned **US$50/month** privacy
offer. The requested team is always retained as actor context even when an
organisation entitlement has no team. Organisation-scoped checkout and
cancellation require an active organisation owner/admin; an exact-team
owner/admin can act only for team and subscribing-user scopes. Cancellation is
an opaque, expiring, one-use intent with an immutable subject fingerprint and
idempotent result. Expired intents become terminal `EXPIRED` rows before a new
preview can be issued.

The add-on Checkout runtime accepts only the frozen `offer_id` action returned
by UOA. It derives the exact organisation/team customer, scope, immutable
catalog Price, HTTPS return URLs, and stable idempotency key, then creates one
licensed monthly item with discounts, promotion codes, and automatic tax off.
The signed Checkout completion is reconciled against a fresh Stripe session and
subscription and creates only a pending projection. UOA activates entitlement
only after `invoice.paid` proves the exact `subscription_create` invoice,
customer, subscription/item/Price, quantity, amount, currency, and absence of
discounts, tax, credits, shipping, or proration. Removed, added, or rebound UOA
metadata fails retryably rather than consuming the webhook event. For Stripe's
`2026-06-24.dahlia` contract, the canonical invoice-line subscription proof is
`parent.subscription_item_details`; the omitted legacy line-level subscription
alias is tolerated, but when Stripe supplies it the alias must match exactly.

Cancellation preview refreshes Stripe before minting an opaque five-minute
capability, stores only its digest, and permits one unresolved intent per exact
subscription. Confirmation locks that intent, rechecks the lifecycle app key,
actor, membership, scope manager, immutable offer terms, and current Stripe
binding, then schedules period-end cancellation with one stable UOA
idempotency key. An exact replay returns the stored result; a changed token,
key, choice, subject, scope, or subscription conflicts. Disabling a future
offer never strands an existing customer: its immutable historical policy and
terms remain cancellable.

`BillingCreditsV1` and the recurring-add-on protocol are public, MIT-licensed
interfaces from `@unlikeotherai/billing-statement-protocol`. Their generated
JSON Schema, fixtures, and OpenAPI 3.1 components are the consumer contract.
The credits contract is at protocol version `2.0.0`. Clients that send
`x-uoa-billing-credits-protocol: 2.0.0` can receive an optional
`billing_status` for held reconciliation; older strict clients receive a named
503 response while a billing hold is active, with no unnegotiated response
property.
UOA serves those artifacts under `/schemas/billing-credits-v1.*` and
`/schemas/billing-recurring-addons-v1.*`. A product reads the current shared
balance through `POST /billing/v1/credits` and its scoped add-on catalog through
`POST /billing/v1/recurring-addons`, always with that product's own lifecycle
app key plus a fresh exact actor assertion. The read endpoints and settlement
runtime do not imply that any mutation action is enabled. When the Stripe
collection gate is off, UOA resolves only one unambiguous persisted account/mode
and still returns the shared read projection, including `Remaining credits`,
but freezes every funding action without making a Stripe read. When collection
is on, credit Checkout, top-up, auto-top-up, and recovery actions appear enabled
only after fresh current Stripe catalog, payment-method, Checkout, or
PaymentIntent evidence proves that the exact action is executable. Add-on
actions additionally require one complete persisted Product/Price binding with
exact local offer terms and no unresolved checkout. An evidence read failure
freezes the affected action without failing the balance read. Enabled add-on
actions use
`POST /billing/v1/recurring-addons/checkout`,
`POST /billing/v1/recurring-addons/cancellation/preview`, and
`POST /billing/v1/recurring-addons/cancellation/confirm`; products relay UOA's
complete frozen bodies and never supply a Price, amount, customer, return URL,
or alternative cancellation choice.

The customer credit mutations are the frozen routes
`/billing/v1/credits/top-up-checkout` and
`/billing/v1/credits/auto-top-up/{setup,update,disable,recover}`. Every call
re-verifies the exact product app key, fresh actor, active organisation/team
memberships, and exact-team billing-manager role. The product may send only the
subject body plus the UOA `offer_id` or `option_id` supplied by the latest
projection. Amount, currency, quantity, Stripe Product/Price/customer/intent,
metadata, and return or recovery URLs are never caller inputs. UOA validates
the active policy and account/mode catalog against current Stripe objects,
writes the locked customer-action authorization and immutable exact effect
binding before making a Stripe mutation, and recovers
open sessions through a server-derived idempotency key. Setup and payment
webhooks must match the local customer, immutable terms, and reserved metadata
before funding or consent is committed. A policy, catalog, payment method,
consent, or Stripe binding gap disables the corresponding projected action and
fails a forged direct request closed.

Disable authority is bound inside the database transaction. The immutable
disable audit event identifies the exact requester, active lifecycle app key,
organisation, team, account, prior consent, and generation. Its database
trigger takes the account lock, then locks the exact lifecycle app key,
organisation, team, organisation membership, and team membership before
independently rechecking current exact-team billing-manager authority. An
in-flight revocation therefore serializes before or after the disable event;
one that began first prevents the consent transition.

#### Stripe commercial-catalog provisioning

Commercial catalog bootstrap is an explicit, idempotent operator command; it
is not SQL, a schema migration, application startup logic, or a Stripe object
creator. The operator must provide the exact Stripe account and `test` or
`live` mode. `--dry-run` performs all remote and local validation without a
write. `--apply` additionally requires the exact confirmation string
`PROVISION_UOA_STRIPE_CATALOG:<account>:<mode>`, and commits all local changes in
one serializable transaction.

The remote Stripe objects must already exist. UOA validates their account,
mode, active state, lookup key, Product binding, exact metadata, USD amount,
one-time/recurring type, and monthly licensed recurrence before opening the
write transaction. The command never creates, updates, archives, or replaces a
Stripe Product or Price. It may bind an exact local catalog only when both of
its Stripe identifiers are still null; a partial or different binding is
drift. Re-running against the exact state is a no-op.

The version-1 shared-credit Product has four one-time Prices:

| Lookup key               | Charge | Credits |
| ------------------------ | -----: | ------: |
| `uoa_credits_usd_10_v1`  |  US$10 |  10,000 |
| `uoa_credits_usd_25_v1`  |  US$25 |  25,000 |
| `uoa_credits_usd_50_v1`  |  US$50 |  50,000 |
| `uoa_credits_usd_100_v1` | US$100 | 100,000 |

The same offers are projected for the exact active services `nessie`,
`deepwater`, `deepsignal`, `deeptest`, and `docgen`. Each receives top-up and
automatic-top-up policy plus the default automatic option: refill 25,000
credits below 5,000, with a US$100 monthly cap and consent version
`credits-auto-top-up-v1`.

DeepWater privacy is a separate US$50/month licensed Price with lookup key
`deepwater_privacy_usd_month_v1`. It is bound to the active,
feature-flags-enabled `deepwater-api` app, the `can_be_private` flag (default
off), an exact TEAM feature policy, and recurring add-on key/version
`privacy`/`1`. Stable Stripe metadata uses the public service identifier
`deep-water`; UOA's canonical billing-service key remains `deepwater`. Neither
form is a local database identifier.

The paid privacy flag is the exact `deepwater-api` / `can_be_private`
definition, remains default-off, and is described as a team entitlement. The
normalization migration accepts only the exact pre-billing description and
refuses to reinterpret any existing role or user override; those grants must be
reviewed and removed explicitly before a deployment can adopt the paid,
team-scoped contract.

### Contract invoice calculator and invoice privacy

Contract pricing is UOA-owned and administrated only by platform superusers.
An organisation contract pins a versioned organisation-wide margin used by the
invoice calculator. A later margin change creates a new version and cannot
rewrite an issued invoice. The calculator may use Ledger's immutable raw usage
and provider-cost facts internally, but the customer invoice projection is a
separate privacy boundary.

Issued-invoice views expose gross calculated customer price grouped by service,
then one separate canonical funded-credit settlement, ordinary fixed
subscriptions, adjustments, taxes, payments, and totals as applicable. Paid
recurring add-ons remain on their canonical Stripe subscription, are labelled
as collected separately, and are excluded from the manual amount due. The
payment invoice remains distinct from the frozen cycle usage breakdown: the
breakdown may show measured token/API/search/research units, cache and modality
counts when the Ledger receipt actually supplies them, plus final customer
charges and credit consumption. Neither document exposes raw provider cost,
cost-token equivalents, tariff markup, or the margin calculation. Even
operator-created descriptions must not encode those prohibited financial
facts. Product applications receive only UOA's display-ready documents and
never reproduce the calculator.

Stripe invoice-close catch-up verifies the configured Stripe account identifier
against the immutable account binding before reading or advancing any invoice.
Changing the configured Stripe account holds prior-account liabilities for
reconciliation; matching test/live mode alone is insufficient authority.
