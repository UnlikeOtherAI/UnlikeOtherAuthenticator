# Adversarial Billing Review — Frozen Cohort (2026-10-05)

Reviewed read-only at the pinned SHAs (Nessie `74c4d23b`, UOA `42647cd6`, Ledger `9d543544`, Water `516c6907`, DeepTest `9030cec9`), each diffed against its `origin/main` merge-base (Nessie +20 commits on top of merged PR #1115 `0d237d1b`, UOA +202, Ledger +17, Water +14, DeepTest +9). Proof tier: **source-level inspection plus the provided synthetic screenshots/PDFs only** — no tests executed, no database, Stripe, or provider calls. Prior pass counts in the register are unverified claims from here.

## Confirmed Findings

**F1 — LOW — Customer money displays strip trailing zeros: "$0.6" for $0.60, "$50" for $50.00**
- UOA `API/src/services/billing-money.service.ts:56` — `serializeDecimal` strips trailing fractional zeros, and `exactMoney().display` (line 148-160) feeds every served `cycleMoney`/`exactMoney` string consumed by all three products' invoice, cycle, credit-note and statement pages.
- Reachable trigger: any customer money amount whose minor units end in zero. Evidence (synthetic fixtures): `nessie/invoices/desktop-light-credit-note.png` shows "Credit owed $0.6" directly beside "Credit note amount $1.56" and "Tax $0.26"; `nessie/privacy/desktop-statement.png` shows "$3.6 due … Usage $3.6".
- Outcome: inconsistent decimal precision on financial documents — a customer scanning "$0.6" next to "$1.56" cannot tell cents precision at a glance; on a credit note stating money owed back, that is a trust defect, not an arithmetic one (`amount_minor` stays exact).
- Minimal fix: render `display` with the currency's fixed minor digits in `exactMoney` (keep `amount`/`amount_minor` as-is).
- Certainty: confirmed (code + rendered output).

**F2 — LOW — Terminal voided cycles say "No documents are available yet."**
- Nessie `admin/src/pages/BillingCyclesPage.tsx:205` with `admin/src/i18n/locales/en-US/billing.json:265`; the same generic copy renders on Water and DeepTest voided-cycle pages.
- Reachable trigger: open any voided cycle's Documents section. Evidence: `nessie/cycles/desktop-light-voided.png`, `deeptest/cycles/billing-cycle-voided-desktop-light.png`.
- Outcome: "yet" promises future availability in a terminal state; the same screen correctly says the original invoice stays in its historical cycle, so the documents line contradicts it. The page header already carries the decision the user needs; the empty-state line serves none.
- Minimal fix: state-aware copy for voided cycles ("Documents remain on the original cycle"), or drop the line on terminal states.
- Certainty: confirmed (code + rendered output).

**F3 — LOW — Cycle periods render raw ISO-8601 UTC timestamps with milliseconds to customers**
- Nessie `admin/src/pages/BillingCyclesPage.tsx:159` (`{cycle.period.starts_at} — {cycle.period.ends_at}`), mirrored in Water `BillingCyclesPanel` and DeepTest `BillingCyclesPanel` per `water/cycle-reload-final/billing-cycles-mobile-light.png` and `deeptest/cycles/billing-cycles-desktop-light.png` ("2026-07-01T00:00:00.000Z to 2026-08-01T00:00:00.000Z", also on seat-interval rows).
- Outcome: implementation-format timestamps on a customer financial surface; cycle bounds are always UTC month boundaries, so the precision communicates nothing and the format reads as jargon.
- Minimal fix: format as dates in the three cycle panels.
- Certainty: confirmed (code + rendered output).

No HIGH or MEDIUM defects confirmed. The financial invariants below were re-derived from source, not trusted from the register.

## Earlier Findings — Independently Re-verified

- **D1 (schema drift): fixed.** All four `packages/billing-statement-protocol` trees are byte-identical (aggregate SHA-256 `a8b91e80…`, version 5.0.0), including `tax`/`gross_total` in cycle totals and `evidence_complete` in budget schema — the latent twin is gone.
- **D2 (preview ID refused): fixed.** Preview grammar accepted in Nessie `api/src/routes/billing.ts:51`, Water `api/src/routes/billing-cycles.ts:16`, DeepTest `api/src/uoa-billing-cycles.ts:22`; UOA emits and serves `preview:<month>:team` (`billing-cycle-read.service.ts:145,222`).
- **D3 (held-settlement dead end): fixed within bound.** Ledger `api/src/repositories/commercial-hold-repository.ts` retries only immutable in-bound receipts, claims atomically, audits via the audit chain, and keeps over-bound/unproven dispatches held with explicit reasons; doorway `CommercialHoldsPanel` on Monitor/Ledger pages; operator-gated (`ledger-operator.ts`). Unknown paid usage still never reads as zero — correct.
- **D4 (auto-recharge currency): fixed.** Attempt currency is a persisted column and the invoice source hard-fails on any source/webhook/credit-entry mismatch (`billing-credit-payment-invoice-source.service.ts:40-52`); each payment intent yields exactly one invoice, rebind forbidden.
- **D5:** rejection stands — commit-time seat boundaries are the only externally visible ones; agreed.
- **D6 (locale ordering): fixed where financial.** Cohort/fingerprint/allocation ordering uses `Buffer.compare`; the one remaining `localeCompare` (`billing-cycle-read.service.ts:190`) sorts fixed `YYYY-MM` display keys where binary and locale orders coincide — not a finding.
- **D7/D8: fixed.** Terminal authority refusal ends jobs; preview cursor preserves both same-month payer scopes (`billing-cycle-read.service.ts:188-191`).

## Invariants Verified in the New Session Work

- **Markup once, 30%, private.** Default `DEFAULT_STANDARD_MARKUP_BPS = 3_000` (`billing-tariff-input.service.ts:16`), overridable per tariff and contract version, frozen per dispatch (`frozenMarkupBps`) and applied exactly once through cumulative-quanta buckets (`billing-paid-liability.service.ts`); manual invoices reuse the frozen receipt-rated microcredits rather than re-rating (`billing-invoice-paid-receipt-cohort.service.ts`). No markup/raw cost/token fields exist in the served contracts; cycles serve only digest-verified `publicSnapshot`, never `privateEvidence` (`billing-cycle-read.service.ts:56-77`); consumer components render credits only.
- **No double collection.** PREPAID services are excluded from wallet settlement with legacy/mode-conflict holds (`billing-credit-settlement.service.ts:352-358`); Stripe-reserved vs manual-invoice collectors hold on overlap (`BILLING_CREDIT_MULTIPLE_COLLECTORS_UNPROVEN`); the manual-invoice paid-receipt cohort is frozen at draft and re-proven under org-wide account locks at issue (`billing-invoice-lifecycle.service.ts`, `…-issue-guard.service.ts`), with both lock orders PG-tested per the cohort evidence. Ambiguous history (`teamId: null` settlements, legacy receipts, over-bound actuals) holds explicitly — no silent zero.
- **Reserve/settle/release.** Reserve before egress holds in all three products (Nessie `budget_held` + prepare job in one SQL statement `packages/db/src/queue.ts:138-162`; DeepTest `admitPaidNativeRun`; Water launch admissions). Settle is idempotent-once (unique idempotency keys, receipt conflict holds, cumulative buckets). Release only on the cancellation path with receipt binding. Stripe monthly charges verify remote items before creating and fence retries with DB-clock + lease tokens (`billing-stripe-monthly-charge.service.ts`).
- **Budget ancestry.** Org/team/project/physical-run/original-root scopes all enforced per dispatch with org-serialized advisory locks; native run scopes are owner- and birth-bound; continuations inherit the immutable root (`worker/src/control/run-credit-budget.ts`, `packages/runtime/src/run-billing-origin.ts`); origins are delete-proof by trigger (`20261004194000_preserve_run_billing_origin`); incomplete evidence or missing bounds hold paid egress.
- **Invoices.** Per-payment prepaid invoices (unique payment-intent binding, charge month from Stripe's signed event time); credits-only cycles with opening/closing balances; funded wallet offsets re-proven against issued originals (`billing-cycle-manual-funded-offset.service.ts`); credit notes only on fully cash-paid single-line invoices, with `customer_credit_due = paid − refunded` — gross note amount is never presented as money owed (`billing-customer-invoice-credit-note.service.ts:26`, `billing-cycle-manual-credit-note-capture.service.ts:139`).
- **Scope/revocation.** Every billing read resolves membership fresh (`billing-funding-viewer.service.ts`); downloads re-authorize before and after the storage read with hash binding (`billing-customer-invoice-read.service.ts:303-325`); all three consumers reject any UOA response outside the selected-team subject, including download-action body rebinding (Nessie `uoa-billing-cycles.ts:55-74`).
- **Gemini Live.** Remains evidence-only; no device telemetry reaches a billed path (`docs/standards/voice-calling.md`, Ledger metering requires signed product-bound identity).
- **UI.** Doorways exist end-to-end (sidebar → Credits and billing → cycles ↔ invoices; held-run Reauthorise; Ledger commercial-holds panel); loading/error/empty/retry/pending/download states present; operator telemetry stays on operator surfaces (`/admin/advanced/*`, Ledger Monitor), customer views stay credit-denominated. No AI-slop copy found on the new surfaces.

## Unresolved Questions (not findings)

- `enqueueRunExecution` silently no-ops if an uncapped `run.execute` already holds the idempotency key, dropping a later cap; I found no caller path that enqueues the same runId twice with different intents (creation is atomic), so this is theoretical.
- An org contract version effective the current month, created after prepaid usage exists, relies on the multiple-collector holds to stay safe; I did not trace contract-activation guards end-to-end.
- `manualInvoiceReservedMicroMinor` truncates `(teamRated − teamCredits) / 10n` per line — bounded at 9 micro-minor (≈10⁻⁵ credits) per line, no realistic financial effect.

## Completion Gates (known in-progress; none re-flagged as defects)

- DeepTest credit-budget UI/control replacement incomplete.
- Real producer credit-note fixture for `customer_credit_due` in progress (the cycle-side field is served and correct; the ambiguous-historical-tender hold must stay explicit).
- Gemini Live commercial enablement stays frozen pending the architecture decision.
- Follow-up PRs unmerged; required checks and the green-PR workflow still owed. UOA80/Nessie1116 contract seam and the prepaid-usage vs payment-invoice split are preserved in this snapshot.

## Per-Repo Disposition

- **UOA** `42647cd6`: double-tender binding, credit-note, seat and payment-retry paths verified sound; F1 (money display) is the only fix owed here. Proceed.
- **Nessie** `74c4d23b`: admission, held-run, cycles/invoices surfaces verified; F2/F3 copy fixes owed. Proceed.
- **Ledger** `9d543544`: raw-facts boundary, held-settlement recovery, budget ancestry verified. Proceed.
- **Water** `516c6907`: launch admissions and billing panels verified; shares F3. Proceed.
- **DeepTest** `9030cec9`: origin store and billing panels verified; shares F2/F3; credit-budget UI gate outstanding. Proceed with gate.

**Verdict:** the committed cohort is safe to proceed to final verification (fresh review of the fully integrated result, then the required-check/green-PR workflow). F1–F3 are small, strictly presentational fixes that should land before customer release but do not block integration verification; the four completion gates above must close before the shared public schema is frozen.
