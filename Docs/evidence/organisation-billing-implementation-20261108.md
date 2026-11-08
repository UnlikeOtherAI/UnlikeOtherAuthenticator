# Organisation billing implementation checks

This is an implementation checkpoint, not release or activation acceptance.
Source starts at deployed `2694c8088a18525f68589d5516074020856d1db9`.
Public protocol 6.2 is pinned at `e968ac99aa2469e7e0bd64763a8e8ab6dd0b4120`.
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

The revised real PostgreSQL lifecycle suite passes 23 tests. It executes actual
TEAM deletion jobs with product acknowledgements, preserves the last team's
organisation and active people, creates a replacement team through the supported
team service, preserves a synthetic already-funded captured TEST wallet/customer
byte-for-byte, and proves the inclusive financial month hold still refuses both
before and after deletion. An old TEAM job expanded to organisation scope is
refused before product delivery/execution and remains visible for reconciliation.
Explicit organisation deletion and bounded resumable erasure checks still pass.
This proves the service flow, not yet the rendered Admin or Nessie browser flow.

## Work still required before release

Complete the organisation history branch, remaining accrual sources and their
account/mode proofs, Admin organisation controls, shared org-admin chooser and
custody admission, explicit last-team deletion preservation, focused recovery
and race proofs, rendered desktop/phone flows, screenshots and final runbook.
Manual/add-on/adjustment sources without complete accrual proof currently produce
an explicit reconciliation state, not a guessed amount. That is not a claim of
complete accrued billing support. No-team financial browser sign-in is outside
the clarified requirement: an empty organisation offers Create team recovery.
