# Organisation billing

## Current authority contract — public 6.4.0

The clarified policy is implemented through separate authority branches. Only an
ACTIVE organisation owner/admin (including its canonical owner with ACTIVE org
membership) can read or manage the organisation payer. A team-only owner/admin
can read their own selected ACTIVE team's recorded activity, captured-source
usage and retained TEAM credit history. Another-team admin role grants no access
to the selected team's records or to organisation money. The selected team still
scopes ordinary product content. Existing product-specific spending safeguards,
native scope registration and self-imposed run limits remain separate controls.

The capabilities endpoint negotiates schema 2 only with
`X-UOA-Billing-Authority-Protocol: 1.0.0`; absent that header, the strict schema 1
DTO remains unchanged and returns false financial booleans for team-only roles.
The new discriminant is `access: organisation_manager | team_reader | none`.
Only the organisation-manager branch carries a financial scope. The team-reader
branch carries the exact `team_scope` and canonical non-null request for
`POST /billing/v1/team/overview`, using the registered lifecycle key and original
selected-team actor/assurance. Unsupported authority versions fail 400
`BILLING_AUTHORITY_PROTOCOL_UNSUPPORTED`; own-team authority refusals fail 403
`BILLING_TEAM_ACCESS_REQUIRED`.

Team sections are independently confirmed, pending reconciliation or unavailable.
Recorded usage is verified against the signed Ledger paid cohort and immutable
UOA liabilities, with original account/mode and explicit waiver evidence. Two
accounts in the same mode are separate opaque sources. Unknown or contradictory
bindings return pending without amounts. Retained credit rows are the exact
TEAM scope and team, never a current organisation wallet or share of its funds.
No team response includes organisation invoices, subscriptions, cards, consents,
monetary actions or an amount due. The consumer must not sum a team bill.

The locked credit-manager guard and an additional financial-intent INSERT guard
enforce organisation-only money authority in PostgreSQL. The original intent
guard still locks and checks app/service/actor epoch/org/team admission before
that narrower financial check. Existing runtime telephone grant operations keep
their distinct product authority. Recovery retains its captured source; no
historical row is copied, rebound or adopted by this authority migration.

Mode-edit quiescence remains conservative across retained TEAM and current ORG
sources. Historical funded balances, consent pointers, active subscriptions or
current-month usage can therefore still block an explicit later mode edit even
though retained TEAM money is excluded from the new organisation wallet. The
approved history-only TEST disposition does not bypass that guard or release
the inclusive month hold. A first-organisation Sandbox policy exception would
need a separate reviewed locked/audited plan, without moving or adopting money.

The separate member Ask remains a nonfinancial selected-team request and queries
current organisation financial managers only. It opens or reads no wallet.
Deploy a consumer pinned to 6.4 before presenting the new own-team reader branch;
old financial requests fail closed rather than returning shared data.

This is the organisation financial scope introduced after PR143. It supersedes
the team policy and optional responsibility roll-up described in
[Team billing modes](team-billing-modes.md). Those records remain historical
evidence. A selected team admits the actor and scopes product content; it never
selects the payer, wallet, billing mode or financial history filter.

## Release state and continuity gate

**Activation is held for final coordinated consumer and production readiness checks.**
The revised authority is implemented and has passed the focused signed HTTP and
PostgreSQL checks below; the earlier broad-policy baseline is not its proof.
The user has resolved the known legacy TEST spendability decision: **“Keep TEST
history; start org wallets fresh.”** The source is the coordinator's explicit
choice at position 5644, confirmed by Go at 5648, and its directed handoff at this
implementation thread's position 5659 on 8 November 2026.

Retained TEST records and balances remain historical on their original bindings.
New organisation wallets start at zero; their confirmed balance is not an
all-history total. No balance is transferred, copied, adopted, deleted or waived.
Old TEST consents cannot initiate new charging. Captured recovery remains bound
to its original account/mode. The accepted policy does not authorise a refund,
new charge or future spending of those retained balances. No migration date is
promised. New or unclassified LIVE exposure still needs separate review.

The parent measured these production counts at `2026-11-08T03:08:04.070Z`, on
deployed source `2694c8088a18525f68589d5516074020856d1db9`:

