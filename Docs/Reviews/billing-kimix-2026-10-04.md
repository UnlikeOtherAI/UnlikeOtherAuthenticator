Review complete. Here is the full report.

# Adversarial Billing Review — Frozen Cohort (2026-10-04)

Reviewed read-only: Nessie `ae7239d95`, UOA `749f59e9`, Ledger `220a32f`, Water `e2bceecf`, DeepTest `71562fae`, each diffed against its merge-base with `origin/main`. No code was executed; all findings are source-level.

## Confirmed Defects

**D1 — HIGH — Cycle contract drift breaks every consumer page once a cycle finalizes**
- UOA `packages/billing-statement-protocol/src/cycle-schema.ts:53-67` requires `tax` and `gross_total` in cycle totals; UOA emits them for finalized cycles (`API/src/services/billing-cycle-manual-invoice.service.ts:244-248`). Nessie/Water/DeepTest vendor the *same package version 5.0.0, same `BILLING_CYCLES_SCHEMA_VERSION = 2`* but an older schema whose totals object is `additionalProperties: false` without `tax`/`gross_total` (e.g. Nessie `packages/billing-statement-protocol/src/cycle-schema.ts:53-65`), and all three validate responses strictly (Nessie `api/src/services/uoa-billing-protocol.ts`, DeepTest `api/src/uoa-billing-validation.ts:26`).
- Failure: as soon as one cycle leaves `pending_reconciliation` with totals, `parseBillingCyclesListV2`/`…DetailV2` fail → the Nessie/Deepwater/Deep Test Billing cycles pages error out entirely. Same-version-different-content also defeats the version pin as a compatibility signal.
- Correction: revendor the protocol into all three consumers (and bump the package version), or strip `tax`/`gross_total` from the served v2 contract until revendor. Missing proof: any cross-repo integration test running a *finalized* cycle payload through a consumer validator; current fixtures downstream contain no `tax`/`gross_total`.
- Latent twin: UOA's `budget-types.ts` adds `evidence_complete`; downstream `budget-schema.ts` lacks it — will break the same way when budgets are served.

**D2 — MEDIUM — The current-month "Open preview" row is unopenable in all three consumers**
- UOA emits preview IDs with colons: `preview:YYYY-MM:team` (`API/src/services/billing-cycle-read.service.ts` `preview()`). Nessie (`api/src/routes/billing.ts:48-50`), Water (`api/src/routes/billing-cycles.ts` `DetailQuery`), and DeepTest (`api/src/http.ts:3478`) all validate `cycle_id` as `^[A-Za-z0-9_-]{1,256}$` and 400 the colon. UOA's own detail endpoint explicitly supports the preview ID.
- Failure: the first row on every new Billing cycles page (the open month) errors on click. Exactly the "doorway that doesn't open" Rule zero names.
- Correction: allow the preview ID grammar in consumer validators (or change UOA to a colon-free ID and revendor).

**D3 — MEDIUM — Over-bound or unresolved settlement is a permanent dead-end hold**
- Ledger `api/src/repositories/provider-dispatch-commercial-repository.ts` (`reconcileOne`, settlement branch): actual cost above the frozen bound, or a non-metered receipt, sets `commercialState: "held"` with no retry and no exit. UOA `API/src/services/billing-prepaid-reservation.service.ts` `finalizePrepaidDispatch` rejects over-bound settle with 409. The reservation stays `ACTIVE` forever: reserved credits locked, actual provider cost never debited (undercharge), no operator surface or recovery path named.
- Correction: add a bounded operator reconciliation flow (release-and-invoice-actuals, or explicit write-off) and a doorway surfacing held dispatches; at minimum document the manual exit. Missing proof: any test or runbook demonstrating recovery from `held`.

**D4 — LOW/MEDIUM — Auto-recharge invoice queue hard-pins USD**
- Migration `20261004183000` backfill filters `webhook.currency = 'USD'` and inserts `currency 'USD'`; `BillingCreditAutoTopUpAttempt` has no currency column at all (`API/prisma/schema.prisma:3551`). Runtime code enforces USD today, so this is consistent now — but a future non-USD auto-recharge would be silently excluded from the legal-invoice queue (lost receipt), not held loudly.
- Correction: record currency on the attempt and fail closed on mismatch instead of filtering.

**D5 — LOW — Seat interval timestamps are commit-time, not change-time**
- `20261004153000`/`20261004168000` `billing_seat_refresh_org` stamps `starts_at`/`ends_at` from `clock_timestamp()` at the deferred trigger (commit). A long-running membership transaction shifts proration evidence: departures bill until commit (small overcharge), joins bill from commit (small undercharge) — at odds with the "exact UTC partial price" claim.
- Correction: derive interval bounds from the row's own change timestamp where available.

**D6 — LOW — `localeCompare` still used in financially significant ordering**
- `API/src/services/billing-credit-rating.service.ts` (`compareBuckets`, drives remainder-credit allocation), `billing-invoice-calculation.service.ts:240,255`, and `billing-cycle-manual-invoice.service.ts` (`paymentFacts`/line sorting inside `invoiceSourceFingerprint`). The 182030 migration pinned DB ordering to `COLLATE "C"` to match `Buffer.compare`, yet these TS paths are ICU-locale dependent; hyphenated UUIDs order differently across ICU locales → fingerprint/allocation mismatches that surface as held invoices or, where unchecked, nondeterministic cent assignment.
- Correction: use the same `Buffer.compare` binary ordering everywhere the DB or a persisted digest depends on order.

