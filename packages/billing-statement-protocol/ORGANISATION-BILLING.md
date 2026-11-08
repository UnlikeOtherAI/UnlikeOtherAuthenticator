# Organisation financial overview — protocol 1.3.0 / package 6.3.0

## Authority clarification — package 6.4.0

This section supersedes the earlier any-team-manager financial authority below.
Only an ACTIVE organisation owner/admin manages or reads organisation finances.
A team-only owner/admin can read their own selected ACTIVE team's recorded usage
and retained TEAM credit history, with no organisation money or monetary action.
Organisation owners/admins may select any ACTIVE same-organisation team through
current UOA authority without a fabricated TeamMember record. When no team exists,
the browser uses Create team recovery; null financial endpoints do not create a
separate sign-in or grant general content access.

Opt in on the existing capabilities endpoint with
`X-UOA-Billing-Authority-Protocol: 1.0.0`. The strict schema-version 2 response has
`access: organisation_manager | team_reader | none`. Only the first branch has
`financial_scope`. The team-reader branch names the exact `team_scope` and
`overview_request`. Without this header, schema-version 1 stays shape-compatible;
team-only admins now receive both financial capability booleans false. Unsupported
header versions fail 400 `BILLING_AUTHORITY_PROTOCOL_UNSUPPORTED`.

`POST /billing/v1/team/overview` accepts the strict non-null selected-team subject
and optional `billing_month`. Sign the exact endpoint with the same registered
customer-lifecycle app key and original assurance custody. UOA requires current
org-manager authority or ACTIVE owner/admin membership in that exact selected team;
otherwise 403 `BILLING_TEAM_ACCESS_REQUIRED`. Adminship of another team confers no
access. Authority is rechecked after dependency reads.

The response contains independently confirmed/pending/unavailable `activity`,
`recorded_credit_usage` and `retained_credits` sections. Usage is attribution,
not a team invoice or a share of the organisation wallet. Each original captured
account/mode stays separate. `source_ref` is opaque provenance, never a provider
account identifier; `mode` is canonical display-safe LIVE/Sandbox information.
No section contains organisation balances, invoices, subscriptions, cards, consents,
financial actions or an amount due. Unconfirmed sections have no numeric data.
Render source-owned labels, formatted amounts and messages without adding totals.

The accepted TEST disposition retains original TEAM records as history and starts
organisation wallets fresh. No transfer, copy, adoption, deletion or waiver occurs.
Retained records are not current spendable organisation funds. New/unclassified
LIVE exposure still requires an activation-time reviewed disposition.

Ordinary active members may still make the separate nonfinancial funding request
without a financial GET; eligible recipients are current organisation financial
managers. Team readers cannot use the organisation overview, financial history or
any frozen monetary mutation. A previously displayed context never grants authority.
All original context, captured recovery, mode separation and inclusive holds remain.

Types, strict schemas, OpenAPI and conformance examples are exported from the package
and `billing-authority-v1` artifacts. All pre-6.4 schema shapes remain unchanged.

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

Use the SAME registered customer-lifecycle app key for every financial read and
write, including Subscribe, Portal, funding, return verification and cancellation.
The displayed context captures that app-key identity. A legacy paid key cannot
replace it at mutation time. A financial actor cannot call SMS, Voice, content,
service-access, native scope registration or general assurance/token endpoints.

UOA resolves an `assurance_ref` to its original authoritative custody scope. It
requires the same user, organisation, client and credential epoch, then runs the
unchanged live assurance family/chain, provisioning, policy and revocation checks
on that stored scope. A null financial team never rewrites or borrows custody. An
org-only recovery family can have an original null custody team; a team-bound
family must still satisfy its own current team admission. No other assurance or
token endpoint gains a null-team exception.

`POST /billing/v1/organisation/region` accepts the financial subject and optional
`region` (`UK`, `US`, `EUROPE`). Without it the endpoint reads `BillingRegionViewV1`;
with it the endpoint makes the existing audited immutable choice. Org-only
managers can choose their first region. The old `/organisation-billing/region`
request/schema is unchanged. This region operation is not a payment retry.

`billingOrganisationFinancialV1Schemas` and `BillingOrganisationFinancialTypes`
have matching keys for the full reachable lifecycle: funding requests and hosted
responses, purchase-status return verification, Checkout/Portal, cancellation
preview/confirmation, add-ons, region and financial cycle/invoice history. Empty
204 mutations have no response DTO. The generated family is
`schema/billing-organisation-financial-v1.json` (`$defs` by those keys). Use it
only in the explicit financial realm. Every old 5.9 schema remains unchanged.

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

Financial history bodies carry `financial_scope: 'organisation'` and may name
`billing_mode: 'live' | 'sandbox'`. This read-only selector resolves only UOA's
configured named tuple and never changes the organisation's mode for new work.
Canonical `captured_sources` requests keep LIVE and TEST histories separate;
consumers never combine their totals. Returned document requests retain that
selector. Default history requests use the overview's current mode. Selected
team/product stay actor context; this explicit financial history exception admits
all organisation financial products/teams, including retained legacy records.
It grants no other-team product content. Exact record, captured account/mode,
snapshot, invoice-line, cash and document proofs remain mandatory.

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

Protocol 1.3.0 (package 6.3.0) adds optional `sections.attention` to the overview. It is an independent section of canonical `BillingCreditAttentionV1[]` (`event_key`, `kind`) for the CURRENT organisation wallet and configured account/mode only. `confirmed` with `data:[]` is an authoritative empty set. Missing, unavailable or pending attention is not an empty set and must not clear/reconcile alerts as though confirmed. Consumers use the overview's exact financial organisation/mode/epoch/revision and UOA opaque event keys, never local balances, thresholds or retained TEAM/Sandbox warnings as current money. This adds no endpoint, credential, actor audience, header or action. Legacy 5.9 and complete 6.2 financial lifecycle schemas remain unchanged.
