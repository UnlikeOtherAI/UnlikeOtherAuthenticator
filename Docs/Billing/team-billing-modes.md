# Team billing modes

Platform superadmins choose **Teams → selected team → Billing** in UOA Admin.
Admin Billing links to the team directory. The setting applies across products;
regular organisation/team members cannot choose a Stripe mode. No team allowlist
or credentials live in this setting. An absent policy means LIVE, revision 0.
Each actual change increments the revision, appends immutable mode history and
writes the platform administrator audit in the same locked transaction.

## Financial boundaries

New work resolves the exact active UOA organisation/team, its current mode and
the configured account ID for that mode. Before any Stripe effect, UOA verifies
the provider account. Every persisted provider object keeps its account ID and
livemode. Reads, Portal, cancellation, refunds, late signed webhooks, scheduled
invoice work and recovery select credentials from that captured tuple. No object,
customer, consent, balance, subscription or financial record is copied or moved.

The named binding takes precedence over a matching legacy credential. Historical
main-account TEST records therefore use the new sandbox key, even if the old TEST
key has expired. Reusing the same endpoint signing secret explicitly aliases the
legacy TEST webhook to the named sandbox binding; it is verified once and uses
the fresh account-pinned sandbox API client. A distinct unmatched account is never
silently rebound. The separate general sandbox remains unbound.

A mode change requires a quiescent scope: no balance/debt, automatic top-up
consent, active subscription/add-on, unresolved payment/setup, provider hold or
recorded current-month usage. Completed records remain readable on their original
binding. Default LIVE does not convert existing TEST balances into live funds.
An operator cannot bypass these blockers by selecting a different product.
Database capture guards serialize new effects against operator changes, check
the captured revision and reject competing historical work in another account.

The sole exception is an **explicit first Sandbox selection** for exclusively
TEST financial history on the configured sandbox account. It can retain a
positive historical TEST balance, active consent, existing subscription and
pending TEST recovery without changing any financial row or provider object.
Eligibility is rechecked by the database trigger under the organisation lock;
the UI precheck is advisory. Policy, immutable event and audit capture the adopted
physical account ID. The exception is unavailable after the first policy exists.
Actual team/organisation-scoped LIVE history, including terminal checkouts and
canceled subscriptions, another TEST account tuple, active organisation billing
responsibility, recorded current-month cumulative usage or an active unbound
SMS/Voice grant/unexpired quote refuses adoption. Global LIVE account/catalog
existence and an empty dormant customer/wallet do not count as financial history.
Competing captures and new grants/quotes take the same organisation lock, so
eligibility cannot race a committed LIVE capture. Old displayed new-work contexts
become stale. No untouched/default LIVE team is adopted automatically; its
historical funds and any eventual LIVE migration require an explicit decision.

Organisation-funded accounts and organisation subscriptions require one mode
across all active teams. Mixed teams cannot spend one shared organisation wallet.
An active organisation billing responsibility blocks team mode changes; release
it through the existing confirmed organisation-billing flow first. Creating a new
default-LIVE team in an otherwise sandbox organisation makes new shared funding
unavailable until the organisation is uniform again. Existing captured recovery
and reversals continue in their original mode.

## Original displayed actions

Public source: `packages/billing-statement-protocol`, version 5.9.0, published
source commit `a134e2c39c1dd0d2884bf128fddcd29e9c49acdc`.
Read requests negotiate `x-uoa-billing-mode-protocol: 1.0.0` alongside their other
protocol headers. UOA freezes a ten-minute opaque `billing_context` into supported
payment/setup/management request bodies. It captures subject, product key, exact
endpoint/body, Stripe account/mode and team mode revision. Fixed seat quantity
remains separately validated. Context is neither identity authority nor payment
idempotency; existing actor and durable-effect controls still apply.

Carry the **original displayed token** browser → consumer API → UOA. A consumer
may validate an action ID against a fresh server projection, but must never swap
the old/absent token for that projection's new one or accept browser-authored
arbitrary UOA bodies/URLs. Keep old unbound clicks unbound. Missing context is
accepted only for untouched LIVE revision 0. Unnegotiated changed-mode actions
are disabled with UOA-authored translated copy. Existing signed cancellation
intents already capture their original target account/subscription.

