# Billing cycles, seat subscriptions and prepaid pools

## Required result

UOA owns commercial terms, memberships, seat capacity, prepaid credits, monthly
cycles and invoices. Ledger owns every physical provider attempt and immutable
measured usage/cost. Nessie, Deepwater and Deep Test provide a Billing cycles
page reached from Credits & billing and their existing navigation framework.
Customers can select a month, see its subscription/seat charges, measured token
usage and credits consumed, and download its invoice and usage breakdown.

The customer contract contains no markup, provider cost, rate card, multiplier
or internal tariff formula. Operators enter markup as a decimal percentage:
`30.00` means provider cost multiplied by `1.30`, once in UOA. Exact integer
basis-point storage is private. Customer credits are consumed at the resulting
commercial rate, with no product-side money or credit calculations.

## Plan and seat policy

Immutable tariffs select flat monthly or per-seat monthly charges, independently
of prepaid or pay-as-you-go usage, and apply to a team or organisation payer.
Per-seat tariffs select `AUTOMATIC` or `FIXED` and `FULL_MONTH` or `PRORATED`.
New per-seat plans default to automatic/prorated; existing assignments retain
their frozen terms. Purchased fixed capacity belongs to a scoped subscription,
not a shared tariff. A flat subscription charges once per selected scope.

Automatic seats are unique active human members in the subscription scope.
Organisation seats deduplicate a person belonging to several teams. Agents,
service credentials and pending invitations are not billable automatic seats.
Prorated liability is the per-seat monthly price times the sum of active
membership intervals overlapping the actual UTC month, divided by that month's
duration. Intervals are half-open; joining/leaving at the same instant, repeated
events, leave/rejoin and leap months have deterministic results. Decimal
arithmetic rounds once at final currency settlement, not per event or person.
Full-month automatic billing counts each person active at any instant in that
month once. The current charge updates when members change; a closed invoice
does not silently change. Policy activation captures an explicit current-member
baseline, never fabricated historical membership evidence.

Fixed seats charge contracted capacity, independently of occupancy. Capacity
changes are explicit, auditable subscription revisions; prorated policy applies
to their effective intervals. Full-month increases charge the increased capacity
for the current month and decreases take effect next month. Shrinking below
occupied/reserved capacity is refused without removing anyone automatically.

Fixed capacity is enforced in UOA before every grant, including invitation
creation/acceptance, direct/admin/backend membership, imports, automatic enrolment
and team creation that adds members. Pending invitations reserve capacity only
for people not already members; cancellation and expiry release it, and acceptance
converts the reservation atomically. Organisation and team constraints are both
checked; all effective fixed-seat subscriptions must be satisfied. Locks use a
deterministic order. Concurrent invitation/acceptance/grant and billing activation
cannot overbook. Replayed grants and invitations do not count twice. Existing
rosters larger than a proposed capacity prevent activation rather than expel users.

## Prepaid runtime and credit authority

Team/organisation credit pools are funded only by confirmed payment/adjustment
lineage. Before paid dispatch, Ledger obtains an idempotent UOA reservation using
a product-bound Ledger runtime credential and the original fresh UOA delegation.
UOA checks its own token signature, exact Ledger audience, product, credential
epoch and current membership, freezes tariff/payer/month, and reserves the rated
upper bound under the credit-account lock. Unknown bounds or insufficient funds
stop the call before provider egress. No customer content enters billing.

After an immutable Ledger receipt, a durable settlement queue sends exact raw
cost and receipt identity. UOA debits once and releases the unused reservation.
Trusted proof of no dispatch permits release; unresolved paid calls retain their
reservation without blind TTL expiry. Settlement uses the runtime credential,
not an expired human token, against the original immutable binding. Prepaid
usage is excluded from pay-as-you-go Stripe export and the older credit collector
to prevent duplicate charges, but remains present in customer credits, cycle
usage and incomplete-liability status. Monthly fees are separate from usage.

Long-running jobs must preserve renewable original-actor authority, not only a
subject/team snapshot. Nessie and Deep Test already have renewable per-call
delegation providers; Water's delayed compute context lacks that carrier and
credential epoch. First reuse an existing exact-scope relying-party refresh
path where available. Indirect/background jobs otherwise require a UOA-issued
job-scoped renewal capability minted from a fresh original delegation, bound to
the stable job, subject, org/team, product, audience, purpose, credential epoch
and authorized job expiry. UOA rechecks revocation and membership at renewal and
reservation. A capability cannot broaden scope, resurrect a cancelled job, or
outlive its authorization. Refresh credentials never go to Ledger or the browser;
products retain only appropriately encrypted UOA-issued relying-party material.
Old jobs without captured proof require owner reauthorization, never a current
user-row epoch backfill or an expired launch JWT. The exact issuer contract must
be reviewed before implementation and covered by revocation/restart tests.

