# Central browser billing

Nessie uses one Browserbase account managed by a Nessie instance superuser.
UOA owns the tariff, prepaid reservation, debit and customer credit history.
Ordinary org/team roles cannot publish rates or issue runtime credentials.

## Setup

Open Admin → Billing → Nessie → Cloud browsers. Publish the provider USD hourly
usage rate and Browserbase price evidence URL for the project. The customer
rate is fixed at that hourly rate / 60 × 1.10, charged per started minute with
a one-minute minimum. Nessie absorbs the fixed subscription fee; included
provider minutes do not change the customer rate. Review/renew within 90 days.
An expired tariff refuses new admissions but never invalidates existing receipts.

Create a separate Browser runtime app key using Nessie's existing actor issuer,
audience and public key. Install it as UOA_BROWSER_RUNTIME_APP_KEY_NESSIE before
Nessie deployment. A lifecycle, entitlement or telecom key cannot authorize
browser use. Never expose the runtime key to a customer's browser.

## Funding and recovery

The Browser runtime key and endpoint-bound human actor assertion reserve live
prepaid credit and shared budgets before one durable dispatch claim. Provider
creation has a 30-minute maximum and a minute of accounting headroom is held.
Payer, team, source project/run, tariff and maximum duration are immutable.
Only the original physical browser is charged; same-payer joins share its
remaining window and never extend it. Actor revocation blocks new claims while
machine receipt delivery can settle costs already incurred.

Every reservation and first dispatch claim also checks Nessie's current seat
access and a card bound to the organisation's live Stripe account. A funded
wallet alone does not grant either. Losing eligibility between reservation and
claim refuses dispatch; read, release and incurred-usage settlement remain
available. Authenticated browser routes return `402 NESSIE_BILLING_SETUP_REQUIRED`
for missing card setup and `402 BILLING_SEAT_PAYMENT_REQUIRED` for held seats.

A definite non-creation proof releases the hold. Timeout, an empty provider
lookup or a 5xx response does not. Terminal provider timing is rounded by the
frozen policy, rated once with the shared cumulative integer credit ledger,
and debited atomically. Unknown receipts retain funds and block new provider
spend rather than silently recording zero usage.

Unexpected proxy usage or an overlong session creates an immutable entry in
Billing → Usage exceptions. The same existing operator review flow caps
the collectible debit at the original reservation, records any excess as an
explicit waiver, preserves gross usage for budgets, and logs the decision.

Proxy bytes remain evidence; customers are billed only for browser minutes.
A stale/revoked operator cannot decide; retries and concurrent decisions never
debit twice. Nessie's receipt retry observes the completed decision, and the
superuser can then reverify the provider connection before new work resumes.

Organisation LIVE/Sandbox changes remain blocked by every existing financial
source: active contracts, commercial adjustments, non-free budget dispatches
and the provider guard. Reserved, dispatching and reconciliation browser
reservations add their own blocker. The forward guard migration composes these
checks without changing captured accounts, modes or financial history.

## Contract and checks

The public /api schema and /llm describe all browser endpoints. The versioned
contract is packages/billing-statement-protocol/BROWSER-BILLING.md. Test
billing-browser.persistence.test.ts and billing-paid-usage-exception.persistence.test.ts
against isolated migrated PostgreSQL; unit tests cannot prove wallet races.
The protocol is vendored into Nessie from the committed UOA source revision.
`billing-browser-admission.persistence.test.ts` covers funded wallets without
card or seat eligibility, eligibility lost before claim, and settlement/release
after access is held.
Browser migrations bound lock waits to five seconds and statements to two
minutes, including changes to the existing paid-usage exception table.

The cross-repository `billing-browser-nessie.contract.test.ts` journey loads
Nessie's built production adapter and exercises actual authenticated UOA routes
against fresh migrated schemas. Run it from Nessie's `test:browser-contract`
Turbo task with the prepared UOA checkout and separate dedicated test databases,
as documented in Nessie's central browser billing focused gate. It checks holds,
original payer/team, integer-credit settlement, unused-hold release, concurrent
admission and retry after a lost settlement response. Provider HTTP, opening
credit and Stripe account identity are synthetic; this does not prove payment
collection or actual Browserbase receipt compatibility.

Authenticated browser-route production responses preserve the safe refusal codes for insufficient credit,
budget limits, reconciliation, missing tariff/live funding and wrong-purpose or
revoked app credentials. Nessie uses them to distinguish customer funding from
operator setup and temporary failures. They expose no amounts, identity directory
or credential material; other routes and unauthenticated diagnostics remain generic.
