**This cohort is not ready for final verification.** I found four metering/admission defects and three customer-facing issues.

All five worktrees match the requested SHAs and remain clean. Local merge-bases with `origin/main`:

| Repository | Merge-base |
|---|---|
| Nessie | `0d237d1ba2d643a987d617476baa30616ad2e6ea` |
| UOA | `e0ed98156c479fa7fab85b76cc6be935c3e2590c` |
| Ledger | `422c6ef435afd8057ed475d28c0edfe06b2bd01f` |
| Water | `c44d2512f2801421bd94f59f8752e9f93a5d32cb` |
| DeepTest | `73fbc488ae57ea0df75c5a9e58e8eae9d166229c` |

The review included the original metering changes in Nessie PR1115, Ledger PR52 and Water PR191, beyond the current branch diffs.

1. **P1 — Ledger: successful Anthropic streams cannot settle their reserved credits.**

   In [provider-stream.ts:59](/Volumes/External/Projects/ledger/.worktrees/billing-astra-final-20261005/api/src/services/provider-stream.ts:59), the Anthropic collector retains counters but never populates `providerBody`. The gateway consequently passes only `{model}` into receipt recording. [provider-dispatch-repository.ts:341](/Volumes/External/Projects/ledger/.worktrees/billing-astra-final-20261005/api/src/repositories/provider-dispatch-repository.ts:341) requires complete provider-body usage before promoting the frozen-card calculation to authoritative actual cost.

   **Trigger/outcome:** an ordinary successful paid Anthropic stream finishes with known tokens but `rawProviderActualCost = null`. Commercial reconciliation moves it to an indefinite hold rather than settling, leaving credits reserved and subsequent budget evidence incomplete.

   **Evidence/certainty:** confirmed by source and a bounded in-memory execution of the actual collector and completeness checker: 100 input/25 output tokens, `usageKnown: true`, no provider body, settlement completeness false. No provider or database call.

   **Minimal fix:** retain the complete authoritative Anthropic usage across start/delta/stop frames and pass that evidence into the existing settlement path. Verify the successful stream through receipt creation and settlement, not only counter extraction.

2. **P1 — Ledger: recovered nondispatch receipts poison subsequent finite-budget admission.**

   [provider-dispatch-commercial-repository.ts:78](/Volumes/External/Projects/ledger/.worktrees/billing-astra-final-20261005/api/src/repositories/provider-dispatch-commercial-repository.ts:78) creates the immutable nondispatch receipt without `originProduct`, although the dispatch freezes it. [metering-paid-receipt-set.ts:176](/Volumes/External/Projects/ledger/.worktrees/billing-astra-final-20261005/api/src/repositories/metering-paid-receipt-set.ts:176) rejects that mismatch **before** considering the proven-zero nondispatch branch.

   **Trigger/outcome:** a reservation denial or timeout is reconciled through `authorization_pending → cancellation_pending → released`. Despite proven nonegress and release, its budget history stays unresolved. Further attempts under the affected finite budget fail with `BUDGET_EVIDENCE_INCOMPLETE`; topping up or increasing the cap does not repair the evidence.

   **Evidence/certainty:** high-confidence source-confirmed writer/reader mismatch on the normal recovery path.

   **Minimal fix:** preserve the frozen origin on this receipt writer and its idempotency checks. Repair affected immutable histories through the existing correction mechanism. Exercise recovery followed by a real budget-proof read.

