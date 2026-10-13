# Company product access, storage and payment recovery

UOA owns commercial facts and identity. Nessie owns its functional restrictions
and content measurement. A product never infers full access from a positive
monthly price, a tariff key, a manager statement or a failed network request.

The public protocol is `@unlikeotherai/billing-statement-protocol`5.10.2,
`commercial-types.ts` and `commercial-schema.ts`. The additive contract exposes
exact product/company scope and a returned human team/user pair whenever a
person is selected. Human reads require the ENTITLEMENT key and an exact
endpoint-audience RS256 actor. Background calls require a different
COMMERCIAL_WORKER key with no actor. Every request rechecks current key expiry,
revocation, active registered source domain, active company and exact enrollment.
The live key's actor key id, public JWK, audience, allowed return origins and
current service identifier must still match the verified request credential;
an in-flight old actor/key context cannot survive rotation unnoticed.
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

Home: Admin Billing > selected product > Company policy. The company selector,
registered source and timezone controls enroll an exact company and assign a
trial/private revision with its returned effective date visible. The same panel
binds verified existing storage prices; App keys issues/revokes the separate
Commercial worker credential. These operator flows still require their focused
browser verification before final delivery.

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

Usage valuation is an immutable `usageCurrency`, independent of monthly seat
`currency`. Historical tariffs copy their original currency; new EUR/GBP Standard
versions explicitly choose USD usage. The operator tariff form labels these
separately. Regional prepaid credits remain USD, with unchanged provider cost,
wallet, reservation and receipt evidence. A collectible or unproven cross-currency
usage liability is a reconciliation hold; no FX or balance conversion is implied.

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

The manager storage read returns the exact company/person/team, current mandate,
purchased/pending blocks, actual Stripe period dates and original pending
expansion. A freshly verified invoice URL provides card-authentication recovery;
terminal initial attempts expose an exact recovery action under the same logical
purchase. Setup alone charges zero and does not prove storage payment. Returning
to the allowlisted customer UI `/admin/billing` refreshes UOA facts rather than
trusting a success query string.

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

Private assignment rejects an accepted unrevoked retail storage mandate or a
nonterminal retail storage subscription before policy mutation. The operator
receives the explicit prerequisite to end retail storage and revoke automatic
expansion. The separate customer cancellation/replacement and attributable
private storage cost evidence paths remain in progress; no retail amount is
ever substituted for unknown provider cost.

Regional standard v1 tariffs are currently unassigned. Separate immutable USD
usage valuation and regional monthly seat currency are approved but remain in
progress: never assign EUR/GBP versions before end-to-end prepaid currency
separation verification. No balance/provider/top-up conversion is authorized.

The manager storage response includes `payment_recoveries` for every unresolved
storage incident on the current Stripe account, independently of whether its
initial capacity expansion has already paid. Each entry exposes the exact
verified invoice id, invoice currency, gross amount, own grace deadline and
allowlisted hosted Stripe payment URL when the invoice remains open. A prior
paid expansion never proves a later renewal paid. An earlier seat incident may
cap company access without hiding storage recovery. A remotely paid invoice
keeps its unresolved local debt visible without a second payment link until
verified cash evidence commits. Members receive none of these commercial fields.
Storage reads and webhook preparation reuse one price/customer/subscription/line
validator; manager authority is rechecked after provider reads. Pending expansion
also includes its explicit invoice currency. No browser return proves payment.

Storage mutation results are exported strict contracts: `storage_mandate_result`
binds product/company/mandate and returns either `open` with a verified Checkout
URL and expiry, or a nonredirect accepted/processing/expired/revoked state.
`storage_recovery_result` binds the same logical expansion and nullable exact
generation, with payment_pending/paid/reconciliation_required state. Consumers
validate scope and URL before navigation, then re-read the authoritative storage
screen; neither mutation return nor browser return replaces paid proof.

