# Billing review register — 2026-10-04

The retained [Kimix report](billing-kimix-2026-10-04.md) reviewed a frozen
five-repository cohort. Its findings are source-level; the fixes below have
separate executable evidence. Final review is pending integration of the
remaining consumer and tender-reconciliation work.

| Finding | Disposition |
| --- | --- |
| D1: same-version schema drift | Canonical UOA whole-package SHA pinned in all consumers; real PostgreSQL-issued finalized cycle exports cover zero tax, explicit VAT, and mixed-product private PDF withholding. Final positive credit/tax consumer checks remain a delivery gate. |
| D2: preview ID refused | All consumer ID validators accept the canonical preview grammar; focused regressions pass. |
| D3: held settlement dead end | Fresh-authorized financial operator doorway resolves proven, bounded paid evidence. Unknown paid usage remains held; it is never counted as zero or silently released. |
| D4: auto-recharge currency | Attempt currency is immutable source evidence; source/webhook/credit entry mismatch holds. USD-only offers remain explicit. |
| D5: deferred seat time | Finding rejected: uncommitted membership does not grant/remove visible membership. Database commit observation is the correct seat boundary. Persistence tests cover external visibility, rollback, same-transaction join/leave, and lock-wait clocks. |
| D6: locale-dependent finance | Financial tie allocation and digest ordering use binary UTF-8 consistently with database C ordering. |
| D7: Water revoked grant retries | Terminal authority refusal ends the job; it cannot hot-loop into new paid attempts. |
| D8: preview cursor skips org row | Preview pagination preserves both same-month payer scopes; regression passes. |

Additional review questions have explicit dispositions: an active organisation
CUSTOM contract outranks subsequent generic tariffs; FULL_MONTH charges any
positive entitled presence within the effective commercial interval; customer
statements use fresh exact product/payer bindings rather than removed v1 fields.
Signed complete paid histories have no silent page cutoff. Provider paid facts
are immutable and nonnegative, so a mocked downward provider-cost correction is
not a reachable billing writer.

Current gates:

- Preserve native financial origins when a person deletes content.
- Preserve original credit-budget ancestry through resumptions and delegated
  work; no paid egress before durable, freshly authorized admission.
- Complete reachable per-payment invoice flows and credit budget controls in
  Nessie, Deepwater and DeepTest, with headless responsive proof.
- Prevent wallet debits for receipts already represented by manual invoices;
  reconcile historical double tender without rewriting the legal invoice.
- Freeze the shared public schema only after every consumer accepts actual
  producer exports and refuses cross-product/scope/action substitution.
- Fresh Astra review of the fully integrated five-repository result, followed
  by required checks and the repositories' normal green-PR workflow.

Gemini Live currently remains commercially held: device-reported telemetry
cannot prove billable provider usage or authorize enforced credit exhaustion.
Changing the documented direct device/provider architecture requires the
pending explicit architecture decision; no unverified usage is billed.

Executable evidence uses isolated PostgreSQL databases and synthetic provider
and payment transports. It proves arithmetic, durable source/lease behavior and
rendered customer flows. It does not claim real paid-provider calls, real Stripe
payments, production financial writes or deployment of the follow-up tranche.
