# Paid usage exception reconciliation

A provider can report a real cost above the maximum Ledger proved before a paid
dispatch. The normal UOA settlement refuses that receipt and keeps the original
wallet and credit-budget holds. It must not silently charge above the bound or
release a spent provider call as if its cost were zero.

Ledger records the selected immutable receipt through its exact product-bound
RuntimeKey at `POST /billing/v1/ledger/reservations/:dispatchId/exception`.
The request carries `receipt_id`, `raw_cost_actual` (USD decimal, at most 18
places), `currency: "USD"`, `source: "ledger_selected_provider_receipt"` and
`evidence_digest`. The digest is lowercase SHA-256 over UTF-8 compact JSON of
`[dispatchId,receiptId,rawActualFixed18,"USD",requestFingerprint,
rawBoundFixed18,contextDigest]`. UOA recomputes the digest from its frozen
admission and refuses a missing bound, incomplete historical authority,
product-key mismatch, non-overbound actual, or changed evidence. Exact retries
return the same held or terminal result; a conflicting receipt remains held.

The platform operator's home is Admin Billing → Usage exceptions. It shows
the oldest 100 held receipts, selected receipt IDs, observed provider cost,
original cost bound, and maximum authorized customer credits. The operator
records a reason and submits the exact evidence digest with a stable
idempotency key. The endpoint requires a current platform-superuser token
issued within five minutes, then rechecks the user's live credential epoch
and role under transaction locks. Under the same serializable transaction,
UOA books the frozen lifetime-rated gross liability, collects at most the
original reserved microcredits, records the waived excess and operator audit,
updates the PREPAID wallet when applicable, and closes the budget hold as
gross spent usage. The waiver is not a refund or a second usage purchase.
Ledger reads the terminal `WRITTEN_OFF` result with its original RuntimeKey
before it can mark the exact selected receipt commercially settled.

An unknown provider actual, a pre-cutover PAYG attempt without frozen
commercial terms, or a later selected receipt correction does not qualify for
this decision. Such attempts stay held and prevent a complete signed monthly
paid-receipt set until trusted evidence and an explicit reconciliation path
exist. Customer statements and documents must show UOA-authored gross usage
and waiver adjustments without provider cost, markup or duplicate PREPAID
cash charges.