3. **P1 — UOA/Nessie: capping one project blocks an unrelated, uncapped project.**

   [billing-credit-budget-dispatch.service.ts:132](/Volumes/External/Projects/UnlikeOtherAuthenticator/.worktrees/billing-astra-final-20261005/API/src/services/billing-credit-budget-dispatch.service.ts:132) treats **any** project policy in the team as requiring native registration of the incoming project. Nessie registers projects only when their own budget is edited, in [uoa-credit-budgets.ts:111](/Volumes/External/Projects/nessie/.worktrees/billing-astra-final-20261005/api/src/services/uoa-credit-budgets.ts:111); ordinary paid admission registers run scopes.

   **Trigger/outcome:** configure a cap on project A, then start paid work in previously uncapped project B. B has valid signed project context but no registered project row, so UOA rejects it with `BUDGET_NATIVE_SCOPE_MISMATCH`, even though A’s cap does not apply.

   **Evidence/certainty:** high-confidence cross-repository source trace; no concurrency or fabricated state is required.

   **Minimal fix:** align native-project validation with the applicable project policy, retaining mandatory signed ancestry and missing-context rejection. An unrelated project policy must not impose a registration prerequisite on every project in the team.

4. **P2 — Ledger: subscription-included success cannot reach the signed zero-cost history branch.**

   [provider-dispatch-repository.ts:226](/Volumes/External/Projects/ledger/.worktrees/billing-astra-final-20261005/api/src/repositories/provider-dispatch-repository.ts:226) maps every nonbillable receipt to `not_dispatched`. However, [metering-paid-receipt-set.ts:212](/Volumes/External/Projects/ledger/.worktrees/billing-astra-final-20261005/api/src/repositories/metering-paid-receipt-set.ts:212) requires `status === "metered"` for subscription-included zero-cost evidence. The alternate nondispatch branch requires different provenance.

   **Trigger/outcome:** a permitted coding client uses a configured Kimi Code/Qwen subscription credential under a product-bound scope. Its successful zero-marginal-cost call becomes unresolved in the signed history, potentially blocking cycle completion and later finite-budget admission.

   **Evidence/certainty:** high-confidence source-confirmed state contradiction. The existing [test fixture:103](/Volumes/External/Projects/ledger/.worktrees/billing-astra-final-20261005/api/src/repositories/metering-paid-receipt-set.integration.test.ts:103) manually inserts `metered + nonbillable`, a combination the settlement function itself rejects; that fixture does not prove reachability.

   **Minimal fix:** reconcile actual dispatched-but-included state with proof classification, preserving the distinction from nonegress. Test through the production receipt writer and settlement transition.

5. **P2 — Nessie/Water/UOA: budget controls promise warnings and fallback behavior that do not execute.**

   Nessie exposes warning thresholds and “Use fallback model at the cap” in [CreditBudgetsSection.tsx:210](/Volumes/External/Projects/nessie/.worktrees/billing-astra-final-20261005/admin/src/components/features/usage/CreditBudgetsSection.tsx:210). Water offers “Warn without stopping paid work” in [BillingBudgetsPanel.tsx:125](/Volumes/External/Projects/water/.worktrees/billing-astra-final-20261005/admin/src/pages/billing/BillingBudgetsPanel.tsx:125).

   UOA stores these fields, but admission [at line 208](/Volumes/External/Projects/UnlikeOtherAuthenticator/.worktrees/billing-astra-final-20261005/API/src/services/billing-credit-budget-dispatch.service.ts:208) ignores `warn` and treats `degrade` exactly like `enforce`, returning budget exhaustion. I found no consumer implementing the advertised warning/fallback behavior.

   **Trigger/outcome:** saving these choices succeeds, but warning thresholds produce no warning, and fallback mode stops work instead of using the selected model.

   **Evidence/certainty:** high-confidence source trace and source-wide field-use searches; screenshots confirm the threshold control is displayed.

   **Minimal fix within the freeze:** remove unsupported choices and inert fields from customer controls, and handle existing saved modes truthfully. Do not introduce a new fallback or notification subsystem.