| Captured mode | TEAM wallets / organisations | Positive wallets / organisations | Negative wallets | Consent pointers / non-DISABLED wallets |
| --- | --- | --- | --- | --- |
| Sandbox | 8 / 6 | 4 / 3 | 0 | 2 / 2 |
| LIVE | 2 / 2 | 0 / 0 | 0 | 0 / 0 |

Each mode had one captured account. A pointer count does not prove a valid
consent, and these aggregates do not prove whether the consent and positive-fund
cohorts overlap. The read-only source is job
`uoa-org-continuity-count-b0b81de6`, execution `b584v`, with a 30-second statement
timeout. Sanitized evidence:
`D:/BuildArtifacts/nessie/organisation-billing-usability-20261107/org-continuity-count.json`.
No amounts, customer IDs or provider secrets belong in this report.

The parent's final read-only snapshot at `2026-11-08T12:10:09Z` used deployed
source `324de4cce7c1ad77449bf03225466e0b8e16c785`, immutable image prefix
`6bd4d40a`. The wallet/positive/consent counts above were unchanged. No unfinished
or incompatible deletion jobs were found. Organisation policy/cutover tables
were absent, and the legacy team policy table contained zero rows. Consequently
no existing Sandbox organisation policy is claimed: installation defaults new
organisation work to LIVE. Retained funded sources can prevent a later Sandbox
selection under the unchanged quiescence guard.

Provider work comprised six completed and two expired Sandbox top-ups, six
successful automatic attempts, one active Sandbox recurring add-on and one
uncertain SMS reservation. No usage exports, invoice closes, monthly charges,
generic prepaid or Voice reservations were found. The sixteen customer action
intents all had expired actors; they are immutable admission/audit evidence,
not provider-work rows with a pending status. These counts do not establish
provider invoice completeness. The captured add-on queues original-account
invoice recovery; it is not adopted into current ORG subscription state.

The three measured Sandbox organisations are covered by that accepted
history-only disposition. The implementation does not rewrite TEAM wallet
scope, create matching ORG credits, adopt consents/subscriptions or move provider
objects. The following source-level procedure remains necessary for any later
requested financial effect, unsupported continuity request or new LIVE exposure;
it is not a requirement to invent TEST spendability after the user's decision.

1. The operator inventories the original account/mode, wallet/customer, funding
   entries and lots, reservations, liabilities, purchases, refunds and consent
   revision/attempt references in a secured read-only report. Record the source
   revision, time, integrity digest and whether each source is proven. Count-only
   evidence is insufficient for an individual disposition.
2. The organisation's current billing manager and operator review each original
   source. Legitimate spending through an already-authorised original product
   path, or an explicitly authorised refund/reversal through the original
   provider binding, may settle that source. Neither is an automated migration.
   Do not change a team policy merely to drain funds, fabricate usage, grant
   replacement ORG credits, waive a liability, or issue a refund from this
   implementation thread. Any financial effect requires its own concrete
   authorisation and the existing financial evidence checks.
3. If the requirement is to carry the retained value into future ORG spending,
   release remains blocked pending a reviewed source-authority design. It must
   preserve original financial rows, bind every new consumption to the exact
   source/account/mode, enforce current org authority and race-safe limits, and
   prove end-to-end debits/refunds/replays. A documentation promise or a copied
   balance is not that implementation.
4. Old TEAM consent pointers are retained evidence. They cannot initiate new
   automatic attempts after the org epoch. An already captured attempt may
   recover on its original account/mode and idempotency key; its result is not a
   new consent. No supported standalone legacy-source revocation UI is claimed
   by this tranche. If an affected source needs revocation beyond its existing
   captured workflow, that remains an operator/release blocker, not a reason to
   hand-edit the wallet or archive a team merely to clear it.
5. Re-run exposure, unresolved provider work and actual guard checks immediately
   before activation. Record each reviewed disposition and its real evidence.
   Reconfirm that the retained TEST cohort is covered by the accepted history-only
   policy and that no unreviewed LIVE or ambiguous source appeared. A zero
   current ORG balance or disabled new TEAM charging does not prove that all
   historical value has been accounted for.

## Ownership and authority