Original failures are established from verified Stripe invoice/payment evidence.
Bounded Stripe event scans persist their cursor so unrelated event volume cannot
hold the same invoice forever at a fixed scan ceiling. Unknown expired evidence
remains a visible reconciliation hold; no replacement deadline is guessed.

Scheduled commercial recovery scans one bounded Stripe event page per account
poll through durable time windows. It commits original event identifiers and
the page cursor together; each event receives its own durable retry slot.
Source/API-version or first-failure reconciliation holds cannot starve later
payments. Only authenticated original Stripe Events enter the same verified
webhook core; HTTP still requires the ordinary webhook signature. This covers
missed storage renewals and setup completion, not just unfinished expansions.
Storage capacity has a paid-through boundary from exact verified paid invoice
line periods. A subscription's advanced renewal date alone never proves the
renewal paid. Expired/missing paid-through evidence without a confirmed payment
incident produces reconciliation unavailability, not a guessed failure/grace.
Confirmed storage grace remains a separate capacity authority. Pending expansion
capacity requires an incident bound to that expansion, rather than an unrelated
older storage renewal. Already committed immutable cash evidence can restore
this boundary after an upgrade through freshly verified original-event replay.

## Implementation verification

On Maxis at `05ae0679`, protocol/artifact build, Prisma generation, API and Admin
typechecks passed. Five clock unit checks passed; seven focused wire/database
checks passed without skips on the dedicated Fedora PostgreSQL cluster. Coverage
includes exact scope/current key revocation, concurrent observation conflicts,
stale-zero protection, runtime RLS denial and no-store/email-ack wire semantics.
All 209 migrations at the foundation checkpoint applied on a fresh cluster.
Storage collection/reordered cash/weekend-expiry, hosted invite waiting and
operator browser verification remain in progress; this document does not
claim those are shipped or deployed. Final delivery must replace this progress
record with actual focused test and headless rendered-flow evidence.

At `90dce07b`, Maxis protocol5.10.1 build and API typecheck passed. Five storage
manager recovery tests and three wire tests passed. The real Fedora PostgreSQL
cash-ordering test passed without skips: A paid while B pending preserves B's
target; B paid followed by old A/renewal does not reduce capacity. The corrected
prepaid settlement assertion at `c05bef9b` passed alongside all twelve original
rating tests, and five strict privacy/phone/schema checks passed. This proves
no duplicate settlement debit; it is not the outstanding regional
reservation-to-receipt-to-cycle-to-monthly-invoice verification.

The regional financial persistence regression now exercises authenticated
dispatch admission, actual receipt finalization, signed Ledger receipt-set proof,
closed-month cycle preparation and idempotent exact regional seat invoice-item
collection for EUR, GBP and USD. Its synthetic provider and isolated PostgreSQL
database cannot charge customers. Execution remains pending until the result
is recorded; schema compilation alone is not financial verification.

The regional test reached actual seat invoice collection and exposed the old
USD-only PostgreSQL monthly seat source constraint. A corrective migration
admits EUR/GBP/USD only when account and currency match the frozen subscription's
tariff. It retains all original amount/state/evidence invariants and changes
no wallet, provider receipt, top-up or previous invoice currency.

Late storage dispatch responses retain their original attempt evidence but cannot
replace the company subscription projection after a newer attempt generation or
larger expansion exists. This check runs under the same company lock as invoice
cash projection; an expired initial attempt cannot overwrite its replacement.

For an explicitly enrolled Nessie company, an existing FREE or collection-NONE
usage default cannot authorize a paid provider dispatch. UOA refuses that funded
admission with `BILLING_PRODUCT_USAGE_FUNDING_NOT_ACCEPTED` until independently
accepted collecting usage terms are effective. Trial/full-history access does
not bypass this funding check. Existing collecting manual/at-cost arrangements
retain their authority; product-local and independently funded providers do not
derive eligibility from this UOA-funded admission.

