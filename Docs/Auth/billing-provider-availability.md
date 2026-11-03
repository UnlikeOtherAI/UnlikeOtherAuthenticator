# Billing provider availability — reads survive, payments fail closed

Stripe is the authority for **taking money**. It is not the authority for what
an organisation's credits are: that is UOA's own `BillingCreditAccount` ledger.
This document defines what happens to a billing call when the configured
payment-provider account cannot be resolved.

## The rule

`resolveStripeAccountContext` resolves the configured provider account on every
Stripe-backed billing call and maps an authentication, permission, connection,
rate-limit or upstream failure to `503 BILLING_PAYMENT_PROVIDER_UNAVAILABLE`.
That stays exactly as it is for **mutations**: a top-up checkout, an automatic
reload consent, a subscription change or an SMS purchase refuses rather than
guess.

**`POST /billing/v1/credits` is largely exempt**, and so is
`POST /billing/v1/credits/funding-request`, because asking a manager for credits
moves no money and the credits view offers that action while collection is
frozen. The read uses
`resolveCreditCollectionContextForRead`, which resolves the provider account as
before and, only on `BILLING_PAYMENT_PROVIDER_UNAVAILABLE`, falls back to the
`BillingStripeAccount` row already persisted from the first time the provider
*was* reached. The projection it returns then carries:

- `collection.stripe_collection_enabled: false`
- every funding action disabled (`capabilities.can_top_up: false`,
  `can_manage_automatic_top_up: false`)
- the organisation's real credit balance, entries and attention — UOA's own
  state, not a substituted zero

That is byte-identical to the context a deployment with `STRIPE_BILLING_ENABLED`
off already produces, so no new shape reaches a consumer and no payment can be
started from it.

Two constraints keep the fallback honest.

**It never crosses provider modes.** Freezing collection does not stop the read
settling usage against whatever account it resolved, so the fallback matches the
configured secret key's own test/live mode and considers nothing else. A
deployment that moved from a live key to a test one does not reach its
historical live-mode account, and vice versa. Where no account exists in the
configured mode — including a deployment that never reached the provider once —
the provider's refusal stands.

**Two rows are not two identities.** A team's own credit account and its
organisation's legitimately coexist while organisation billing responsibility is,
or once was, assumed: a team balance is never swept on assume or release. All the
fallback resolves is one provider identity, so it is the account those rows point
at that must be unambiguous, not how many rows point at it. Two *distinct*
identities for one subject remains `409 BILLING_CREDIT_ACCOUNT_AMBIGUOUS`, raised
as itself — a permanent conflict an operator must resolve is never reported as a
temporary outage. The same holds for a database failure during the lookup.

The fallback logs at error level once per read, because nothing else shouts when
a read keeps working.

## Why

A product that lets anyone found an organisation must let a founded
organisation function before billing exists. The blanket refusal made that
impossible, and circularly so: the billing region is the one thing an owner must
choose before the organisation can ever be charged, and in Nessie the region
read is gated on the capability read, which is the credits read. With the
provider credential expired, the credits read 503'd, the capability never
resolved, the region page never loaded, and the owner had no way to set up the
billing whose absence was being complained about.

This was not hypothetical. UOA's configured Stripe test-mode key expired
(`api_key_expired`, Secret Manager binding `uoa-auth-stripe-secret-key:latest`)
and from 2026-10-22T20:32 UTC **every** `POST /billing/v1/credits` in the estate
answered 503 — not just those for organisations with no billing. See
`Docs/deployment.md`.

## It is an exemption, not a guarantee

The read still answers `503 BILLING_PAYMENT_PROVIDER_UNAVAILABLE` when the
constraints above cannot be met: no account on record in the configured mode,
including a deployment that never reached the provider once. `/api`, `/llm` and
this document say so, and the consumer guidance for that case is unchanged —
keep the session, retry with backoff, and never substitute a zero balance or
admit paid work.

A configuration from which no mode can be read is *not* one of those cases. The
env schema enforces the same `sk_`/`rk_` test-or-live prefix
`stripeSecretKeyLivemode` checks, so such a deployment fails validation rather
than serving a read, and `STRIPE_SECRET_KEY_MODE_UNKNOWN` cannot reach a
consumer from configuration at all. The fallback still normalises it to
`BILLING_PAYMENT_PROVIDER_UNAVAILABLE` and refuses without touching the
database — defence in depth should those two prefix rules ever drift apart,
since `STRIPE_SECRET_KEY_MODE_UNKNOWN` is not a public error code and a bare
503 with no code is worse than the documented one.

## What this does not change

- Payment mutations keep failing closed, with their existing idempotency and
  reconciliation requirements.
- No consumer-visible contract field is added or removed, so no credits
  protocol version bump is required.
- `GET /billing/v1/organisation-billing` and
  `/billing/v1/organisation-billing/region` never touched Stripe and are
  unchanged; `setOrganisationBillingRegion` already captures the region's
  exchange rate opportunistically and tolerates a rate it cannot read.
- An organisation with no tariff, subscription, credit account, payment method
  or region was always projected correctly; see
  `API/tests/integration/billing-credits-no-billing.persistence.test.ts`.
- Every payment-bearing action — top-up checkout, automatic reload consent,
  subscription and SMS purchases — keeps `resolveCreditCollectionContext`.