**Latest authority clarification (8 November 2026):** org owners/admins alone
read or manage organisation finances. A team-only owner/admin receives read-only
access to their own team's data; this does not grant organisation money,
other-team data or monetary mutations. The exact user answer to the organisation
billing-authority question was: “Team only admins should only have read access
to their teams data” (implementation thread position 5665). This supersedes the
broader team-manager financial policy below. Its implementation and focused
acceptance checks are described above and in the signed HTTP verification below;
the old broad-policy passes are not release evidence for this clarified authority.
One organisation payer/mode remains mandatory;
read-only team attribution must not invent a share of the shared wallet or bill.


UOA Admin **Organisations → selected organisation → Billing** owns the mode.
Admin Billing links to that directory; a team's Billing tab links to its owning
organisation. Only a current platform superadmin may change it. An absent policy
means LIVE, revision 0; the policy covers current and future teams in every
product. Each actual change appends immutable history and an administrator audit
under the organisation write fence. There is no environment team allowlist.

**Superseded broad proposal:** customer finance required current ACTIVE org membership and either org
owner/admin authority (including the current canonical owner) or owner/admin
authority in any ACTIVE same-org team. A selected team must be ACTIVE and admit
the actor through current team membership or org-manager authority. Org managers
may choose any ACTIVE same-org team without fabricated membership. Product
content remains selected-team scoped. An empty organisation shows Create team
recovery; explicit TEAM deletion preserves that org and its financial evidence.
Full organisation deletion remains a separate explicit operation.

The explicit financial actor realm accepts a nullable financial team, retains
the original assurance custody team and uses the registered customer-lifecycle
app key for every financial read/write. This does not widen ordinary OAuth, Me,
content, SMS/Voice or native grants. Members may submit the separate nonfinancial
selected-team Ask for credits POST without reading a wallet or statement.

## Independent sections and financial evidence

Public protocol is `6.4.0`, organisation protocol `1.3.0`; the separately
negotiated authority protocol is `1.0.0`. Capabilities need
no wallet, metering, FX or provider read. Overview sections independently report
`confirmed`, `pending_reconciliation` or `unavailable`. Unconfirmed bill sections
have no data or numeric total. Confirmed credits are actual ledger money and
holds; they do not assert settled usage. Retained TEAM money is disclosed and
excluded under the accepted retained-TEST history policy above.

Funding may return a confirmed saved-consent projection with empty offers and
options when purchase terms cannot be verified. It says those offers are
unavailable, quotes no missing FX rate, and preserves the current ORG consent's
DB-only disable action. Amounts for that consent's cap use its captured policy
currency; other funding remains in payment history. Missing-region first-time
funding retains its canonical region-required doorway. Current authority and the
original displayed context remain mandatory when disabling.

All aggregation and currency arithmetic belongs to UOA. Issued manual invoices
use exact captured contract/account bindings, issuer line allocations, tax and
actual cash events. Unissued manual tax and unsupported financial evidence hold
the bill. USD credit consumption may appear beside EUR/GBP fees only from proven
frozen USD liabilities; an unfunded non-USD cash liability still needs captured
FX evidence. No foreign-money total is inferred from a USD balance.

History reads span the whole org and registered products under one exact named
account/mode. The presenting product and selected team are actor context.
Manual documents inherit their captured contract binding. Unknown historical
manual/cycle bindings hold rather than appearing in both modes. Original legal
documents and financial snapshots remain immutable; download bytes are checked
against their persisted hashes. History cursors bind org/account and, for
invoices, charge month.

The selected-team request family also uses these ORG-wide history readers and
the current named org mode. Its non-null subject/download bodies remain strict
and unchanged; it cannot silently select another mode. The explicit financial
family selects retained historical mode and permits the narrow null-team actor.
History source team/product labels describe original evidence, not a financial
filter chosen by the current team. Old team-filtered cursors are refused.

The former `/billing/v1/credits`, `/billing/v1/customer-statement` and
`/billing/v2/customer-statement` aggregates cannot represent independently
confirmed organisation sections. They verify the exact actor and current
manager, then return409 `BILLING_ORGANISATION_OVERVIEW_REQUIRED` without metering,
settlement or financial projection. Members receive403. Keep the session and
use the organisation overview; never invent an org total from old team DTOs.
Pinned old schemas remain unchanged. Member Ask is a direct nonfinancial POST,
and frozen action context or absence is never upgraded by a read/refetch.

