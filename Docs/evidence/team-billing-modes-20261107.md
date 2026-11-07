# Team billing mode verification — 7 November 2026

Implementation branch: `fix/admin-team-billing-mode-20261107`, isolated Maxis
worktree `C:/Users/ondre/.t3/worktrees/UnlikeOtherAuthenticator/fix-admin-team-billing-mode-20261107`.
Base and Before UI: `4ddbd87e7bd4ab1472071c493baf4a01e38c4e78`.
Public protocol 5.9.0 source: `a134e2c39c1dd0d2884bf128fddcd29e9c49acdc`.
Final evidence exercises the implementation committed with this report; the PR
head identifies its immutable source revision.

## Environment and boundaries

Windows Maxis, Node 24, portable pnpm builds, headless Chromium desktop
1440×1000 and Pixel 7 phone emulation. PostgreSQL 17.11 runs on loopback port
55487 with UTC timezone, disposable schemas, bounded connections and one DB test
worker. API unit concurrency is two. No native build, production DB mutation,
credential creation, secret access, payment, Stripe configuration or runtime
activation was performed by this implementation thread.

The real Admin verification uses the compiled API and Admin at
`http://127.0.0.1:5199/admin`, schema `mode_admin_final`, with synthetic local
identities/wallet opening fixtures and a locally signed ephemeral Admin session.
It uses no HTTP interception and makes no external provider request. The Stripe
collection gate is off; named Sandbox configuration uses clearly synthetic keys
and the public intended account identity. These checks prove UOA behavior and
authority, not production provider readiness.

## Automated evidence

- Public protocol: 73 tests, generated contract checks, lint and build passed.
- Final API non-integration gate: 418 files, 2,810 passed and three skipped,
  executed as the complete 383-file unit gate plus all 35 remaining contract/source
  test files. No integration tests were represented as unit tests.
- API and Admin lint/typecheck/build passed. OpenAPI is valid with 43 existing
  warnings. Admin unit gate: 46 files, 166 tests passed.
- Final financial acceptance: 38 PostgreSQL tests across adoption, monthly account
  isolation, credit settlement, Stripe invoice sources and customer invoice reads.
  Five additional policy/RLS/history tests passed in the preceding final-schema run.
- Final captured funding/prepaid/SMS/Voice recovery gate: four files, 41 tests
  passed on the final migration, with original reservation/receipt bindings intact.
- First explicit TEST adoption retains the original positive 3,000-credit wallet,
  active consent, customer rows, pending setup recovery and webhook evidence
  unchanged. The normal account resolver returns that same wallet after selection.
  It captures physical account identity in policy/event/audit and rejects the old
  displayed LIVE new-work context.
- Negative adoption cases cover terminal scoped LIVE history, mixed TEST tuples,
  active organisation responsibility, current-month cumulative usage and an active
  unbound grant. Global LIVE account/catalog and empty dormant customer/wallet
  existence do not count as this team's financial history.
- Both competing LIVE capture orderings are exercised through real database
  triggers and observed lock waits. A winning LIVE capture blocks adoption; a
  winning adoption refuses the old LIVE capture without persisting it.
- Monthly isolation holds an epoch exactly at UTC month-start and refuses another
  account's post-cutover settlement/export, including organisation overlap. One
  race uses default PostgreSQL transaction isolation. The second invokes the real
  `settleCreditPortfolio` service and production `runBillingSerializableTransaction`
  helper: a default-isolation winner forces exactly two Serializable attempts,
  final `BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH` and zero replacement settlements.
- Invoice tests exclude TEST cash from a LIVE team list and exclude a different
  named account even in the same mode. Known historical IDs remain readable on
  their captured source with current scope authorization and legal-document rules.
- Credits hold tests preserve confirmed `3000` credits and UOA-authored
  `pending_reconciliation`; no invented zero balance or blanket credits-page 503.
- Five executable deployment-shell tests cover safe legacy-disabled boot, rejected
  partial activation, validated named tuples, exact four `:1` bindings and retained
  legacy `:latest` bindings. Six tests cover database guard error normalization.
- Six over-limit financial test files were split into ordered case/fixture modules.
  A source-name audit found zero missing original cases. Existing assertions and
  test ordering remain, with explicit Sandbox fixture policies and original source
  timestamps where historical collection is under test. Every changed/new code
  file is at most 500 lines.

The earlier broad PostgreSQL sweep found fixture assumptions and a local timezone
mismatch. All failed suites were rerun after correction; do not describe that
initial sweep as green. Final focused results above identify the source-sensitive
acceptance gate. Logs remain in ignored `.billing-mode-qa` under the worktree.

## Real flows and screenshot coverage

Actual browser → compiled API → PostgreSQL flows passed on desktop and phone:

1. Admin Billing doorway → team directory → selected team → Billing tab.
2. Untouched LIVE → explicit Sandbox save → reload; another deliberate change
   returns an empty team to LIVE. Revisions increment and persist.
3. First explicit historical TEST adoption → reload → original funded wallet
   remains 3,000 credits; switching back is blocked with the balance explanation.
4. Stale operator edit returns 409; anonymous write returns 401; an ordinary
   domain member returns 403; foreign organisation scope returns 404. Four
   successful changes produce exactly four audit records and four mode events.