**D7 — LOW — Water treats terminal grant refusal as a retryable interruption**
- `water/api/src/ledger/compute-routing.ts`: `renewJobComputeGrant` failure (including a *revoked* grant — deterministic) is wrapped `{ interrupted: true }`, so the checkpoint re-dispatches forever; each attempt re-hits UOA and is refused (no charge, but a hot loop and a job that never terminates).
- Correction: propagate a terminal class for revoked/expired/reauthorization-required and stop the job.

**D8 — LOW — Nessie cycle-list cursor fallback can skip rows**
- `UOA API/src/services/billing-cycle-read.service.ts` `listBillingCycles`: when `includePreview && limit === 1`, `selected` is empty and `next_cursor` falls back to `${currentMonth}:team`, which filters out a same-month *organisation* row (`cycleOrder 1 > 0` never emitted). Degenerate but reproducible with `limit=1`.

## Unresolved Questions

- **Team cycles under an org payer**: `listBillingCycles` hides `payerScope = ORGANISATION` team cycles from team managers, and detail re-authorizes them as org-manager-only. If a team billing manager should see their own team's usage cycle when the org pays, this is an entitlement narrowing defect; if deliberate (liability is the org's), it needs a written note.
- **Tariff precedence**: `billing-tariff-history.service.ts` `resolveBillingTariffForMonth` lets a TEAM-scoped tariff event outrank an active org CUSTOM contract; contract activation "rejects team overrides" only at activation time — nothing here blocks a team event created *after* activation.
- **Nessie dropped statement self-checks**: `nessie api/src/services/uoa-billing-statement.ts` removed the `plan.tariff_id`/`version` vs `pinned_inputs` and `statement_product` consistency assertions. If the v2 contract intentionally removed those fields, fine — but the consumer now verifies less of what it renders; confirm the binding moved somewhere.
- **Ledger `revokeResearchJobComputeGrants`**: a 403/404 during recovery marks the grant locally revoked without proving UOA state ("no issue committed" vs "denied for another reason" are conflated). Safe only if UOA's renewal path independently re-checks revocation — it does (`recipientGrant` + `assertCurrentGrantAuthority`), so the residual risk is low, but the comment's claim is unproven.
- **FULL_MONTH timing**: `billing-seat-month-quote.service.ts` charges a full month for any >0ms presence even when the subscription itself activated mid-month; confirm that is the intended commercial语义 for activations (vs full-month only for membership within an already-active month).

## Known-Unfinished Tranches — Independently Confirmed (not defects)

- Per-payment InvoiceV1: source rows are recorded atomically with the funded credit (`billing-credit-payment-invoice-source.service.ts`, called inside the credit-entry transaction — atomicity verified), but nothing transitions `PENDING → ISSUED`; no customer invoice list/detail/download route exists in `API/src/routes/billing/`.
- Authoritative credit budgets: zero budget enforcement in UOA `API/src` (only rate-limiter hits); `reservePrepaidDispatch` checks balance + active holds only.
- Old token controls not yet replaced: Nessie `admin/src/components/features/usage/BudgetDialog.tsx:69,203` still exposes a `tokenLimit` token cap. (Voice: client-reported units remain commercially held — correctly not trusted anywhere I inspected.)
- Late corrections: Ledger settles `correction ?? original` only at settle time; a correction landing after `SETTLED` has no re-settlement flow.
- Manual invoice capture refuses any invoice with tax or credits (`billing-cycle-manual-invoice.service.ts:176`), so taxed invoices hold cycles until the pending tax/allocation tranche lands — consistent, but worth tracking as a hold with no operator doorway yet.

## What I Verified As Sound

- Webhook scoping (account/livemode/customer/amount/currency + signed-event dedupe by `(account, eventId)`), funded-credit atomicity, rebind protection, and concurrent duplicate-webhook safety via `(creditAccountId, idempotencyKey)` unique + `FOR UPDATE` balance lock.
- Prepaid reservation/settlement: atomic holds, pinned reservation tariff, cumulative rounding bucket (ceil on cumulative total), DB trigger cross-checks of settled-reservation evidence on every PREPAID_USAGE debit, cancellation fencing via CANCELLED tombstones, and Ledger's CAS-gated egress with a durable reconciler.
- Invoice credit cent allocation: TS `Buffer.compare` ordering matches the DB's `COLLATE "C"` rewrite (182030); half-up cumulative formula matches on both sides.
- Cycle integrity: snapshot hash verification, quote re-verification under org lock, immutable revisions, void preserving the original issued PDF with zeroed new revision, fresh re-authorization (including post-storage-read recheck) on org-scope reads/downloads.
- Job-compute grant lifecycle: frozen identity/epoch, digest-only secrets in UOA, sealed secrets in Water, origin-side revocation before Water cancel, per-attempt renewal, and Ledger's final identity/status recheck before dispatch.
- Customer DTOs: markup/cost/raw units stay out of statement, cycles, breakdowns, and credit displays; contract-editor markup visibility is superuser-only; Nessie billing components render no token readouts.

## Unverified Operational Proof

I ran nothing (read-only mandate): no test suites, migrations, or CI evidence was reproduced; the register's pass counts (e.g. Ledger's "1,540 passed, 76 failed" fixture repair) are unverified claims from here. The D1 break in particular has no cross-repo fixture exercising a finalized cycle through a consumer validator — recommend adding exactly that as the gating test.