New manual invoice calculations require the contract's captured account before
reading metering. Funding evidence selects settlements and separately paid
add-ons from that exact account, which identifies both provider account and
mode; a contradictory catalog or settlement refuses. An old unbound contract
cannot acquire today's account through a fresh calculation. Existing issued
legal records stay unchanged. Commercial adjustment readers likewise select the
captured account, preserve its historical effective period after deactivation,
and hold relevant unbound rows rather than assigning them to either mode.

Recurring add-on controls retain their existing per-offer entitlement target:
the selected TEAM or displayed SUBSCRIBING_USER, while the payer is ORG. The
canonical description says this is not every add-on instance in the org. Missing
real targets have a source-owned reason and no action. Org accrued money/history
must cover all ORG-paid instances; retained TEAM subscriptions do not become
current ORG state. Stored cancellation confirmations recover exact captured
objects; fresh previews cannot replace an old source with current mode.

Actual add-on payment invoices now retain their original add-on subscription
and invoice period as an alternate legal financial source. No base subscription
is manufactured, and existing base invoice hashes/records are unchanged. The
normal verified webhook transaction captures invoice cash and the independent
entitlement effect once. History/PDF reads use the actual ORG customer as payer,
even when entitlement belongs to a team or subscriber. Monthly licensed add-on
fees enter the accrued bill at their captured period start, in their own
currency, with actual confirmed cash. Missing or overlapping invoice periods,
unresolved refunds/disputes, and retained TEAM payers hold that bill section.
These checks do not imply that an active flag proves payment.

Pre-existing add-on payment history must finish original-provider invoice
recovery before history can be declared complete. Migration
`20261108024000_addon_invoice_recovery` queues original subscription/account/mode
bindings, including historical TEAM customers. The worker reads one subscription
and at most20 provider invoices per tick, retains an immutable scan watermark,
and commits genuine invoice/cash sources and its cursor together under a lease.
It retries temporary failures without deleting or resetting a source. Captured
credentials remain usable independently of new collection admission. No old
entitlement, balance, consent, customer or subscription is moved into ORG.

Invoice LIST returns 409 `BILLING_ADDON_HISTORY_RECONCILIATION_REQUIRED` while a
source in that exact org/account/mode remains incomplete. This is a history
reconciliation state, not a stale action context or an empty history. Confirmed
invoice DETAIL/PDF remains independently accessible. Existing base invoice
history is unaffected when no captured add-on source needs recovery.

Before completion, the worker checks original cash for prior refunds/disputes.
A missing refund movement remains held until the existing verified webhook/cash
path proves it; it never invents a webhook ID. Historical disputed charges remain
held for separate original-source reconciliation. Incomplete invoice pages,
unknown metadata/period/tax terms or unavailable provider permissions also remain
held. The original subscription and financial records remain unchanged.

The operator can preview one exact tuple using the existing secure API/DB
bindings, without provider mutations or database writes:

```sh
pnpm --filter @uoa/api billing:recover-addon-invoices --mode sandbox --account acct_1Sn2VfGY1l8e0vu2 --organisation <exact-org-id> --dry-run
```

Only after reviewing that scope, `--apply --max-cycles 3` in place of `--dry-run`
appends verified original sources and advances at most three bounded pages. It
does not charge, refund, create a subscription or alter a provider object. Its
inventory is explicitly from before the operation; repeat `--dry-run` afterward
and inspect canonical holds/completeness. The periodic worker also resumes due
work automatically. These source-recovery commands are separate from retained
positive-wallet disposition and do not release that gate. Production execution
and final completeness verification remain parent/operator prerequisites.

