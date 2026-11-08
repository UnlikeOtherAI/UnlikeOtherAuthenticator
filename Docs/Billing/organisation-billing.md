# Organisation billing

This is the organisation financial scope introduced after PR143. It supersedes
the team policy and optional responsibility roll-up described in
[Team billing modes](team-billing-modes.md). Those records remain historical
evidence. A selected team admits the actor and scopes product content; it never
selects the payer, wallet, billing mode or financial history filter.

## Release state and continuity gate

**Activation is held.** Excluding retained positive TEAM funds from a new zero
ORG wallet is not a continuity solution. No migration date is promised.

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

The three affected Sandbox organisations need an explicit disposition before
release. The implementation does not rewrite TEAM wallet scope, create matching
ORG credits, adopt consents/subscriptions or move provider objects.

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
   All required cohorts must have a usable approved continuity outcome; a zero
   current ORG balance or disabled new TEAM charging does not satisfy this gate.

## Ownership and authority

UOA Admin **Organisations → selected organisation → Billing** owns the mode.
Admin Billing links to that directory; a team's Billing tab links to its owning
organisation. Only a current platform superadmin may change it. An absent policy
means LIVE, revision 0; the policy covers current and future teams in every
product. Each actual change appends immutable history and an administrator audit
under the organisation write fence. There is no environment team allowlist.

Customer finance requires current ACTIVE org membership and either org
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

Public protocol remains `6.3.0`, organisation protocol `1.3.0`. Capabilities need
no wallet, metering, FX or provider read. Overview sections independently report
`confirmed`, `pending_reconciliation` or `unavailable`. Unconfirmed bill sections
have no data or numeric total. Confirmed credits are actual ledger money and
holds; they do not assert settled usage. Retained TEAM money is disclosed and
excluded pending the continuity gate above.

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

Pre-existing add-on payment history that has not been captured in this source
still needs original-provider invoice recovery before history can be declared
complete. No historical entitlement, money or subscription is copied into the
ORG payer by this migration. The bounded recovery workflow and production
completeness verification remain rollout prerequisites.

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
