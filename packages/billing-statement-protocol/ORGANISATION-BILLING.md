# Organisation financial overview — protocol 1.1.0 / package 6.1.0

This supersedes per-team customer billing. One UOA organisation owns one financial
scope, one LIVE/Sandbox policy and independent money/customer bindings in each
captured account/mode. Selected team and product are current actor admission and
display context, never a financial filter. This exception exposes financial
records only; it grants no other-team product content or identity authority.

`POST /billing/v1/organisation/capabilities` accepts the existing strict subject
body (`product`, `organisation_id`, `team_id`, `user_id`) and exact-endpoint
`X-UOA-Actor` plus the registered lifecycle `X-UOA-App-Key`. It has no Stripe,
Ledger, wallet or subscription dependency. UOA rechecks active identity/epoch,
organisation membership. With a selected team, its exact ACTIVE membership is
also required. Current organisation owner/admin OR an active owner/admin of any
active team in that organisation receives both capability booleans true and
`financial_scope`. An ordinary active member receives both false with no
financial scope/data. Inactive, removed, foreign or invalid subjects fail closed.
Never infer billing authority from ordinary membership or a previous verdict.

An organisation owner/admin without an admitted team uses explicit `team_id: null`
in the financial request and actor claim, together with actor claim
`financial_scope: 'organisation'`. UOA rechecks the active organisation role;
team-manager authority cannot use this branch. No team is invented or selected
on the actor's behalf. Null is admitted only on organisation financial endpoints,
their frozen payment/subscription actions and financial history. Ordinary team
content, entitlement, service-access and token endpoints still require their
exact non-null admitted team. The displayed token also captures explicit null.
No other body field, URL or context can be null through this exception.

`POST /billing/v1/organisation/overview` accepts that subject plus optional
`billing_month` (`YYYY-MM`, current or earlier). It requires the same manager
authority; otherwise 403 `BILLING_MANAGER_REQUIRED`. Locale uses the existing
presentation header. The response contains `financial_scope` (organisation,
mode, monotonic revision, immutable epoch) and five independent `sections`:

- `accrued_bill`: UOA-authored bill as of the returned instant, exact lines and
  currency-separated subscription/usage/adjustment/tax/prepaid totals. Consumers
  never sum team statements or estimate taxes, exchange rates or prepaid offsets.
- `credits`: confirmed ledger balance, reservations and spendable credits,
  independently of metering; `billing_status` can disclose pending settlement.
- `funding`: the existing strict top-up and automatic top-up controls.
- `subscription`: plan, subscription, capabilities and existing frozen actions.
- `history`: canonical cycle and invoice list requests. Those interfaces now use
  manager-authorized organisation financial scope, with original record bindings.

Each section is either `confirmed` with `message` and `data`, or
`pending_reconciliation` / `unavailable` with `message` and `code`, without
`data`. A held bill contains no numeric total, including no invented zero or
partial total. A metering failure cannot erase independently confirmed wallet
data, funding or subscription controls. Confirmed wallet balance does not imply
that unresolved usage is settled. Clients render UOA messages and retry sections
through a fresh overview; no client financial arithmetic or permission fallback.

Existing top-up/setup/update/disable/recover, Subscribe/Portal and cancellation
paths/IDs remain. The original displayed opaque `billing_context` is preserved
unchanged through browser → consumer API → UOA. A backend action lookup must not
replace its token or absence with a freshly fetched context. Never accept arbitrary
browser-authored UOA bodies/URLs. Context captures the organisation policy epoch,
revision, account/mode and original actor/action body. It grants no authorization.
Pre-cutover displayed new-work contexts are stale; genuinely unbound clicks remain
unbound and cannot be upgraded into organisation financial work.

Refusals retain protocol 5.9.0 semantics: 409 `BILLING_CONTEXT_REQUIRED` for a
required missing binding; 409 `BILLING_CONTEXT_STALE` for expiry or changed
epoch/revision/account/mode; 400 `BILLING_CONTEXT_INVALID` for signature or
subject/app/path/body mismatch. Retain the session, refresh the display and require
a new deliberate click. Never auto-retry a mutation with a replacement token.
401 remains invalid credentials; 403 remains current authority refusal.

Migration creates immutable organisation cutover evidence and audited mode policy;
future teams inherit their organisation policy. It does not copy, pool, adopt,
rebind or alter historical balances, consents, customers or subscriptions. Historical
TEAM sources remain on their captured tuple for recovery and explicit source-backed
reconciliation. No new TEAM financial payer is admitted after cutover. Organisation
mode edits require locked quiescence and audit. Inclusive installation/change UTC
month holds persist; numeric accrued bills/collection cannot infer a split. Old
financial records and protected history are never edited to make reads succeed.

Deploy the UOA implementation before enabling the new consumer requests. Consumer
vendoring must pin the exact package source commit. A missing endpoint is an
integration-unavailable state, never permission to fall back to member-visible team
finances. Credentials, account IDs, Stripe API version and webhook contracts remain
unchanged; provider changes or money migration are outside this protocol rollout.
