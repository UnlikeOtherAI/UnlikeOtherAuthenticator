# Central billing production release evidence

- Date: 2026-07-22
- Evidence capture completed: 2026-07-22T09:02:51Z
- Environment: production services with Stripe test-mode collection

## Outcome

Centralized credits and billing are deployed across UOA, Nessie, DeepWater,
DeepSignal, and DeepTest. UOA is the sole commercial authority. Ledger remains
the raw usage and provider-cost authority, and each product renders UOA's
display-ready models without calculating prices, credits, subscriptions, or
invoices locally.

The final concurrent-credit release gate completed successfully: ten
synchronized waves made 40 product reads, all returned HTTP 200, and every read
resolved the same team credit account, actor subject, and balance. The four
products authenticated with four distinct product credentials and four
distinct storefront identities. No HTTP 500, HTTP 503, or PostgreSQL `23514`
failure occurred. Thirty-seven serialization conflicts were recovered inside
UOA without reaching a customer.

## Published revisions

| Service             | Remote `main`                              | Successful automation                                                                                                                                                                                          |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UOA/SSO             | `32bd469b03e82b1bd3238478c442a097077af411` | CI [29905729503](https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator/actions/runs/29905729503); Deploy [29905729368](https://github.com/UnlikeOtherAI/UnlikeOtherAuthenticator/actions/runs/29905729368) |
| Nessie              | `d82862982e2924ed67b747ce993fd546328d83c5` | CI [29894304357](https://github.com/UnlikeOtherAI/Nessie/actions/runs/29894304357); Deploy [29894304368](https://github.com/UnlikeOtherAI/Nessie/actions/runs/29894304368)                                     |
| DeepWater (`water`) | `f60c24ae75ec42181b864584b623c1d152132314` | Deploy [29894332449](https://github.com/UnlikeOtherAI/water/actions/runs/29894332449)                                                                                                                          |
| DeepSignal          | `7062516c1e1045f5ee6580aeb3a946b2fb8baca5` | Deploy [29897686948](https://github.com/UnlikeOtherAI/deepsignal.live/actions/runs/29897686948)                                                                                                                |
| DeepTest            | `58ec6c702a11cdd0ef88df05466382e294eafe1d` | CI [29897491134](https://github.com/UnlikeOtherAI/DeepTest/actions/runs/29897491134); Hardening Gate [29897491161](https://github.com/UnlikeOtherAI/DeepTest/actions/runs/29897491161)                         |

All listed runs completed successfully. The UOA concurrency fix was task commit
`a45d00b0f2df0b5849448aece2f5b7095f3bf173` and was merged into the UOA release
above.

UOA Cloud Run revision `uoa-auth-00174-fwq` is Ready, is both the latest-created
and latest-ready revision, and receives 100% of production traffic. It runs the
exact `32bd469b03e82b1bd3238478c442a097077af411` image at digest
`sha256:7a58e2dc241cf2ab4940170be99cad0b9446608d387b8f6176a30e08ee512017`.
The public UOA health endpoint returned HTTP 200 with `{"ok":true}` after the
deployment.

## Source-of-truth boundary

- Ledger records immutable raw tokens, API/SERP/research usage, provider cost,
  and exact product, team, and user attribution.
- UOA owns tariffs, commercial rating, credits, statements, top-ups,
  subscriptions, add-ons, adjustments, cancellation decisions, contract
  invoices, and Stripe lifecycle state.
- A product uses its own revocable, purpose-bound UOA application credential and
  a short-lived actor assertion. Credentials are not shared across products.
- Products consume the public billing protocol and render UOA-authored labels,
  values, breakdowns, and frozen actions. They do not query Ledger's raw billing
  data or maintain parallel commercial state.
- Stripe is the payment processor, not a billing authority. UOA remains the
  source of customer entitlements and balances after webhook verification.

## Shared credits evidence

The required heading is **Remaining credits**. The shared-team display leads
with the remaining balance, followed by pending, added, and used credits,
connected-service usage, recent activity, and automatic top-up status. UOA fixes
the customer conversion at 1,000 credits = US$1. Products never convert raw
tokens, provider cost, or money into credits.

The final ten-wave gate returned the same display-ready remaining balance from
Nessie, DeepWater, DeepSignal, and DeepTest on all 40 reads:
`-1,172.91057 credits` in debt state. The legitimate metered usage behind that
balance was:

- DeepWater: `936.57365 credits`
- Nessie: `236.33692 credits`
- Total: `1,172.91057 credits`

The concurrent snapshot fix treats an equal or older unseen Ledger cursor as a
successful superseded no-op, so out-of-order captures cannot roll the shared
team projection backwards. The gate's recovered serialization conflicts and
absence of customer-visible failures demonstrate that contention is contained
inside the UOA transaction boundary.

## Stripe test-mode lifecycle

The complete flow was exercised in Stripe test mode:

1. Setup Checkout attached a test payment method and recorded current automatic
   top-up consent.
2. Exactly one automatic US$25 refill added 25,000 credits; no duplicate refill
   was observed.
3. Automatic top-up was disabled through UOA's frozen action contract.
4. Manual US$10 Checkout added 10,000 credits.
5. DeepWater Privacy activated at US$50/month after UOA verified the paid
   initial invoice.
6. UOA cancellation preview and confirmation scheduled period-end cancellation.

The test state was then fully reversed. The subscription was canceled, all
three test payments (US$50, US$25, and US$10) were fully refunded, both test
payment methods were detached, the test customer's default payment method was
cleared, and the 25,000- and 10,000-credit funding entries received matching
refund debits. The DeepWater Privacy entitlement is inactive and no test
subscription remains attached. No test payment remains unrefunded and no live
charge was created.

This release evidence covers Stripe test mode only. It does not claim a
live-mode payment or live customer charge.

## Contract invoice evidence

An isolated, clearly labelled TEST organisation contract was exercised with a
20% organisation usage margin, USD currency, June 2026 period, and four fixed
monthly service terms. The production flow completed calculation, issue, UI PDF
download, history retrieval, void, terminal-action verification, and post-void
PDF download.

- Invoice ID: `cmrvtifdb0003s601fqd8hcxe`
- Invoice number: `TEST-UOA-E2E-2026-000001`
- Final status: `VOID`
- Issued: `2026-07-22T08:25:53Z`
- Voided: `2026-07-22T08:25:55Z`
- Customer-safe service lines: 4
- Gross total: US$10
- Credits applied, paid, and write-off totals: zero

The issued and post-void downloads are byte-identical, valid one-page PDF 1.7
documents and passed Poppler inspection. The customer document exposes only
calculated service prices and settlement totals. It does not expose raw tokens,
API/SERP/research quantities, provider cost, margin arithmetic, or private
Ledger evidence. A warning from one legacy PDF parser was isolated to that
verifier; standards-based PDF inspection and both product downloads succeeded.

## SSO and renewable-session evidence

- Nessie serves healthy providers, signed config, JWKS, and API endpoints. Its
  UOA refresh token is encrypted in durable PostgreSQL state and bound to a
  rotating local refresh family and immutable UOA credential epoch.
- DeepWater serves a healthy signed config and JWKS. An empty refresh request
  fails with HTTP 401, and renewable state is UOA-backed HttpOnly state rather
  than a process-memory session.
- DeepSignal reports `uoa_sso`, PostgreSQL session authority, AES-256-GCM
  encryption, hashed identifiers, and multi-replica safety from production
  health. Its signed config and JWKS are healthy.
- DeepTest serves its signed config and JWKS. Its encrypted UOA session envelope
  is PostgreSQL-backed, and unauthenticated session access fails closed.
- UOA validated all four product configs and rendered the Google authorization
  route.

The exact live proof that remains unperformed is a real Google callback followed
by a renewable-session refresh across a service restart. A safe signed-in
production test session was not available, so this release does not claim that
specific browser-level restart exercise. The durable storage, rotation,
revocation, and fail-closed seams are deployed and covered by their automated
and credential-free production probes.

## Security and operational notes

- The UOA runtime database connection uses restricted role `uoa_app`; migration
  and rollback use `uoa_admin` separately. The production startup boundary
  fails closed if that separation is absent.
- Eight pre-existing project-level Secret Manager accessors remain inherited.
  This is a known IAM-hardening caveat outside the runtime database-role
  separation verified by this release.
- Zero-traffic rollback references `canonical-rls`, `stripe-canary`, and
  `admin-rb-0722` are intentionally retained for observation and recovery. They
  do not receive production traffic.
- A Stripe CLI test credential displayed during verification was removed from
  the local CLI with a full logout. Dashboard rotation/revocation of that
  credential, restoration of CLI login, and proof that the old credential is
  rejected remain pending the user's Stripe MFA step. No credential value,
  capability URL, token, or fingerprint is retained in this document.

## Release conclusion

The centralized billing implementation and the production test-mode flows are
deployed and verified. The only external security handoff still open is the
MFA-gated Stripe CLI test-credential rotation. The real-Google post-restart
browser exercise remains an explicitly documented evidence gap rather than an
asserted result.