At `ef48dc0e`, all three regional financial database cases passed on the dedicated
Fedora PostgreSQL cluster through Maxis, as did four authority/RLS cases including
live actor key/JWK rotation. API typecheck passed. Actual UTC observed roster
activation produces the current month's real prorated regional seat amount;
the test never fabricates a backdated baseline. At `1d03cd4b`, protocol5.10.2
build, API typecheck and seven strict contract tests passed; both cash-ordering
and original weekday-deadline/reordered retry database cases passed.

At `8593dbab`, the synthetic operator headless Chrome journey passed on Maxis at
desktop and Pixel7 sizes (two cases). It verifies reachable Company policy,
rejected trial input preservation, explicit future private date, existing storage
price binding and separate EUR seat/USD usage valuation in an unassigned tariff
save. Screenshots were reviewed; no live API/provider request is permitted by
the harness. Four fresh phone verdict checks at `b87ff4af` also passed, covering
paid-before-verdict refusal, gross/nominal distinction, late final24h and missing
email transport refusal. Full changed-source lint is still being completed.

Storage consent uses UOA's existing presentation-version/customer-locale headers
for all seven billing locales. The read action, accepted mandate evidence and
Stripe setup page share producer-owned translations of the same versioned terms.
Locale and complete checkout text are frozen in the mandate before external
creation; replay does not substitute a later request's language into the same
Stripe idempotency key. Localized text never changes price, cycle or authority.
Missing frozen consent evidence holds setup for reconciliation.

Seat payment status is matched against every unresolved exact seat liability,
while the earliest unresolved company deadline still controls restrictions.
An earlier storage debt cannot remove another seat agreement's valid grace.
`past_due`/`unpaid` without original bound seat failure evidence returns a
reconciliation error: consumers preserve existing reads and hold allocations,
rather than inventing a fresh deadline or granting indefinite paid standing.

Protocol5.11.0 freezes `/billing/v1/seats` and `/billing/v1/seats/checkout` for
the customer billing home. Offers contain only operator-published compatible
Standard company terms; acceptance is explicit and completes through the
existing Stripe Checkout and membership-interval billing architecture. The read
does not authorize charges or mutate usage history. Existing agreement terms,
prospective offers and usage collection activation remain separate. Producer
wiring and first-versus-existing-company acceptance verification remain in progress.

Standard publication is reachable in the operator's Nessie Company policy tab,
beside storage price binding. Only exact requested regional automatic/prorated
PREPAID tariffs with USD usage valuation and30% markup pass both service and
database publication guards. Withdrawal affects future selections, never frozen
purchases. `/billing/v1/seats` separates current agreements, unique humans and
usage funding dates from public offers; `/seats/checkout` records explicit
subject-bound acceptance and reuses the base Checkout request constructor.
Active, exactly verified Stripe subscription projection commits a single usage
term event. Companies with prior company/team acceptance, dispatch, liability,
cycle, contract or completed checkout retain usage terms until next UTC month.
Otherwise the first term starts at observed acceptance; prepaid admission resolves
that dispatch's timestamp so an older request cannot be re-rated. The prospective
activation evidence is immutable and shared company budget locking prevents new
admission racing the first-acceptance decision. New producer/publication flows and
the three database regressions are coded; execution and rendered checks are pending.

Maxis deployed all215 migrations successfully. Prisma generation identified a
misplaced inverse relation, now corrected before compiler/flow verification.

Public offers permit one active immutable version per regional currency; an
operator withdraws the current offer before replacing it. Database guards bind
the accepted seat/usage monetary snapshot and effective timestamp to the exact
company term event, preventing missing JSON properties or foreign-scope events
from being accepted as consent/activation evidence.

Generation now passes after the relation correction. API checking identified a
widened consent-version type, now preserved as the exact protocol literal.

The existing desktop/mobile operator journey now covers publishing the newly
created EUR-seat/USD-usage version and withdrawing future purchases from its
Company policy home. It uses synthetic routes and cannot contact live billing;
rendered execution remains pending at this checkpoint.