6. **P2 — Nessie: held-run reauthorization lacks enough context for an informed action.**

   [CreditBudgetsSection.tsx:258](/Volumes/External/Projects/nessie/.worktrees/billing-astra-final-20261005/admin/src/components/features/usage/CreditBudgetsSection.tsx:258) presents only a run UUID, amount, status and reauthorization button.

   **Trigger/outcome:** a person with multiple held runs cannot identify which conversation/task they are authorizing or open its context from this recovery surface.

   **Evidence/certainty:** source-confirmed and visible in the supplied mobile/desktop held-run screenshots.

   **Minimal fix:** identify the existing task/conversation and link through its existing navigation doorway. Replace “billing authority” implementation language with the concrete reason work is waiting.

7. **P3 — Water/DeepTest: cycle views label currency offsets as credits.**

   [Water BillingCyclesPanel.tsx:135](/Volumes/External/Projects/water/.worktrees/billing-astra-final-20261005/admin/src/pages/billing/BillingCyclesPanel.tsx:135) and [DeepTest BillingCyclesPanel.tsx:138](/Volumes/External/Projects/DeepTest/.worktrees/billing-astra-final-20261005/up/src/screens/BillingCyclesPanel.tsx:138) display `Credits US$-13`, alongside `Credits consumed 13000`.

   **Trigger/outcome:** an ordinary prepaid cycle uses “Credits” for two different units, making a monetary offset look like a negative credit balance.

   **Evidence/certainty:** confirmed in source and supplied rendered screenshots.

   **Minimal fix:** label the monetary offset “Paid with credits” and retain the separate credit quantity. Remove duplicate page headings and redundant single-line consumption totals; render readable UTC dates instead of raw ISO strings. These are presentation corrections, not new functionality.

**Earlier-review dispositions:** the vendored protocol trees currently match UOA; preview IDs and limit-one preview pagination have corresponding fixes; financial allocation ordering uses byte comparison; Water maps terminal renewal failures to reauthorization. Over-bound operator recovery exists, but I did not execute it. I do not uphold the earlier seat-timestamp finding based on a mock exposing uncommitted membership: it does not establish a reachable database failure.

**Unresolved question:** manual invoices are listed only in their issuance month, and another `charge_month` is rejected in [billing-customer-invoice-read.service.ts:251](/Volumes/External/Projects/UnlikeOtherAuthenticator/.worktrees/billing-astra-final-20261005/API/src/services/billing-customer-invoice-read.service.ts:251). Stripe invoices use payment-month presence. Consequently, a later-month manual payment is absent from that month’s list. This needs an explicit contract disposition against the charge-month requirement; it does not require a new historical tender workflow.

**Known completion gates remain open:**

- DeepTest’s existing credit-budget control replacement.
- InvoiceV1 `customer_credit_due` and the real producer credit-note fixture; ambiguous historical double tender must remain held.
- Gemini Live: client telemetry remains nonbillable, but [gemini-live-service.ts:81](/Volumes/External/Projects/ledger/.worktrees/billing-astra-final-20261005/api/src/services/gemini-live-service.ts:81) still contains a configured issuance path that mints provider access without UOA commercial admission. I cannot certify “disabled” from this snapshot. Close the existing disablement gate before egress; no relay architecture is required.
- Fresh follow-up review, checks and rendered-flow verification before merging.

**Proof limits:** this was source/diff/history review, inspection of existing synthetic screenshots, protocol-tree comparison and one in-memory reproduction. I did not run the reported database/API/Playwright suites, inspect deployment configuration, or establish real payment/provider behavior. The screenshots do not prove current runtime authorization, downloads, races or all desktop/mobile theme states.

| Repository | Disposition |
|---|---|
| Nessie | Blocked by project admission and misleading/incomplete budget controls. |
| UOA | Blocked by project-scope admission; invoice-month question remains. |
| Ledger | Blocked by stream settlement and receipt-history state mismatches. |
| Water | Warning control and cycle-label corrections required; depends on Ledger fixes. |
| DeepTest | Known budget completion gate and cycle-label correction remain; depends on Ledger fixes. |

**Do not proceed to final sign-off on these commits. Fix the confirmed blockers, close the known gates, then verify the integrated paths.**