| Refusal | Meaning | Consumer response |
| --- | --- | --- |
| 409 `BILLING_CONTEXT_REQUIRED` | This team requires a displayed binding | Retain session; refresh display; require a new click |
| 409 `BILLING_CONTEXT_STALE` | Expired or changed account/mode/revision | Same; never auto-retry with a freshly substituted token |
| 400 `BILLING_CONTEXT_INVALID` | Invalid signature or different subject/app/path/body | Refuse the mutation and refresh the display |

SMS protocol 1 does not carry a displayed mode context. New number purchases on
sandbox or previously changed teams are refused rather than silently upgraded.
Existing number payment reads, attachment, cancellation and refund evidence use
the captured unique offer catalog/account. A negotiated SMS purchase protocol is
required before enabling new sandbox number purchases.

## Immutable monthly epoch and reconciliation

`billing_mode_cutover` has exactly one immutable installation timestamp,
`activated_at`, inserted by migration `20261107180000_team_billing_modes`.
`billing_team_mode_events` append each mode revision and effective UTC time.
Do not update/delete either history, rewrite financial rows or reset the epoch.
The installation and coordinated traffic activation **must occur in the same UTC
month**. If that cannot be guaranteed, stop activation and review a new source-
backed cutover plan; the installation timestamp is not proof of later traffic.

Ledger monthly totals have no Stripe account/mode dimension. UOA cannot infer a
split. Cumulative credit settlement and Stripe usage export hold the entire UTC
month containing installation, and any month containing a mode change. Both
intervals include an instant exactly at UTC month-start: `[start, next start)`.
Periods before installation require the original captured source to predate the
period end; a new live account cannot acquire an old month. Later full months use
the mode history at month start. Mode history proves mode, not the configured
provider account identity. Before and after cutover, collection refuses another
account's credit settlement or Stripe export reservation for the same overlapping
organisation/team/month. An organisation/month advisory transaction lock is
taken before payer/subscription row locks, serializing competing accounts.
Each collector also updates a UOA-owned organisation/month lock row. This forces
an already-started Serializable credit transaction to retry after a winning
default-isolation export/collector commits; waiting on an advisory lock alone
would leave its old snapshot intact. These control rows contain no money or
provider objects and are not an allocation or reconciliation authority.

Replacing `STRIPE_LIVE_ACCOUNT_ID` or `STRIPE_SANDBOX_ACCOUNT_ID` is unsupported
by this rollout and requires a new reviewed account cutover/history plan. It must
not be treated as credential rotation or as proof that existing monthly usage
belongs to the replacement account. Rotating a key within the same verified
physical account/mode is supported. Captured old objects still require their
original tuple's credentials; no account replacement fallback is provided.

The hold codes are `BILLING_MODE_TRANSITION_RECONCILIATION_REQUIRED`,
`BILLING_MODE_HISTORY_RECONCILIATION_REQUIRED` and
`BILLING_MODE_HISTORICAL_ACCOUNT_MISMATCH`. Credits reads on the billing-status
protocol retain the confirmed balance with UOA's `pending_reconciliation` status
and translated pending copy. They never invent a zero balance. Older consumers
that cannot represent pending status receive the existing reconciliation refusal.
Captured prepaid reservations, exact provider receipts, refunds/revocation,
corrective webhooks and already captured payment recovery continue independently;
they do not acquire an ambient LIVE binding.

Customer invoice lists filter prepaid cash and Stripe invoices by the selected
team's named physical account **and** mode. A missing named account configuration
refuses the list; mode alone is not an account binding. Known historical invoice
detail/download IDs continue through their original captured source and current
scope authorization. Manual invoice scope and legal-document isolation remain
independent from Stripe mode. Historical invoices are never copied into LIVE.

**Release procedure:** a later complete UTC month resumes automatically if its
history is uniform and its original source exists within that month. The held
transition month remains held, including after month end. This change provides
no force-release switch. Before collecting it, an operator must reconcile
source-confirmed dispatch/payment/credit evidence per original tuple, prove no
duplicate collection and have the exact allocation and collection operation
reviewed separately. Do not release it by changing mode back, deleting evidence,
inventing a split, moving balances or replaying the cumulative total in LIVE.
If collecting that month immediately is an activation requirement, rollout is
blocked until that separate reconciliation operation exists and is reviewed.

