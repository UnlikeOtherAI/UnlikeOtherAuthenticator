# Refund and dispute lifecycle audit — 2026-10-04

This audit records the existing behavior called for by P0/B of the approved
billing UX plan. It does not define new refund policy. Seats and storage are
outside its scope.

## Credit purchases

Credit refunds and disputes have a dedicated Stripe adjustment path. It handles
`refund.created`, `refund.updated`, `refund.failed`,
`charge.dispute.funds_withdrawn`, and
`charge.dispute.funds_reinstated`. Preparation retrieves the current Stripe
object and original PaymentIntent, checks the event/object fields, Stripe
account mode, customer, PaymentIntent, charge, currency, and exact local binding,
then waits or fails retryably when evidence is pending or inconsistent. Local
binding is restricted to completed one-time top-ups and successful automatic
top-ups; it does not bind subscription invoices.

Applying an adjustment appends an immutable adjustment row and, when the net
amount is nonzero, one linked credit entry. Separate refund and dispute objects
are aggregated against the original paid credits, with total applied principal
capped at that payment. Reversals restore only the net principal removed after
all matching refund and dispute objects are considered. A refund debit remains
exact even when the credit balance has already been spent; the account can go
negative from a verified refund/dispute debit, while usage settlement itself
cannot spend below zero. Replaying the same adjustment object is a no-op, and
the database protects adjustment binding, amount, provenance, and append-only
evidence.

Verification used synthetic fixtures and an isolated database created by the
existing test helper; no Stripe requests or customer data were used.

- The preparation unit suite verifies succeeded and pending refunds, drift and
  missing-payment retries, unrelated legacy refunds, and dispute settlement
  currency conversion (`billing-credit-payment-adjustment-webhook.service.test.ts`).
- The persistence suite verifies a partial dispute reinstatement and overlapping
  partial refund/dispute/reversal reconciliation. Its synthetic seed records
  usage settlement debits that consume the paid top-ups. Added cases verify that
  a partial refund still debits after those credits are spent, a second Stripe
  event for the same refund object does not debit twice, and a reversal delivered
  before its refund leaves no net debit when the refund arrives
  (`billing-credit-payment-adjustment.persistence.test.ts`).
- The focused run passed: 5 preparation unit tests and 5 persistence tests.

## Base subscriptions and recurring add-ons

Credit refund/dispute handling does not cover base subscription invoices or
recurring add-ons. The base subscription projection is updated from Stripe
subscription lifecycle events and stores Stripe's current status, period, and
cancellation flag. Refund/dispute events are not base subscription lifecycle
events, and the credit adjustment binder cannot attach those payments to a
credit purchase. No existing written policy says that a base-plan refund or
dispute revokes product access.

Recurring add-ons have a separate lifecycle. A verified initial `invoice.paid`
activates the entitlement; a verified paid cycle invoice advances the period.
`invoice.payment_failed` observes the invoice and synchronizes the current
subscription status, but does not itself mark the entitlement deactivated. The
current add-on projection deactivates access only when the verified subscription
becomes `canceled` or `incomplete_expired`; a late renewal cannot reactivate a
terminal entitlement. Refund/dispute events are not handled by this add-on
webhook path. The database test verifies renewal proof retention and that a late
renewal cannot undo cancellation (`billing-recurring-addon-webhook.persistence.test.ts`);
it does not assert any refund/dispute access effect.

The approved plan explicitly requires separate evidence of refund/dispute
access policy for subscriptions and add-ons and forbids inferring subscription
cancellation from credit refund behavior. Therefore this is a documented policy
gap, not a confirmed implementation defect. No access-changing handler was
added. Before claiming these lifecycles fully cover refunds or disputes, UOA
needs an explicit product policy and matching scenarios for base subscriptions
and recurring add-ons.

## Frozen recurring Checkout language

The nullable `checkout_locale` columns are constrained to the supported display
languages; existing Checkout leases remain `NULL`, preserving their previous
Stripe request shape. New recurring add-on leases store the first negotiated
locale. On a lost Stripe response, a retry reuses that stored locale and the
same idempotency key even if the next request supplies another language.

This freeze is enforced by the service path. The recurring add-on checkout's
existing immutable-snapshot trigger also covers the new column; the base
`billing_stripe_checkout_sessions` table originally had only its scope-coherence
trigger, so the locale column was not independently immutable at the database
layer. A follow-up additive migration now rejects changes to that field, with a
PostgreSQL mutation regression in
`billing-stripe-checkout-locale-immutability.persistence.test.ts`.

The new focused unit regression simulates a Czech request whose Stripe response
is lost, then a German retry. Both Stripe creates use Czech and identical
idempotency options (`billing-recurring-addon-checkout-locale.test.ts`). It
passed alongside the existing subscription Checkout lost-response locale
regression (`billing-stripe-checkout.service.test.ts`).
