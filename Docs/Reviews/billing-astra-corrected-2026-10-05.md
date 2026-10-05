**Two confirmed findings remain. The frozen cohort can enter CI, but should not merge unchanged.** All five SHAs match; worktrees remain clean.

1. **P2 — UOA: the scheduler strands recharge attempts that never reached Stripe.**

   **Path:** [billing-credit-auto-top-up-runtime.service.ts:434](/Volumes/External/Projects/UnlikeOtherAuthenticator/.worktrees/billing-astra-final-20261005/API/src/services/billing-credit-auto-top-up-runtime.service.ts:434), with candidate selection in [billing-credit-auto-top-up-attempt.service.ts:221](/Volumes/External/Projects/UnlikeOtherAuthenticator/.worktrees/billing-astra-final-20261005/API/src/services/billing-credit-auto-top-up-attempt.service.ts:221).

   **Trigger:** the process exits after `claimCreditAutoTopUpAttempt` commits its `PENDING` attempt but before `dispatchCreditAutoTopUpAttempt` calls Stripe.

   **Outcome:** subsequent scheduled cycles select that attempt for event recovery, then unconditionally return `awaiting_webhook`. They never reach the existing same-attempt dispatch helper. No Stripe event can arrive for this unsent request, and the unresolved attempt prevents another automatic recharge.

   **Evidence:** confirmed from the production scheduler → claim → dispatch transaction boundaries. The existing [recovery persistence test:453](/Volumes/External/Projects/UnlikeOtherAuthenticator/.worktrees/billing-astra-final-20261005/API/tests/integration/billing-credit-auto-top-up-runtime.persistence.test.ts:453) calls `runCreditAutoTopUpAccount` directly, bypassing the defective scheduler branch.

   **Minimal correction:** restore safely bounded, same-key retry under current consent; retain holds where safe replay cannot be established. Exercise the interruption through `runCreditAutoTopUpCycle`, not only its helper.

2. **P2 — Nessie/Water/DeepTest: invoice details conceal refunded amounts.**

   **Paths:** [Nessie BillingInvoicesPage.tsx:172](/Volumes/External/Projects/nessie/.worktrees/billing-astra-final-20261005/admin/src/pages/BillingInvoicesPage.tsx:172), [Water BillingInvoicesPanel.tsx:122](/Volumes/External/Projects/water/.worktrees/billing-astra-final-20261005/admin/src/pages/billing/BillingInvoicesPanel.tsx:122), [DeepTest BillingInvoicesPanel.tsx:109](/Volumes/External/Projects/DeepTest/.worktrees/billing-astra-final-20261005/up/src/screens/BillingInvoicesPanel.tsx:109).

   **Trigger:** open an ordinary payment invoice after an accepted partial or full refund.

   **Outcome:** all three omit `totals.refunded_amount`. Water and DeepTest also omit the invoice’s refunded status from the detail screen, leaving original due/paid amounts and zero outstanding looking like an unchanged payment. Nessie retains the status but provides no refund amount.

   **Evidence:** the production [adjustment writer:213](/Volumes/External/Projects/UnlikeOtherAuthenticator/.worktrees/billing-astra-final-20261005/API/src/services/billing-credit-payment-adjustment-webhook.service.ts:213) persists accepted refunds; the [customer projection:91](/Volumes/External/Projects/UnlikeOtherAuthenticator/.worktrees/billing-astra-final-20261005/API/src/services/billing-customer-invoice-prepaid.service.ts:91) supplies both status and exact refunded amount. The consumers discard that amount. This concerns ordinary invoices; the corrected credit-note `customer_credit_due` display is separate.

   **Minimal correction:** retain status on invoice details and conditionally display UOA’s nonzero refunded amount. Preserve historical payment totals and immutable legal PDFs; no new calculation or workflow is needed.

The prior seven findings are corrected in the production paths inspected: Anthropic body evidence reaches settlement; recovered nondispatch receipts retain origin; included subscription receipts reach the signed zero-cost branch; unrelated project caps no longer require sibling registration; unsupported warning/fallback writes are rejected and customer choices removed; Nessie’s held rows have entitled conversation context; currency offsets are labelled separately from credits.

DeepTest’s completed budget relay uses native project/run evidence, immutable origin storage and signed context before paid dispatch. Gemini Live commercial issuance now refuses before reservation or minting. Manual invoices appear in later payment months without changing their legal document. The four vendored protocol trees match.

**Unresolved evidence question:** some supplied screenshots represent older fixtures or revisions. For example, Nessie’s `budget-admission/mobile-light-held.png` still shows the removed warning control, and `invoices/mobile-light-credit-note.png` shows `$0.6`. These are not evidence that the corrected source still has those defects.

**Verification gates:** refresh the affected rendered evidence, including ordinary refunded invoices, and run required CI after corrections. Existing synthetic test-log summaries were inspected; I did not rerun suites or establish real Stripe/provider/deployment behavior.

| Repository | Disposition |
|---|---|
| Ledger | Proceed to required CI; merge when green. |
| UOA | Correct scheduler recovery before merge. |
| Nessie | Correct refunded-amount display before merge. |
| Water | Correct refund amount/status display before merge. |
| DeepTest | Budget completion gate closed by source review; correct refund amount/status display before merge. |