## Secure configuration and coordinated activation

### Catalog preparation (operator owned)

`API/src/cli/provision-stripe-commercial-catalog.ts` is the guarded DB binding
workflow. It reads existing Stripe Products/Prices; it does **not** create remote
Products/Prices or take payments. The exact static remote contract is
`API/src/services/billing-stripe-catalog-provisioning-spec.ts`: 15 one-time credit
prices (USD/EUR/GBP × 10/25/50/100/1000) and monthly USD 50 DeepWater privacy.
Its validator requires exact lookup keys, metadata, currency, terms, a single
credit product, active status, account and livemode before any DB write.

In a secure isolated operator process, inject the selected named key into this
CLI's `STRIPE_SECRET_KEY` and the authorized `DATABASE_ADMIN_URL`. This temporary
input does not modify the production legacy secret/binding. Never print the key
or put it in shell arguments/history. From `API`, first run:

```text
pnpm billing:provision-stripe-catalog --dry-run --stripe-account acct_1Sn2VfGY1l8e0vu2 --stripe-mode live
```

Review missing/drifting remote terms and every proposed DB action. After the
parent prepares the reviewed canonical LIVE remote catalog, use:

```text
pnpm billing:provision-stripe-catalog --apply --stripe-account acct_1Sn2VfGY1l8e0vu2 --stripe-mode live --confirm PROVISION_UOA_STRIPE_CATALOG:acct_1Sn2VfGY1l8e0vu2:live
```

Run dry-run again and require `no-op`. Validate TEST independently with
`--stripe-mode test` and exact `:test` confirmation if apply is needed; never take
TEST IDs into LIVE. Financial catalog rows are keyed by captured account;
offer/feature definitions are shared commercial terms. Review retirement actions
on shared definitions carefully: they affect both modes.

**Storage gap:** this CLI/spec does not provision or validate the three historical
storage prices. No dedicated storage catalog binding implementation exists in the
current UOA source. Remote presence alone does not prove storage entitlement or
checkout readiness. Do not copy those IDs into a tariff/add-on mapping or claim
this CLI has bound them. Storage activation needs its reviewed owning contract.

Base subscriptions use `ensureStripeCatalog` keyed by account/service/currency
and `ensureStripeTariffPrice` keyed by account/tariff. Products, meters, usage
prices and applicable fixed monthly tariff prices are created lazily through the
selected account on first checkout and revalidated on reuse. Idempotency keys
and metadata include account/mode. This static CLI does not pre-provision them.
Verify restricted-key Products/Prices/Meters write permissions and review tariff
terms before the first LIVE checkout. TEST price IDs never substitute for LIVE.

Operator preflight on 7 November 2026 (parent-owned, no DB apply): LIVE canonical
remote validation passed and proposed 17 DB creates (one account, 15 credit
catalogs and one privacy catalog), zero retirements, 135 no-ops and nine skips.
TEST proposed zero creates/retirements, 152 no-ops and nine skips. Uncovered
DeepSignal/Fermentea and unregistered Docgen remain preserved. The LIVE remote
credit product is `prod_VaOyNWuxiN0ycJ`, privacy `prod_VaOyTqb1RIfUzM`; these are
not substitutes for transactional DB binding. Both stored keys passed GBP/EUR
FX quote preflight with `2025-07-30.preview`, `lock_duration=none`. Readiness
evidence is operator-owned under `billing-mode-20261107/operations` and does not
authorize activation or payment writes.

Both named accounts are `acct_1Sn2VfGY1l8e0vu2`; LIVE is livemode=true and sandbox
is the main account's TEST mode, livemode=false. General sandbox
`acct_1Sn2VoGer0cNi5R2` is not configured.

