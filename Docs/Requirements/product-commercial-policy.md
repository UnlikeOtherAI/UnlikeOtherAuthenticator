# Company product access, storage and payment recovery

UOA owns commercial facts and identity. Nessie owns its functional restrictions
and content measurement. A product never infers full access from a positive
monthly price, a tariff key, a manager statement or a failed network request.

The public protocol is `@unlikeotherai/billing-statement-protocol`5.9.1,
`commercial-types.ts` and `commercial-schema.ts`. The additive contract exposes
exact product/company scope and a returned human team/user pair whenever a
person is selected. Human reads require the ENTITLEMENT key and an exact
endpoint-audience RS256 actor. Background calls require a different
COMMERCIAL_WORKER key with no actor. Every request rechecks current key expiry,
revocation, active registered source domain, active company and exact enrollment.
Current roles/credential epoch/team membership authorize human responses.

Enrollment is confirmed by the product's authenticated direct-session route or
an audited operator action. Existing exact unambiguous direct-session evidence
is enrolled by migration; unknown or ambiguous source bindings remain held for
operator review. Key rotation with the same product/source preserves enrollment;
another issuer cannot inherit it. Company access uses organisation agreements
only. A legacy subscription for teamA never licenses another team or company.

Members receive functional full/limited access, fourteen-day history, storage
capacity and admission flags. They never receive private standing, fee-waiver
classification, payment incidents or recovery deadlines. Manager/background
projections contain those separate commercial facts. Positive snapshots are
in-memory only, expire within60 seconds and at any earlier relevant commercial
boundary; include product/company/person/team in consumer cache keys.

## Operator policy

Standard monthly human prices are EUR299, GBP299 and USD399 minor units,
automatic company seats, prorated changes, prepaid usage and standard30% markup.
UOA retains its existing membership-interval calendar-invoice architecture:
there is no invented licensed Stripe seat item. Operator creation is prospective
and never migrates a customer's accepted agreement implicitly.

Trials store explicit start/end and default to one UTC calendar month, clamped
at month end. They waive platform/seat fees only. Inference, rental, SMS and
storage remain paid. A Stripe trialing notification never starts billable seat
evidence. Expiry returns to free unless a separate accepted agreement applies.

An operator may assign private pricing only to an exact company. The explicit
collecting AT_COST organisation tariff must have zero monthly seat fee and no
conflicting marked-up team override. Policy activation uses its evidenced
immutable assignment effective month, never today's mutable pointer. Private
terms stay outside public selectable plans. SMS messages and rental use provider
cost with zero markup; unknown attributable storage cost remains held.

Partial waivers are unsupported for an already accepted nonzero flat/full-month
custom agreement. The operator action rejects these before a policy mutation,
rather than inventing a discount or stranding later invoices. New-company and
standard automatic/prorated trials remain supported.

## Storage

Decimal company capacity is100,000,000 free bytes or purchased blocks of
1,000,000,000,000 bytes total each, replacing the free allowance. Prices per
block/month are EUR999, GBP849 and USD1099 minor units. Storage is independent
of paid seats/history. No paid first TB is included. File accounting is immediate;
the daily complete logical database snapshot carries measurement_version,
monotonic revision, observation identity and timestamp. Failed/stale/conflicting
observations cannot replace current measurement with zero or older totals.

Automatic expansion requires dedicated explicit storage consent and a verified
payment method. Credit auto-top-up consent confers no storage authority.
An idempotent ensure request asks for a minimum capacity, not an additive block.
Commit the exact expansion before Stripe egress; unresolved attempts block another
charge. The initial purchase uses Stripe's disclosed subscription period and
renewal date; delayed settlement does not reset that date.
Further blocks use always_invoice proration, retaining its renewal date.

Stripe collection remains charge_automatically. Initial incomplete_expired
state after23 hours is not resolution of our longer weekday grace. Preserve the
original incident/pending capacity. Recovery requires fresh terminal unpaid
proof for the old attempt and one generation-bound replacement under the same
logical expansion; never replace a live or unknown attempt or restart grace.

Storage catalog binding is operator-only, verifies existing immutable objects
and never creates remote prices. Product metadata is exactly
`uoa_kind=company_storage`, `uoa_service=nessie`, `contract_version=1`.
Price metadata is exactly `uoa_kind=storage_block`, `uoa_service=nessie`,
`storage_block_bytes=1000000000000`, `contract_version=1`.
Lookup keys are `uoa_nessie_storage_{eur,gbp,usd}_tb_month_v1`.
Prices are monthly licensed, interval1, no meter. Account/mode binding is exact;
missing catalog is setup required, never an invented quote. Code/migration does
not change live defaults, existing customers, Stripe mode or collection gate.

## Recovery

Seat/storage payment failure grants24 weekday elapsed hours, excluding entire
Saturday/Sunday dates in an explicit company IANA timezone (UTC default).
Retries cannot restart it. Choose the earliest unresolved deadline, not merely
the earliest failure, since timezone changes can reorder deadlines. Every
qualifying liability must resolve before the company recovers. Preserve reads,
text communication, memberships and stored content after expiry; restrict new
members/uploads and expose fourteen-day history. Credits and inference-only
invoices never company-downgrade.

Phone/add-on failures have seven calendar days. Stages are initial,+3days,
+6days(final24hours), then release due. Events target only current company
owners/admins and identify exact event/person/channel. Acknowledge successful
transport acceptance with receipt_id; queuing is insufficient. UOA handles
email through a real configured provider, recording receipt only on success.
Fresh unpaid proof plus all required current-recipient warnings are prerequisites
for release of the exact provider number; Stripe cancellation alone is not
provider release. No live number may be released during implementation/tests.

Final-warning acceptance extends release eligibility to at least 24 hours after
the latest required accepted final-stage receipt, as well as the original seven
calendar days. Email recipient work persists fair retry slots and a deterministic
delivery identity. A crash after transport accepts but before database commit can
send a duplicate: delivery is at least once, not exactly once. Successful release
terminates provider work through the existing number-end path without erasing
the unpaid financial incident.

Private standing binds an immutable company tariff event. A later effective
company reassignment/removal ends that private interval at the same evidenced
month; historical waivers are clipped there. Conflicting later team overrides
are rejected while the company private interval remains effective.

Regional standard v1 tariffs are currently unassigned. Separate immutable USD
usage valuation and regional monthly seat currency are approved but remain in
progress: never assign EUR/GBP versions before end-to-end prepaid currency
separation verification. No balance/provider/top-up conversion is authorized.

Original failures are established from verified Stripe invoice/payment evidence.
Bounded Stripe event scans persist their cursor so unrelated event volume cannot
hold the same invoice forever at a fixed scan ceiling. Unknown expired evidence
remains a visible reconciliation hold; no replacement deadline is guessed.

## Implementation verification

Protocol compilation, generated artifact checks and strict member privacy/subject
validation have passed on Minis as a small standalone check. API migration,
runtime, storage collection, hosted invite waiting, operator browser flows and
real PostgreSQL/race verification remain in progress; this document does not
claim those are shipped or deployed. Final delivery must replace this progress
record with actual focused test and headless rendered-flow evidence.
