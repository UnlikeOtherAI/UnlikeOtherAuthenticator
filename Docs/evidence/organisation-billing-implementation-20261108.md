# Organisation billing implementation checks

This is an implementation checkpoint, not release or activation acceptance.
Source starts at deployed `2694c8088a18525f68589d5516074020856d1db9`.
Public protocol 6.2 is pinned at `e968ac99aa2469e7e0bd64763a8e8ab6dd0b4120`.
The optional organisation attention contract is protocol 6.3 at
`cae2fc86f58d1ba45112088ebbd2833d768b79bc`; the 6.2 financial family is unchanged.
No credentials, provider configuration, payment or production database operations
were performed by this implementation thread.

## Local checks on Maxis

- API source build and ESLint on changed API source/tests pass.
- Independent overview/context/cache schema regressions: 12 tests pass.
- Actor endpoint registry, nonfinancial Ask route/service and captured
  cancellation unit suites: 27 tests pass. Confirmation no longer re-fetches a
  current-mode summary to replace its stored preview target. Cancellation
  previews use organisation financial subscriptions rather than Ledger usage
  attribution; a subscription with no current users remains a liability that
  its manager can cancel.
- The disposable real PostgreSQL suite covers organisation LIVE default,
  audited whole-org Sandbox selection/future teams, retired team policy writes,
  exact epoch/revision/mode capture, current manager authority, org-only endpoint
  authority, inclusive cutover holds, retained balances and the nonfinancial
  cross-team/org-only Ask recipient query. SQL authority is exercised directly;
  the Ask recipient test stubs actor tariff verification explicitly and does not
  claim an end-to-end signed API journey.

Logs are ignored under `.billing-mode-qa` pending the final durable evidence
archive outside worktrees. The original PR143 archive remains unchanged.

The attention/overview/PostgreSQL gate passes 21 tests. Attention reads only the
current organisation wallet, canonical reservations, captured consent and stored
provider payment-method evidence. It does not call Ledger, FX, Checkout or Stripe.
An absent policy or unproven card summary is unavailable, never a confirmed empty
result. The PostgreSQL case retains a positive historical TEAM TEST wallet and
proves that it neither supplies the organisation balance nor its attention. The
confirmed credit response explicitly discloses excluded retained TEAM funds.
An inclusive organisation mode-change month remains pending for settlement even
when the confirmed wallet balance is available. Account lookup requires the named
provider account as well as mode; mode-only lookup is refused.

The revised real PostgreSQL lifecycle suite passes 23 tests. It executes actual
TEAM deletion jobs with product acknowledgements, preserves the last team's
organisation and active people, creates a replacement team through the supported
team service, preserves a synthetic already-funded captured TEST wallet/customer
byte-for-byte, and proves the inclusive financial month hold still refuses both
before and after deletion. An old TEAM job expanded to organisation scope is
refused before product delivery/execution and remains visible for reconciliation.
Explicit organisation deletion and bounded resumable erasure checks still pass.
This proves the service flow, not yet the rendered Admin or Nessie browser flow.

The rendered Admin checkpoint uses the actual base `2694c808` and the local
implementation against an owned disposable PostgreSQL schema on Maxis. Chromium
desktop (1440×1000) and Pixel 7 (412×839), light/en-US, pass the global organisation
doorway, organisation LIVE display, Sandbox save/reload, team doorway, stale edit
409 followed by refresh, funded-history 409/disabled controls and last-team
preservation preview. Anonymous reads return 401; a valid non-superuser session
returns 403; the retired team mode write returns 409. The session was provisioned
locally: this does not claim production or Google sign-in. Before/After images
and sanitized flow records are outside worktrees at
`D:/BuildArtifacts/uoa/organisation-billing-20261108`. The organisation mode tab is
new; it has no equivalent base screen. No provider calls or payments were made.
API/Admin builds, focused Admin copy/page tests and changed-source lint pass.

Shared org-manager admission passes three real PostgreSQL scenarios: owner/admin
chooser, directory and hidden-team entry without TeamMember writes; ordinary
member limits and immediate role/account-expiry refusal; and explicit empty-org
Create team recovery without login creating a replacement team or organisation.
The corresponding chooser/directory/scoped-login unit gate passes 32 tests with
the intended DB-less unit environment. These are API/service checks; hosted
chooser interaction remains to be exercised with the final integrated source.

The provider invoice/history PostgreSQL gate passes 12 tests, retaining its
original cash, refund, invoice integrity, idempotency and PDF recovery assertions.
It now admits active team managers to org finances and covers future teams
without synthetic owner membership, explicit LIVE versus TEST lists/details,
same-mode named-account refusal and scoped cursors. The new history case reads
captured cycles across two products/teams and reads an original product invoice
through another registered product's financial audience. Actor verification is
stubbed in this persistence suite; it proves real DB financial scope and source
checks, not the final signed HTTP journey. Current organisation cycles use real
captured snapshots, never the old empty current-cycle preview as an accrued bill.
Manual invoices and cycles without a proven captured account remain explicit
409 reconciliation states. Their mode is not inferred or backfilled.

Three real PostgreSQL add-on tests exercise the original coherence triggers
without disabling them. New TEAM/USER entitlements use the exact ORG customer
and captured account/epoch, including an org owner with no team membership.
An actor admitted to one team who manages another can capture ORG work; ordinary
members and a team-only manager using null admission are refused. Null org-owner
admission retains the original finite action-intent check. The source contains
no provider calls and creates no payments or funding entries. Seven add-on unit
tests plus three invoice route tests pass. Captured add-on cancellation recovery
and rendered consumer flows remain outstanding.

The lifecycle PostgreSQL gate also passes 23 tests with the database rollout
fence installed. A locked migration-time readiness check refuses unfinished
incompatible TEAM jobs. Fresh TEAM previews and executor leases carry
`preserve-org-v2`. During revision overlap an old server cannot commit its former
preview or acquire a destructive TEAM executor lease. Unsafe preview writes and
an old executor claim are refused with the job unchanged. The last-team/org and
funded-source recovery assertions still pass. The parent's zero-pending snapshot
is operator evidence, not a substitute for the atomic migration precondition.
No live jobs were changed.

Three further real PostgreSQL tests pass for forward financial source capture.
They prove exact named account/epoch capture, immutable metadata, other-mode and
unbound insertion refusal, paid-work/adjustment quiescence, explicit source
deactivation, and refusal to reuse an old LIVE manual draft after Sandbox
selection. Fractional PAYG bucket keys differ by captured account; original
prepaid wallet keys stay unchanged. No financial rows are migrated and no
provider calls, charges, webhooks or funding entries are created by these tests.

## Work still required before release

Complete remaining accrual sources and their account/mode proofs, signed HTTP
history/role/custody checks, captured add-on recovery, focused races, hosted team
chooser interaction, the remaining rendered flows and final runbook.
Manual/add-on/adjustment sources without complete accrual proof currently produce
an explicit reconciliation state, not a guessed amount. That is not a claim of
complete accrued billing support. No-team financial browser sign-in is outside
the clarified requirement: an empty organisation offers Create team recovery.