At `7f71d406`, API/admin typechecks passed, eight existing base Checkout tests
and five entitlement tests passed. The three new persistence cases exposed the
older operator-assignment-only company source CHECK. The corrective source rule
permits an unassigned company subscription only through its exact accepted
published-offer Checkout, verified by a database trigger; ordinary unassigned
company subscriptions remain forbidden. Acceptance tests are being rerun.

Provider-ended phone resources retain unpaid financial history but do not enqueue
further cancellation warnings or occupy event/email work budgets. Final email
copy states the preserved original deadline and the actual relative24h delivery
safeguard; it does not promise an absolute deadline computed before SMTP accepts
the message. Fresh receipt proof still enforces the true earliest release time.

At `33247fde`, all217 migrations deployed and all three Standard acceptance
database regressions passed without skips. The updated desktop/Pixel7 operator
publication and withdrawal journey passed2/2. New wire cases verify member
omission, exact actor/locale forwarding, no-store, explicit accepted frozen action
and refusal of guessed private tariff selection before mutation.

Screenshot inspection showed the mobile publication action required horizontal
table scrolling. Published offer rows now wrap their existing details and action
within the viewport; the same single rendering is used on desktop and mobile.
The EUR-seat/USD-usage form screenshot shows both valuation fields explicitly.

Immediate first usage requires complete, fresh Ledger source proof as well as
absence of durable UOA acceptance/admission/liability evidence. A durable worker
checks one company-history month per claim using exact organisation metering and
cryptographically verified organisation budget receipt sets. Unknown, pending,
unresolved or unavailable evidence holds only the proposed usage activation;
verified paid seats and existing independently funded terms remain authoritative.
The cursor resumes after replicas/restarts and does not discard historical source
months. Any observed prior metering schedules the new usage terms next UTC month;
all-zero history through the current month permits prospective activation.
This proof/recovery path is coded and its expanded verification is pending.

For explicitly purchased public seats, cycle closure resolves the team's accepted
usage tariff for that month independently of the frozen new seat tariff. Earlier
prepaid receipts retain their exact price and debit evidence. A collectible older
usage liability without covering debit evidence holds for reconciliation rather
than being collected through the new agreement or re-rated. Historical subscriptions
retain their existing frozen source behavior. The mixed-terms financial regression
is being added before this separation is considered verified.

The real regional financial test now adds public EUR seats over a previously
accepted, independently funded zero-markup USD prepaid usage agreement. Its
receipt must debit10 credits, retain90, and close/invoice only the exact EUR seat
amount; selecting Standard must not turn the older debit into13 credits.

The first-usage recovery regression now simulates a source outage, retains the
same durable pending purchase, then supplies a real RS256 signed exact-company
zero receipt set through the production verification function. It must activate
only at the new observed source-acceptance time and retain the signed evidence.

The outage regression uses its actual post-fixture time and asserts an attempted
source read, avoiding a false pass caused by a future durable retry slot.

Storage outcome discovery revisits the head after a completed negative scan:
the original scan can predate an external create whose response was lost.
Freezing that absence would strand an existing remote payment after23h.
Incomplete scans retain durable page progress; ambiguous matching outcomes hold
instead of issuing another purchase. Focused response-loss regressions are added.

After revisiting the head, page progress compares against the reset cursor,
so a formerly complete multi-page scan can resume instead of rescanning page one.

The database recovery journey covers Friday failure, Stripe initial expiry after
23h, preserved Monday pending capacity, exact signed manager recovery and same
action replay. Only one replacement outcome and two total generations are
permitted; the original weekday deadline and unpaid debt must remain unchanged.
This new full recovery regression is coded and execution is pending.

Recovery now uses the shared exact invoice/customer/subscription/price/quantity/
period validator before treating an initial attempt as terminal unpaid. Matching
only customer and subscription metadata would not prove the required liability.