5. Both viewports have no horizontal overflow.

The durable Playwright Admin flow additionally exercises save failure with
retained selection and deliberate retry, saved feedback, persisted Sandbox,
subscription blockers, read failure/retry and the eligible historical TEST notice.
Both projects passed. These error states use explicit API fixtures; they are not
claimed as real provider failures.

Screenshots are outside worktrees at
`D:/BuildArtifacts/uoa/team-billing-mode-20261107`, never committed. There are 22
images. The PR embeds side-by-side pairs for Billing's new doorway and the team's
new Billing tab, with actual base screenshots and matching device/theme/state.
The new panel's LIVE, Sandbox, saved, blocked, save-error, load-error and historical
adoption states have no prior equivalent; each is labelled as such beside its
After image on desktop and phone. Unchanged journey pages are not screenshot rows.

## Self-review and remaining activation boundary

Authorization is platform SUPERUSER-only, rechecked under durable authority locks;
the exact live organisation/team and expected revision are validated. App-role RLS
cannot read/write policy/history. The policy mutation and audit are atomic. Account
selection never relies on ambient request context: stored work, webhooks and
recovery retain their captured account/mode; new work captures policy revision.
Consumers must forward the original displayed opaque token, including missing
legacy bindings, without a refetch upgrade. Cancellation intents retain their
original captured target.

Organisation-wide money requires uniform active team modes. The adoption exception
does not transfer money or rewrite objects. Its eligibility and captures serialize
under the organisation lock. Monthly account decisions use a common advisory lock
and a durable control-row write before financial row locks, so stale Serializable
snapshots must retry. Same-mode named account replacement is unsupported without a
new reviewed cutover/history plan; mode history alone does not establish account
identity. Same-account credential rotation is supported.

Activation is held for parent/operator signoff. The immutable installation/change
UTC month stays held, including exact month-start; no transition-month force-release
operation exists. Later complete uniform months resume. Original prepaid receipts,
refunds/revocation and captured recovery remain available. SMS protocol 1 cannot
bind a new Sandbox/changed-team number purchase; a negotiated future protocol is
required. Static catalog provisioning does not implement the historical storage
catalog. Base subscription catalogs are account-scoped and lazy; restricted write
permissions and tariff terms need operator verification before first LIVE Checkout.

The exact six environment inputs, four Secret Manager `:1` bindings, unchanged
legacy bindings, shared webhook URL/version/events, catalog apply command, readiness
update, immutable epoch and safe activation order are in
[Team billing modes](../Billing/team-billing-modes.md). Parent owns all of those
operations. Until coordinated review is complete, leave the PR unmerged and LIVE
webhook disabled; do not alter serving revision `uoa-auth-00360-thw`.

## CI race correction and current-main integration

The initial PR CI on `42fb552b3f1ccb869c14ea66d5634e5cbfe4157c` passed
974 remaining PostgreSQL tests, with one skipped and one failure. The failing
credit-versus-Stripe race still observed a payer-row wait after both collectors
had moved to the earlier month fence. The financial assertions did not fail.
Its failed wait also left provider tasks pending during client teardown.

The corrected scenario observes a real wait on `assert_billing_period_mode`,
bound to the winning transaction's actual PostgreSQL backend PID through
`pg_blocking_pids`. It retains both winning orders, stale-offset refusal,
remaining wallet balance and exact exported quantity/no-duplicate assertions.
Every task has rejection handling immediately; every exit releases its barriers,
awaits all task outcomes and only then disconnects clients. A second real-PG
scenario deliberately fails lock observation and proves the admitted settlement
and stale export drain without an orphan rejection or extra usage export.
Both scenarios pass locally.

Main advanced to `81f39d73` with shared-team archival. Integration retains its
authority and lifecycle/provider fences, archive stop window, consent disabling,
customer scope and pending reconciliation semantics. The new archive reconciler
now selects each persisted customer's captured physical account and livemode;
it cannot use a global legacy client or the team's current default LIVE policy.
Matching named Sandbox credentials take precedence over an expired legacy TEST
key, including with collection disabled. The public 5.9.0 package is unchanged.

Focused integration checks passed: 23 PostgreSQL tests across period isolation,
the original financial race, reload runtime/disable authority and archive
behavior; the expanded two-scenario race passed separately. Another real-PG
archive scenario uses current domain/human authority, archives an untouched
default-LIVE team with historical main TEST customer state, rejects an injected
LIVE client, then reconciles via the fresh named Sandbox credential. It retains
both customer rows, leaves the shared organisation LIVE customer untouched and
certifies only after the original settlement window. Provider calls use synthetic
local SDK stubs, never production keys or Stripe objects. Four unit cases cover
captured TEST, both tuples and LIVE-client mismatch; the eight-file unit seam gate
passed 55 tests. API lint/typecheck/build and OpenAPI validation passed after
integration. CI must pass again on the integrated immutable head before merge;
the parent coordination/activation hold remains in force.

The auto-top-up runtime fixture now follows main's shared helper and separated
disable-authority suite, retaining explicit Sandbox fixture policies. The other
split suites remain within 500 lines. No billing policy, monetary record or
production provider configuration was changed by this integration.