| Cloud Run input | Binding |
| --- | --- |
| `STRIPE_LIVE_SECRET_KEY` | `uoa-auth-stripe-live-secret-key:1` |
| `STRIPE_LIVE_WEBHOOK_SECRET` | `uoa-auth-stripe-live-webhook-secret:1` |
| `STRIPE_LIVE_ACCOUNT_ID` | `acct_1Sn2VfGY1l8e0vu2` |
| `STRIPE_SANDBOX_SECRET_KEY` | `uoa-auth-stripe-sandbox-secret-key:1` |
| `STRIPE_SANDBOX_WEBHOOK_SECRET` | `uoa-auth-stripe-sandbox-webhook-secret:1` |
| `STRIPE_SANDBOX_ACCOUNT_ID` | `acct_1Sn2VfGY1l8e0vu2` |

Legacy `STRIPE_SECRET_KEY=uoa-auth-stripe-secret-key:latest` and
`STRIPE_WEBHOOK_SECRET=uoa-auth-stripe-webhook-secret:latest` remain untouched.
They are historical fallback inputs, never the new-work default. Auth startup
does not probe Stripe or require a successful provider request. Legacy-only boot
remains valid; new billing work fails closed if its named slot is unavailable.

The deployment workflow uses GitHub variables `UOA_STRIPE_LIVE_CONFIGURED` and
`UOA_STRIPE_SANDBOX_CONFIGURED` (both initially false) to include the named
bindings, plus `STRIPE_LIVE_ACCOUNT_ID` and `STRIPE_SANDBOX_ACCOUNT_ID`. With
`STRIPE_BILLING_ENABLED=true`, preflight requires both prepared slots. These are
deployment controls, not per-team policy. Keep `UOA_STRIPE_BILLING_CONFIGURED=true`
for the existing legacy bindings. New secret versions are explicitly pinned to 1;
rotation requires a separately verified binding update.

Both Stripe endpoints use
`https://authentication.unlikeotherai.com/billing/v1/stripe/webhook`, pinned to
`2026-06-24.dahlia` and the unchanged exact 25 lifecycle events in
`Docs/Requirements/billing-tariffs.md`. Main TEST endpoint
`we_1TvfLoGY1l8e0vu2fpQiv32g` remains enabled. LIVE endpoint
`we_1UZDowGY1l8e0vu28KfTXtLY` stays disabled until coordinated rollout. No endpoint
is created by this implementation.

Activation owner (parent/operator), after final code and reconciliation review:

1. Verify all four version-1 secrets are enabled, restricted API keys resolve the
   exact main account/mode, required operations are permitted, and runtime service
   account `193510011126-compute@developer.gserviceaccount.com` has inherited or
   resource-scoped Secret Manager accessor access. Never print key values.
2. Update the readiness job from its legacy-TEST-only assumption to check both
   named tuples independently. Review account-specific catalog readiness and
   existing financial blockers; apply the reviewed canonical LIVE DB binding
   plan with the guarded command above, then require a no-op preview. Never copy
   TEST catalog objects into LIVE. Review historical TEST adoption candidates
   explicitly; the deployment must not select them automatically.
3. Deploy the consumer pinned to protocol 5.9.0 with original displayed-context
   forwarding and 400/409 recovery. Test old unbound clicks remain unbound.
4. Set the four deployment variables above only after approval. Merge/deploy UOA
   with both slots in the same revision. Watch migration locks and health; the
   migration uses a five-second lock timeout and no financial backfill. Preserve
   the serving revision if startup/migration/preflight fails. Verify immutable
   epoch and current UTC month before enabling new traffic.
5. Verify auth health independently, named tuple reads, TEST historical recovery,
   LIVE-default credits with pending-month status, Admin desktop/mobile selection
   and stale-action refusal. Enable the prepared LIVE endpoint and verify signed
   delivery/replay in the correct tuple. No live charge is part of this check.
6. Keep both named credentials and both webhook bindings available for delayed
   objects and recovery. Rolling application traffic back does not undo the
   additive database guards or epoch. Do not fall back to the expired legacy key
   or switch to TEST to hide a LIVE configuration failure. Review billing recovery
   separately while keeping authentication available.

Until this coordination is complete, do not merge a change that would activate
LIVE-default runtime behavior under legacy-only production configuration.