## Monthly cycles and invoices

Privileged seat functions pin `pg_catalog`, their owning schema and `pg_temp`
in that order. Every replacement must restore that setting and the revoked
public execution privilege; PostgreSQL clears omitted function settings on
replacement. Database regressions check the deployed settings and temporary
table shadowing, alongside the membership and invitation races.

UOA supplies a paginated, manager-authorized cycle list and exact-scope cycle
detail. The public protocol publishes validated DTOs, fixed actions and synthetic
fixtures. Each cycle identifies its UTC month, payer scope, products, state,
customer credit consumption and charges, recurring/seat lines,
due/paid amounts by currency and invoice/download metadata. It does not expose
other teams' named usage through an organisation payer. Member projections retain
existing privacy rules; financial invoices require the payer's billing authority.

A durable immutable cycle snapshot pins source metering snapshots, effective
terms, membership/capacity intervals, credit allocation and invoice identity
privately. An open month is a clearly labelled preview, never a downloadable
final invoice. A finalized invoice's totals and evidence are frozen; delayed
receipts or later corrections use an explicit adjustment/credit-note lineage.
Cycle `credits_consumed` means UOA-rated paid usage credits, including PAYG
usage invoiced without a funded-wallet debit; it never includes seats or tax.
The private evidence records funded-wallet debit separately. A completed PAYG
settlement or settled prepaid receipt chain must match the closed Ledger-rated
amount before a customer credit number is confirmed. Unknown coverage stays
pending; proven zero usage is zero. Opening and closing funded-wallet balances
remain pending until immutable account-entry boundaries establish them.
Unknown paid usage holds final settlement rather than yielding a zero invoice.
Prepaid consumption is a credit-balance/account breakdown and never a second
demand for payment. Every successful prepaid payment, including each automatic
recharge, produces its own actual charge invoice; the monthly customer view
groups those invoices by their frozen charge month. A delayed legal issue does
not move an October payment into November. No invoice is synthesized
from a later usage read. Legal invoice PDFs list actual charges and tax, while
credit consumption and seat evidence remain in a separate customer breakdown.
Each usage line names its payment mode: `prepaid` shows consumed credits with
no new customer money charge, while `pay_as_you_go` shows an actual payable
usage charge only when its invoice source is proven. The private UOA-rated
amount still reconciles both modes against immutable paid usage evidence.
An accepted payment with missing legal issuer/tax evidence remains a durable
pending document in the charge history: its verified payment and credits are
visible, but no legal number, tax amount or download is invented.
For multi-service legal invoices, the issuer freezes one allocation per service
line before issue: subscription and payable usage, tax, invoice credit, gross
total and net due. Database checks require all line allocations to sum exactly
to the invoice's gross and credit totals. An old invoice without allocation
evidence remains a valid legal document but its ambiguous product cycle stays
pending. A partial whole-invoice payment is never split among products by a
ratio; product paid/outstanding needs actual line payment evidence.
Each funded settlement reference is assigned to its own service line in stable
service and settlement order. The invoice-wide cumulative microcredit rounding
determines the minor-unit delta at each reference; it preserves fractional
carry and prevents a funded usage credit from reducing a seat or flat fee.
The customer cycle totals show tax and gross explicitly: subscription plus
usage plus tax equals gross, and gross less applied usage credits equals due.
The canonical monthly legal invoice retains its original gross convention.
Manual and Stripe collection must both supply real monthly documents. Fetching
historical months must not create charges, recalculate current terms or invent
old invoices. Stripe invoice PDFs may not contain the full measured usage/seat
evidence, so UOA also provides its frozen detailed breakdown download.

Products validate the canonical contract and proxy only fixed same-product
actions. Download authorization rechecks current payer scope; no arbitrary URL
proxying, public storage URLs, cross-product invoice IDs or billing secrets.
Documents and JSON contain customer charges, credits and seats only; measured
provider units remain in private billing evidence. Actual manual invoice
payment and void events enqueue a durable reconciliation task in the same
database transaction as the financial change. Multiple workers claim bounded
batches with a lease and generation check, so a restart or newer event cannot
lose a pending customer revision. Historical allocations are queued once during
migration at lower priority than fresh events. History
links stay reachable from the current billing page, with loading, empty, pending,
download and failure states. No duplicate local identity, membership or billing
authority is added.