A seat debt does not itself establish a company paid agreement. Current access
still requires an independently effective company seat agreement, trial or
private company policy. Dunning remains visible to managers for old/team-scoped
debts, but cannot revive an ended agreement or license other company teams.

Public company seat purchase does not assume pooled credit responsibility or move
existing wallets. Its cycle validates each frozen usage receipt's exact company
pool or exact source-team wallet independently of the seat invoice payer. Another
team's wallet cannot cover that receipt. Consumption can be aggregated for company
billing without claiming a pooled opening/closing balance that does not exist.
Historical non-public subscription evidence keeps its original payer rules.

The expanded regional database journey includes a paid company seat agreement
whose prior10-credit usage debit belongs to its original team wallet. It must
close and invoice the EUR seats without creating an organisation wallet,
assuming pooled responsibility or moving the remaining90 USD credits.

Maxis verification at84f7f133 passed API typecheck and twelve focused cases:
six real database regional seat/prepaid journeys and six entitlement cases.
The independent team wallet remains authoritative for its accepted receipts;
old or team-only unpaid seat evidence cannot establish company-wide access.

The commercial-delivery database regression covers more than100 old resolved
warnings before new work, all current company managers without ordinary members,
the registered application recovery origin independently of its API issuer,
SMTP retries with stable message identity and no fabricated acceptance, fresh
role revalidation, receipt conflicts, a delayed final warning's full24hours,
and terminal service filtering that preserves unpaid financial history.
This new delivery suite is coded; execution results are pending.

At98095c83, Maxis API typecheck and all four commercial-delivery PostgreSQL
cases passed with zero skips. The mobile Standard plan publication/withdrawal
screenshot was inspected again after the wrapping-row change; the complete
withdrawal control is visible inside the viewport.

The private company policy database suite now covers the operator's visible
future effective date, rejection of a later marked-up team override before any
assignment mutation, next-month standard reassignment, and append-only removal.
Current accepted private terms remain effective until the exact transition;
historical tariff evidence is never rewritten. Execution is pending.

Prepaid input-cost validation lives with the existing credit-rating arithmetic;
the reservation orchestrator imports that single parser for bounds and receipts.
The accepted decimal format, rejection codes and rating behavior are unchanged.
This keeps the changed reservation source within the repository's500-line limit.

The expanded old-prepaid verification found historical raw SQL test seeds that
omitted the newly required usage valuation currency. Those fixtures now name
their original USD usage explicitly; the production constraint remains strict.
Before that correction, API typecheck and27 tariff/rating unit cases passed,
but prepaid suite setup failed and its15 database cases did not execute.

The same audit covers30 direct Prisma historical tariff fixtures across billing
cycles, contracts, corrections, seats and customer invoices. Every existing
literal-currency fixture now explicitly preserves that same usage currency.
No provider cost, wallet, customer balance, historical invoice or production
tariff term is changed by this fixture correction.

Contract activation explicitly persists its normalized usage valuation currency
as well as its seat currency. Existing negotiated terms retain their own original
currency; this does not extend regional cross-currency Standard terms to manual
contracts or change any accepted contract.

Private policy assignment and reads resolve actual company terms, including the
existing negotiated-contract precedence, against their immutable private tariff
evidence. A later accepted normal contract cannot retain an older private waiver;
an operator attempt to assign conflicting private evidence is rejected before
mutation. Company-only tariff resolution excludes team override candidates.

The old-prepaid suite now permits a bounded30-second transaction specifically
for its routed signed-proof fixture, and90seconds for its ten-transaction
cumulative-liability case. Production transaction bounds are unchanged. Its
prior30-second test timeout interrupted the loop and contaminated later shared
fixture expectations; that run is not claimed as passed. The isolated populated
history migration fixture also discards the empty newer foreign-key consumers
when rewinding its historical table, without touching any shared/live schema.
