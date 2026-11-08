export const llmBillingHistoryMarkdown = `### Actual customer charge invoices
Use the product's customer_lifecycle app key and a fresh exact-endpoint
X-UOA-Actor assertion for POST /billing/v1/invoices/list, /detail, and
/download. List by charge_month in UTC, then use only UOA's opaque invoice
and document IDs. A prepaid purchase or automatic recharge appears in the month
of Stripe's accepted payment event even if legal issue finishes later. Pending
documents have verified payment and purchased credits but no invented tax,
invoice number or download. An organisation invoice or pool purchase requires
current organisation billing-manager authority, including an active admin/owner
of any active same-org team. Every history request spans all products/teams and
selects one captured account/mode. Old non-null request subjects retain their
strict wire shape and default to the current named org mode; the selected team
only admits the actor. The explicit organisation financial family additionally
selects historical mode and permits the narrow null financial subject; see the organisation billing
section and its 6.3 schemas. Legal PDFs list charges and tax, not private usage
units, provider cost or markup. The strict contract and synthetic examples are
at /schemas/billing-customer-invoices-v1.json and its example and OpenAPI
siblings. Refund and dispute effects are shown separately from
the original immutable legal PDF.

Organisation invoice LIST returns409
\`BILLING_ADDON_HISTORY_RECONCILIATION_REQUIRED\` while an original captured
add-on invoice source in the requested org/account/mode is incomplete. Preserve
already confirmed history and offer an explicit read-only refresh. This is not
an empty list or a stale displayed-action context; never retry a money mutation.
Already confirmed invoice DETAIL/PDF remains independently accessible.

### Monthly billing cycles and documents

The canonical BillingCyclesV2 contract is published at
\`/schemas/billing-cycles-v2.json\`, \`/schemas/billing-cycles-v2.example.json\`, and
\`/schemas/billing-cycles-v2.openapi.json\`. A product's billing page calls
\`POST /billing/v1/cycles/list\` and \`/detail\` with its exact lifecycle app key,
fresh endpoint-audience actor assertion, and product/organisation/team/user body.
The caller must be a current organisation billing manager, including an active
admin/owner of any active same-org team. The selected team is actor context;
captured cycle/payer scope stays visible on the original financial source.
Every request is a narrow financial-only exception across products/teams,
bound to one account/mode, and grants no general content access. Every list cursor is
opaque and account-bound; never construct or reuse one from the old team view.
The detail contains customer seat charges, consumed credits,
and persisted invoice/breakdown metadata, never provider cost or markup.
The current accrued bill belongs to the independent overview; history does not
invent an empty preview as today's bill. Only a document's server-authored
\`download_action\` may be relayed to \`POST /billing/v1/cycles/download\`; UOA
rechecks the same authority and streams immutable SHA-verified bytes. Products
must not build a storage URL or invoice ID locally.

Products render the supplied labels, descriptions, totals, shares, and actions
unchanged. They never derive totals, private price terms, direct access, cancellation
choices, or a missing-origin remainder. A Nessie-originated DeepWater call therefore
appears in Nessie’s DeepWater origin share but remains indirect access and cannot
create a related cancellation choice. A null legacy origin renders as
\`Unattributed origin\` and likewise creates no service, access, or choice.

The same package freezes the full product-facing action protocol. Its exact
Draft 2020-12 schema bundle, synthetic fixtures, and OpenAPI 3.1 components are
served at \`/schemas/billing-consumer-actions-v1.json\`,
\`/schemas/billing-consumer-actions-v1.example.json\`, and
\`/schemas/billing-consumer-actions-v1.openapi.json\`. They cover the normalized
hosted redirect, cancellation selection, preview (including the fixed
\`POST /billing/v1/cancellation/confirm\` action), confirm request/response, and
minimal error envelope. Every message object rejects unknown properties.

Action IDs and paths are fixed: \`upgrade\` →
\`/billing/v1/stripe/checkout-session\`, \`portal\` →
\`/billing/v1/stripe/portal-session\`, and \`cancel\` →
\`/billing/v1/cancellation/preview\`. The action body contains the exact subject and
server-pinned allowlisted return URLs. Product backends whitelist the ID/path pair and
proxy the body; browser code receives neither UOA app key nor actor JWT.

Direct access comes only from the explicit direct-session call (or another authenticated
first-party billing call) made with that exact product app key. A Ledger caller/origin
product is indirect and cannot create a direct entitlement.
Cancellation preview returns all dialog copy, affected direct services, explanatory
indirect services, an opaque five-minute token, and a server-generated idempotency key.
It offers a related-direct-products choice only when the team has another same-account
direct subscription. Confirmation uses \`POST /billing/v1/cancellation/confirm\` and
revalidates the pinned subscriptions under lock. The matching idempotency key may
resume/replay; the old one-step cancel route does not exist.

Platform superusers create exact organisation/team one-time or monthly add-ons and
credits in UOA Admin. Values are integer minor-currency strings, audited, and
deactivated rather than deleted. Ledger never receives them.

### Shared team credits and recurring add-ons

\`POST /billing/v1/credits\` and both customer-statement versions are superseded
team aggregate reads. They authenticate current financial authority, then return
409 \`BILLING_ORGANISATION_OVERVIEW_REQUIRED\` without metering or settlement.
Keep the session and use the independent organisation overview. Their old strict
schemas remain published; no team aggregate is relabelled as an org bill.
Current ACTIVE organisation billing managers receive financial reads. Ordinary
members cannot read credits, statements, cycles, invoices or purchase status;
the old member-shaped DTO does not grant access. Members can still explicitly
POST the separate selected-team nonfinancial Ask for credits action without a
preceding wallet read. New consumers use the independent organisation overview.

The retained legacy credit engine pins one exact user-grouped Ledger portfolio cursor for
the team and settles every service in that snapshot together under a serializable team
credit-account lock. Replay is idempotent. Corrections release prior allocations before
reallocating them deterministically. Available credits never cross below zero from new
usage, but the full centrally rated service/user liability remains recorded; only a
verified reversal can create a debt balance. Products never rate, debit, aggregate, or
reallocate shared credits locally.

The exact response schema, synthetic fixture, and OpenAPI 3.1 artifact are public at
\`/schemas/billing-credits-v1.json\`, \`/schemas/billing-credits-v1.example.json\`, and
\`/schemas/billing-credits-v1.openapi.json\`.

Billing-manager mutation actions in that projection are live only when UOA has the
active exact service policy, fixed offer/option, matching active Stripe-account catalog,
and required consent/payment evidence. Products relay the complete action body unchanged:
\`/billing/v1/credits/top-up-checkout\`, \`/billing/v1/credits/auto-top-up/setup\`,
\`/update\`, \`/disable\`, and \`/recover\`. These routes require the product's exact
customer-lifecycle app key, a fresh actor assertion, and current ACTIVE organisation/team
billing-manager membership. A caller can identify only the UOA offer or option shown in
the projection; it cannot supply an amount, Stripe Price, currency, quantity, customer,
metadata, PaymentIntent, or return/recovery URL. UOA writes the immutable local intent
before Stripe, derives account/mode-scoped idempotency, and accepts webhook completion
only when Stripe metadata and stored subject/catalog/customer evidence match exactly.
Checkout responses contain one verified HTTPS \`redirect_url\`; update and disable return
\`204\`. Missing or drifted policy, catalog, consent, payment, or Stripe evidence fails
closed and keeps the matching action disabled in later projections.

\`POST /billing/v1/recurring-addons\` returns UOA-owned offers and exact
organisation/team/subscribing-user subscription projections for that product. Manager
views may contain subscription identity; member views expose only the viewer's
relationship to a subscription and never another user's identity or payment details.
Enabled manager actions relay their frozen UOA body to
\`/billing/v1/recurring-addons/checkout\` or
\`/billing/v1/recurring-addons/cancellation/preview\`. Checkout is one exact licensed
monthly Stripe item with server-derived price, customer, return URLs, and idempotency.
Checkout completion does not activate the entitlement: UOA requires an exact paid,
undiscounted initial invoice. A preview returns an opaque five-minute token and UOA
idempotency key; \`/billing/v1/recurring-addons/cancellation/confirm\` rechecks the actor
and subscription, schedules period-end cancellation, and replays the stored exact result.
The matching public artifacts use the \`billing-recurring-addons-v1\` filenames under
\`/schemas\`. Recurring add-ons, including DeepWater privacy, remain separate from shared
credits and from usage rating.

### Organisation-wide billing

An organisation can take billing over from all of its teams, across every service:
\`POST /billing/v1/organisation-billing/assume\`, \`.../release\`, and a read at
\`POST /billing/v1/organisation-billing\`. All three take the ordinary subject body, the
product's \`customer_lifecycle\` app key and a fresh actor assertion, and additionally
require an **organisation** billing manager — a verdict UOA makes itself and never accepts
from a product.

While it is on, \`resolveCreditAccount\` returns the organisation's credit account for
every team, so all metered spend lands on one balance with no change anywhere in Ledger
or in a product. The statement and the credits view then carry a \`controlled_by\` block
(protocol 1.3.0) whose \`message\` is display-ready and whose \`can_manage\` is UOA's
verdict about the exact caller. **Render \`message\` verbatim and offer only the action
UOA names.** A caller who cannot manage receives an empty action list and no funding
controls at all, so a product still vendoring 1.2.0 renders a read-only surface rather
than buttons that would 403. An organisation billing manager additionally receives
\`organisation_scope\` on the v2 statement: every team, each rated from its own pinned
\`metering-portfolio-v1\` snapshot, with organisation totals that are the sum of the team
totals. It sits beside the requested team's own fields, never in place of them.

Assuming is refused whole — never partially applied — while any team funding action is in
flight (\`FUNDING_ACTION_IN_FLIGHT\`, listing the exact rows) or while a live team-scoped
Stripe subscription exists (\`TEAM_SUBSCRIPTIONS_ACTIVE\`, listing them). Auto-migrating a
subscription would re-bill a customer without a decision, so an operator moves or ends it
first. Each team's stored automatic top-up consent is deactivated — never deleted — with
an audit row, and team credit balances are never swept: they remain the team's and are
reachable again on release. Releasing reverses credit resolution only; organisation-scoped
ledger rows, invoices and statements stay where the spend was incurred.

`;
