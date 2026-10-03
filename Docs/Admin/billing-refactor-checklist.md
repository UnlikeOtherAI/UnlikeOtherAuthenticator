# Billing UI refactor — capability and verification checklist

The approved October 2026 admin decluttering work replaces selection-only dropdowns with linked lists and addressable details. It retains the existing billing API, immutable commercial records and server-projected action eligibility. This is the explicit navigation update to the earlier template-preservation baseline; it does not change the product billing architecture.

## Navigation contract

- `/billing` lists products, with URL search `q` and `products_page` pagination.
- `?product=<id>&tab=tariffs|assignments|adjustments|app-keys|subscriptions` opens a product and its section.
- `record=<id>` opens the selected product's tariff, assignment, adjustment, masked key metadata or subscription. Detail links remain ordinary anchors, including keyboard and new-tab behavior. Switching sections clears the selected record.
- `?section=contracts` lists contracts and invoices. `organisation=<id>` filters both, resetting contract/invoice selection and pagination.
- `contract=<id>` opens exact contract terms and its invoice history. Its calculator submits that contract, never the first unrelated active contract.
- `invoice=<id>` opens the existing invoice lifecycle detail. A direct reload restores the selection. Unknown records show an explicit unavailable state instead of silently selecting another entity.
- `contracts_page` and `invoices_page` keep independent list positions. Related organisation/team links use the canonical directory routes.

No new App route registration is required. All these URLs remain under the existing authenticated `/billing` route and router basename.

## Before / after capability inventory

| Capability | Before | After / preservation check |
| --- | --- | --- |
| Product creation | Safe at-cost/no-collection initial tariff | Same schema, defaults, mutation and form; pending close guard and failed-save retry |
| Product selection | First product selected, dropdown only | Linked product list; stable URL, unavailable state, search and pagination |
| Immutable tariff versions | Create, inspect, set default | All retained; dedicated detail link; exact formatted monthly money; fallback/pinned-subscription confirmation retained |
| Organisation/team assignment | Create and remove overrides | All retained; related entity links; inspect provenance; removal confirmation retained |
| Add-ons and credits | Create and deactivate commercial lines | All retained; scope links, exact amount display, effective dates and historical-preservation confirmation |
| Product app keys | Create, reveal once, inspect list, revoke | All retained; one-time plaintext remains only in reveal dialog, metadata detail never displays plaintext; expiry/revocation status retained |
| Stripe subscriptions | Read status/account/mode and current period | Same projection retained, named tariff link and detail including period start, cancellation and account identity |
| Stripe configuration | No operator enablement mutation in this UI | None introduced; collection and test/live distinctions preserved; no gate inferred from a tariff |
| Contract creation | Create explicit organisation contract | Same dialog, schema and API |
| Contract terms | Append immutable versions | Same forward-effective version form; visible reference/status/version terms |
| Contract activation | Select exact service set and minor prices, confirm | Same service choices, confirmation invalidation, server readiness and activation mutation |
| Issuer / buyer | Explicit issuer creation and buyer read/upsert | Same forms, required legal fields, loading/error protection; no seeded or inferred issuer |
| Invoice calculation | Could silently target first active contract | Bound to opened active contract; issuer/month fields retained, closed UTC month max, failure retains inputs |
| Invoice history | View button, local-only selection | Real invoice links with URL selection, contract/org filters and independent pagination |
| Issue / resume | Confirm then issue/resume immutable PDF | Same server-supplied eligibility and legal consequence confirmation; pending guard |
| Download PDF | Verified private PDF request | Same service call, filename and error handling |
| Payment / refund / write-off | Exact positive minor amount, projected cap, idempotency | Same checks and inputs; failed requests preserve the same idempotency key and values for retry |
| Void | Server eligibility plus reason | Same mutation and reason, pending lock; settled/void invoices remain server-controlled |
| Invoice confidentiality | Customer-price-only lines and totals | Same DTO/schema; no provider costs, token quantities, markup or private Ledger evidence added |

## Justification of retained interface elements

- Product and contract rows identify records and show their operational state. Detail links replace the implicit first-record selection.
- Tabs separate distinct operations. Only the currently relevant creation action appears in the product header.
- The precedence sentence explains the effect of tariff overrides; destructive confirmations explain the actual consequence.
- IDs/prefixes, actor audience, Stripe mode/account and effective times remain in detail because operators need them to distinguish scopes and deployments.
- Invoice statuses, exact totals, legal parties, version references and settlement activity remain because they affect money actions and auditability.
- Architecture banners, duplicate top-level counts and the “Customer-safe output” badge were removed. Safety explanations around immutable records, one-time credentials and action consequences remain.

## Verification

Focused Vitest coverage includes:

- product list → detail → tab → browser Back → list; persisted URL tab and metadata deep link;
- canonical organisation/team links and only relevant section actions;
- exact money beyond JavaScript's safe integer range and 0/2/3 currency exponents matching the API;
- opened second contract used for calculation, not the first active contract; failed calculation can retry without leaving the view;
- invoice issue/resume capability, payment caps, absent refund eligibility and void eligibility;
- failed payment retry preserves amount and idempotency key;
- immutable activation requires exact prices and confirmation; editing invalidates the confirmation;
- buyer lookup failure disables saving and offers retry;
- transport/schema tests keep all real billing request payloads and response validation.

The focused suite and Admin typecheck/lint are run in the dedicated Windows billing worktree. No production monetary mutation, Stripe call, PDF issuance, live contract activation or database migration is performed by this refactor. Real rendered desktop/mobile checks and the integrated full suite belong to the orchestrator's final verification; unit/component evidence does not claim those checks passed.