New base and ordinary add-on subscription checkouts use an ORG provider customer
key of `<org-id>:billing:<ISO-currency>` under the exact captured account/mode.
Stripe does not support simultaneous active subscriptions in different
currencies on one customer; see [its customer currency contract](https://docs.stripe.com/invoicing/multi-currency-customers).
These are provider customer bindings, not separate financial tenants: the payer,
wallet, mode, authority and accrued bill remain ORG-wide. SMS keeps its existing
`<org-id>:sms:<currency>` customer key. Credit funding keeps its original ORG
wallet customer and saved consent. Nothing rebinds an existing customer or moves
its card, balance, checkout or subscription. Pending checkout recovery first
selects its captured customer. An abandoned source requires refresh/new click
before new work can choose a currency-specific customer.

The subscription Portal label names the captured product and subscription
currency. Its description explains that other subscriptions on that same customer
may appear and directs automatic credit funding to its own controls; it does not
present that customer as every organisation card. A retained legacy customer can
still be shared with its original wallet; no new isolation is claimed for it.
Portal and cancellation-preview display tokens additionally capture immutable
subscription/customer identities. Replacing a subscription makes that original
display stale (409), even within the same org/account/mode/epoch/revision. The
opaque `billing_context` contract and the financial shapes published in
`6.3.0` remain unchanged in public `6.4.0`.

## Retained uncertain SMS at cutover

An existing SMS reservation does not need an organisation epoch or a new
organisation wallet to recover. The cutover neither rewrites it nor runs the
new-capture mode guard against it: `billing_effect_mode_guard` is INSERT-only.
Settlement reads the original `creditAccountId`, Twilio `accountSid`, quote and
FX, then checks the exact prepaid source before appending one liability and
wallet debit. It never resolves the current organisation mode or substitutes a
current ORG wallet. An uncertain or reconciliation outcome keeps its original
hold and cannot use the no-dispatch release path.

The parent's read-only `2026-11-08T12:15:08Z` inspection classified the retained
October 2026 reservation as an original Sandbox wallet, uncertain, claimed,
with a provider message reference, positive reserved credits and no debit. Its
budget dispatch was ACTIVE, nonlegacy, PREPAID and `twilio-sms`, with matching
organisation, team, user, service and quote. Those facts match the supported
captured-recovery path; no cutover incompatibility is known from that binding.
A stored provider message reference is not terminal price evidence. Nothing
here claims that production settlement has completed or authorises manual
recovery, a new dispatch, a refund or a release.

Inspect the Stripe binding through reservation `credit_account_id` →
`billing_credit_accounts.account_id` → `billing_stripe_accounts`; Twilio
`account_sid` is a separate provider binding. Missing or contradictory source
evidence must remain held. A legacy budget hold is refused by this SMS path with
`LEGACY_RATING_SOURCE_REQUIRED`; a missing hold with
`PAID_DISPATCH_EVIDENCE_MISSING`. Those are source limitations, never permission
to attach today's account or fabricate a new hold. The unresolved reservation
continues to contribute `sms_reservation` to the organisation mode blockers.

The focused `billing-sms-retained-team.persistence.test.ts` regression passed
both cases on Maxis against isolated, fully migrated PostgreSQL. Its synthetic
previous-month TEAM Sandbox reservation has expired actor, quote and FX display
windows and no new financial epoch/account metadata on its ACTIVE nonlegacy
budget hold. The supported read/release/receipt services preserve uncertainty,
refuse an unproven release, then settle/replay one verified receipt against that
original wallet with every runtime database guard enabled. Both current ORG
wallets, including LIVE, remain byte-for-byte unchanged. This proves local
captured recovery, not the outcome of the production SMS or a provider write.

## Local signed HTTP verification

`billing-organisation-signed-http.persistence.test.ts` starts the actual API on
a loopback HTTP socket with an isolated migrated PostgreSQL schema, a synthetic
registered lifecycle key and RS256 actor key, and actual UOA assurance/refresh
families. It does not inject an already-authorised actor. The thirteen cases cover
the actual `/org/assurance/validate` endpoint with both access-token and
confidential-subject transports and a refused borrowed custody reference;
fresh org owners/admins with no TeamMember on either active team; selected-team
read-only authority, cross-team/member financial denial and nonfinancial Ask; exact audience,
credential epoch and original custody checks; independently confirmed credits,
saved funding controls and subscription beside the inclusive bill hold; invoice
LIST reconciliation with confirmed DETAIL/PDF hash and original-source recovery;
and missing, altered and stale original action contexts before a deliberate
successful Disable. They also prove manager409/member403 on superseded reads
and identical ORG invoice sources under both org-manager selected-team legacy subjects,
with strict old-family response validation. Session authority survives those
action refusals. The 6.4 reader proof separates three captured account/mode
sources, including two different Sandbox accounts, without exposing provider
account IDs or another team's retained wallet. A simulated metering failure
leaves independently confirmed retained records and organisation controls
available. Production-debug-disabled cases preserve the documented profile and
authority refusal codes. A separate PostgreSQL race observes the competing
intent's real backend PID waiting on a winning organisation-role demotion,
then proves that no new financial intent is admitted; all competing tasks are
released and awaited on failure.

Provider objects and initial authentication are synthetic. These checks prove
the real signed HTTP/assurance/DB boundary, not a production browser login or a
Stripe payment. A separate loopback instance using the same fixture can support
consumer browser/BFF integration; its generated keys and custody references stay
outside the repository. New collection is disabled and remote HTTPS is blocked.

The historical invoice, cycle, recurring add-on and customer-action persistence
fixtures also enforce this org-only authority. Their six affected suites passed
32 distinct PostgreSQL cases on Maxis: 24 cases across five financial suites in
the serial run and all eight intent cases on the final focused rerun. Team-only
admins are refused financial lists, detail/PDF reads, checkout/cancellation and
new intents. Positive reads use current org owners/admins. PDF reads recheck an
org-role demotion after storage returns while the person's team-admin role stays
ACTIVE. Intent races observe the exact PostgreSQL blocker chain in both commit
orders; actor/app-key expiry, membership/key/epoch revocation and insertion
failure before a gate signal retain their assertions. Every deferred race task
is released and awaited on failure. No production guard or timeout was weakened.
These fixture corrections change no runtime, schema, protocol or rendered UI.

## Provider configuration and deployment boundary

No new credentials, account IDs, Stripe API version, webhook URL, event set or
runtime variables are introduced. Keep the existing six named inputs and secret
bindings in [Team billing modes](team-billing-modes.md). Credentials remain secure
configuration; both named main-account modes stay separate. The new Sandbox
credential wins for a matching historical main TEST tuple even if the legacy key
has expired. Key rotation within the same account is supported. Replacing a
named account ID requires a new reviewed cutover/history plan.

The organisation epoch is installed once and cannot be edited. Installation and
any policy change hold the entire inclusive UTC month, including a change at
exact month start. There is no forced collection/reconciliation release. Later
complete uniform months still require exact account/mode and source evidence.
Unknown historical PAYG bindings, conflicting collections/exports and unresolved
provider work remain held. Existing captured prepaid recovery stays on its
original binding.

The parent owns deployment ordering, runtime checks and activation. No rollout
release is implied by passing local tests. Before migration, recheck unfinished
TEAM deletion jobs: each must have exact TEAM effective scope/target and the new
preserve-org marker. The migration takes a conflicting table lock and refuses
incompatible unfinished jobs; old executors cannot claim new jobs. Do not cancel,
rewrite or delete a job to make that readiness check pass.

Coordinate this as an explicit financial cutover, not a backward-compatible
rolling billing deployment. The new database refuses new TEAM captures and
per-team policy writes from an old revision. The new API returns 409
`BILLING_ORGANISATION_OVERVIEW_REQUIRED` for superseded credits/statement reads;
it does not silently upgrade an old client or its displayed actions. The Nessie
consumer must already contain the exact 6.4 organisation and negotiated authority
contract, retain original action contexts and handle an unavailable capability
without losing its authenticated session. During a deployment gap, billing may
be unavailable; do not infer a balance, retry money automatically or claim that
the old billing UI remains compatible.

Before releasing traffic, the parent must review the retained-source
dispositions, current pending work, deletion readiness and the exact immutable
heads, then coordinate consumer/API deployment and verify authentication
independently. Run the real capability, overview, saved-consent disable,
subscription and history checks in the selected organisation mode. Read-only
add-on recovery is a separate reviewed operation and does not release retained
TEAM funds or the inclusive change-month hold.

Rolling an application back does not roll the financial epoch back. An older
revision against the new schema must remain unable to create TEAM financial
work. Do not remove guards, reset epochs, rewrite pending captures or revert the
migration to restore an old billing screen. Keep billing held and repair or
redeploy the compatible consumer/API while preserving authentication and the
original captured recovery sources.

Cycle wallet boundaries use the account captured by the original subscription,
manual contract or verified paid dispatch. Another mode's wallet and a same-mode
replacement account are never substitutes. Usage-only cycles retain their
verified account in private evidence; an organisation fee's child cycle must
agree with that captured parent account. Missing or mixed account evidence
remains pending and cannot be financially finalized. Read recovery does not
backfill an unbound source from today's configured mode.