## Ordered implementation and evidence

1. Sol privacy/protocol tranche removes private terms from customer DTOs and
   publishes the versioned public package; Sol operator tranche exposes exact
   percentages and monthly/prepaid/seat selectors on existing billing surfaces.
2. Sol backend tranche implements effective seat/capacity evidence, exact charging,
   subscription collection and prepaid reservations. A subsequent substantial
   tranche audits every membership writer and enforces capacity under real locks.
3. Sol cycle tranche implements immutable history/document authority and public
   contracts. Consumer work starts from that committed protocol and adds the
   three product pages, entry points and authorized download flows.
4. Integrate each scoped branch into its repository integration branch, review
   the full brief, run required checks and merge green PRs. Preserve original
   token-accounting regressions and do not modify historical production charges.

Required proof includes exact 30% consumption without public markup keys/text;
automatic add/remove/rejoin and leap-month proration; fixed invitation races and
all grant paths; fixed capacity revisions; multiple team/org plans; prepaid
simultaneous dispatch/receipt/retry/restart without overspend or double debit;
invoice closure, delayed receipts and corrections; unauthorized cross-scope
history/download refusal; and headless desktop/mobile views and actual download
contents in all three products. Tests use isolated migrated databases and
synthetic provider/Stripe transports. Paid providers, production financial writes,
deployment configuration and real payment proof remain separate evidence tiers.

Provider references: [Stripe prorations](https://docs.stripe.com/billing/subscriptions/prorations),
[finalized invoices](https://docs.stripe.com/api/invoices/update),
[invoice PDF fields](https://docs.stripe.com/api/invoices/object).

### Seat admission evidence implementation

UOA serializes membership, invitation, lifecycle, seat activation and capacity
writes on the organisation's `billing_seat_guard_version` row. Deferred database
checks observe the final transaction state, so an invitation converted into a
membership is counted once and parallel grants cannot exceed any active team or
organisation fixed limit. This covers direct, admin, import, SSO and invitation
writers without separate product membership copies. A conflict returns the
machine code `SEAT_CAPACITY_EXCEEDED` with HTTP 409. An expired, revoked,
declined or denied invitation no longer reserves a seat.

Each seat subscription records `baseline_member_count` at observed activation,
including zero. Automatic membership intervals begin at the same observed
activation and follow active UOA users and memberships; organisation scope
counts each person once across its teams. A pending future commercial month may
start evidence capture earlier, with its billable start bounded by the separate
commercial effective instant. Historical rows without a captured baseline stay
unquotable until reconciled. Fixed capacity revisions are append-only, and all
future scheduled lower capacities must still fit the current occupied and
reserved roster. A subscription's `ended_at` closes its open evidence intervals;
quote boundaries and invoice close remain the financial producer's authority.

The operator changes a fixed subscription from its product's existing
**Subscriptions** tab in UOA Admin. `GET
/internal/admin/billing/services/:serviceId/seat-subscriptions` shows the
captured baseline, current purchased quantity and revision history for each
team or organisation source. `POST
/internal/admin/billing/seat-subscriptions/:subscriptionId/capacity` appends an
audited positive quantity revision. Prorated changes and full-month increases
start at the observed instant; a full-month decrease starts on the next UTC
month boundary. Database admission checks reject a shrink below active members
and unexpired pending invitations. The operator sees HTTP 409
`SEAT_CAPACITY_EXCEEDED`; no roster is changed by a capacity request. A pending
future revision blocks another change with HTTP 409
`SEAT_CAPACITY_CHANGE_PENDING` until it takes effect, and the Admin control
shows its quantity and UTC effective date. Each change rechecks the operator's
live superuser role and token epoch in the capacity transaction, after taking
the same organisation lock used by roster admission.

Seat intervals are private append-only billing evidence. A same-millisecond
join/leave retains a zero-duration marker, preserving a captured baseline but
charging nothing. The database denies direct interval edits, changed captured
baseline counts and reversal or backdating of a subscription end. It also
updates both old and new scopes when an authoritative membership row moves,
using ordered organisation locks. Public callers cannot invoke the privileged
roster functions directly.
