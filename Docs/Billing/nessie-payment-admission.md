# Nessie payment admission

UOA is the authority for human membership, invitations, seat coverage, credit
balances and billing. Nessie renders decisions and keeps no duplicate financial
or identity store. This coordinated change is not yet deployed.

## Member-safe access read

`POST /billing/v1/organisation/access` uses a CUSTOMER_LIFECYCLE credential,
the exact endpoint actor audience and the original human subject. The request
is the existing strict product/organisation/team/user subject. The service
reauthorizes current membership before and after reading the projection.
Responses are private and no-store. Version 1 contains:

- `schema_version: 1`, `generated_at` and the exact `subject`;
- `can_manage_billing`, derived from current organisation authority;
- `access: { allowed, status, deadline }`, with status `paid`, `agreement`,
  `transition`, `renewal_grace` or `payment_required`;
- `consumables: { available }`, based on spendable organisation credits after
  active reservations, current Stripe account/mode and explicit usage subsidy;
- `manager_reason` only for organisation billing managers: `setup_required`,
  `transition_ended`, `payment_required`, `payment_action_required`,
  `card_expired`, or null.

No amount, card identifier or payment diagnosis reaches ordinary members or a
team administrator without organisation billing authority. A renewal diagnosis
records why that renewal failed; it does not assert that a subsequently replaced
card is still expired. The read neither charges a card nor authorizes supplier
spend. Supplier dispatch still needs its own bounded reservation and card setup.

## Seats and invitations

New and pre-cutover default-plan organisations enter the regular paid plan.
Explicit agreements retain their terms. The 14-day transition freezes the
original member cohort and deadline. It never includes consumables, resets on
login or grants new members an allowance. Adding a person ends it and requires
collection for all existing seats and the invitation before delivery.

Invitation creation commits the held intent before provider IO. Payment failure
retains it. Resends and cross-team invitations reuse the original funded seat
within its scope. A fresh tenant transaction rechecks authority and the database
payment predicate before minting the token. The user retries delivery after
payment; a payment webhook never sends invitation email by itself. Acceptance
uses the funded seat. Removal, expiry and cancellation retain their financial
history and queue agreed quantity reductions without automatic refunds.

Collected invoice periods bind the exact subscription, account, currency and
line. Provider status alone, an unpaid minimum-charge carry, an open Checkout or
a redirect cannot grant access. Cash adjustments for refunds and disputes affect
current coverage. Renewal recovery retains the first failure and fixed deadline;
only that invoice's verified payment clears it. A completed event-history proof
survives retries beyond Stripe's event-history window. The recovered commercial
policy uses 24 weekday hours in UTC for seat-renewal recovery; this is distinct
from the new 14-day allowance and must not be described as verified hosted policy.

## Rollout and verification

Deploy the UOA authority before the Nessie consumer. Before migration, inspect
existing service defaults, explicit assignments, regional prices and subscriptions.
The migration requires approved USD/EUR/GBP automatic prorated prepaid per-seat
catalogues and refuses existing default-plan subscriptions that need their agreed
terms bound first. Provision the matching Stripe catalogues through the existing
supported provisioning interface; never fabricate price IDs or payment evidence.
Check the current account, mode, webhook configuration and credentials separately.
No migration charges historical usage or implies payment consent.

The read-only production preflight on 15 November 2026 at 21:34 UTC found the
three approved regional catalogues and no active Nessie Stripe subscriptions.
It ran against deployed source `6c5eecf963604cb2253613051f3473dc7fa9fd36` in job
`uoa-seat-preflight-20261115-73934e98`, execution `hnbf9`. The current default was
still AT_COST/NONE/PAYG. This verifies the cutover inputs, not migration completion
or Stripe collection.

A second read-only execution, `mvkvb`, confirmed none of this PR's migrations
had been applied in production. The pending billing migrations use five-second
lock waits and two-minute statement limits so migration lock contention cannot
leave live authentication waiting without a bound.

Fresh-database tests cover migration execution, invitation holds and collection,
cohort immutability, concurrent quantities, acceptance without double charging,
prepaid exhaustion, renewal deadlines and paid recovery. A seeded upgrade with
existing published regional catalogues must also pass before release. Unit tests
cover cross-product origin proof, expired-card binding and employee privacy.

Follow Nessie's `docs/testing/paid-operation-manual.md` through real user entry
points for new and existing organisations. Record exact revisions and separate
synthetic boundary tests from actual Stripe and telephony evidence. An expired
test key blocks provider verification; do not mark those cases passed.

## Invitation and current-payment revalidation

Each invitation attempt rechecks the current org/team permission before
collection and again in the token-and-email transaction after collection.
A role change or a new approval requirement leaves the paid intent retained
and sends no invitation; an authorised person can retry through the existing flow.

Current paid access requires retained cash for every recognised seat receipt
covering the current period, including a prorated additional seat and a collected
minimum-charge carry. A fully paid base invoice cannot hide a refund or dispute
on another current seat. A dispute reversal can restore coverage. Carried
coverage does not clear the receiving invoice’s renewal failure without its
own non-carried seat-period proof.

A first free-to-paid change starts its allowance at the term’s effective time,
including an explicit team plan and organisations created after the billing
cutover. Due term writes capture the roster immediately; a scheduled term also
captures it before the first later membership mutation. Members added through
a still-free organisation cannot become part of a paid team’s original cohort.
A later login, team switch or repeated term does not rewrite an existing allowance.
