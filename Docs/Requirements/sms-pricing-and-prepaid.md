# Phone number pricing and prepaid SMS

## Current implementation — 2026-10-09

The implementation includes dynamic final mobile-number quotes, an exact-number
monthly subscription, canonical prepaid SMS reservations, one-winner dispatch,
verified receipt settlement, incoming standing funds, and operator evidence and
recovery screens. The dated checkpoints below retain the development history;
their earlier pending statements are superseded by this section.

Commercial settings have no public defaults. Deployment supplies a private
versioned policy, and each accepted quote freezes its terms. Changing deployment
settings cannot change an existing reservation's settlement. Customer responses
contain final prices only. SMS funds share the existing UOA wallet with AI usage;
insufficient funds refuse dispatch before provider activity. A receipt above its
actual segment price bound or total authorization remains in reconciliation.

Verification uses synthetic provider and Stripe evidence. Focused tests cover
private-policy validation, provider evidence, exact paid monthly admission,
frozen terms, insufficient funds, duplicate claims and debits, uncertain receipts,
per-segment bounds, shared-balance races and refund recovery. No live number,
message, payment or refund is created by these checks.

Live enablement requires the existing Stripe configuration, dedicated product
credentials, private commercial policy, accepted FX and route evidence, and the
product's independently verified destination-permission gate. The environment
gate remains off by default. This change does not provision those credentials or
claim international delivery is permitted merely because pricing is available.

## Contract checkpoint — 2026-10-08

The public TypeScript and strict JSON Schema contract lives in
`Packages/billing-statement-protocol/src/sms-types.ts` and `sms-schema.ts`.
This checkpoint freezes consumer paths and shapes; server implementation and
financial persistence verification remain in progress. No operator credentials,
provider resources, payment or live collection are provisioned by this change.

UOA owns final prices, quotes, recurring number payments and prepaid SMS. Products
render only final decimal strings and never rate provider costs. Organisation
ownership governs number subscriptions, independently of the selected team.
Each physical SMS reservation retains the assigned exact team and allocation
at dispatch; later reassignment cannot change its payer or historical receipt.
The existing organisation billing responsibility resolver determines whether
that team's consumption draws from its team or organisation credit account.

## Product integration

All paths are POST and accept the exact exported schemas. Human operations use
the product's `customer_lifecycle` app key and fresh endpoint-audienced
`X-UOA-Actor`. The ordinary subject fields are `product`, `organisation_id`,
`team_id`, and `user_id`; the selected team is actor context for an org number,
never its monthly payer. Number management independently requires current
organisation billing management authority.

| Path | Additional body | Result |
| --- | --- | --- |
| `/billing/v1/sms/quotes` | country, number_type=mobile, direction, nullable destination/carrier/mcc/mnc | exact final quote |
| `/billing/v1/sms/quotes/verify` | same scope plus quote_id | same accepted quote or refusal |
| `/billing/v1/sms/numbers/begin` | resource_id, quote_id, phone_number | number payment state and hosted Checkout URL |
| `/billing/v1/sms/numbers/status` | resource_id | exact payment/acquisition state |
| `/billing/v1/sms/numbers/end` | resource_id, reason=released or acquisition_unavailable | cancellation/recovery state |

`resource_id` is the caller's stable opaque acquisition operation identity.
Begin freezes the quote and exact E.164 number. Only verified paid subscription
evidence authorizes that resource's provider acquisition. Display quote expiry
does not invalidate already paid immutable terms. Payment cannot authorize a
different replacement number. Unavailable acquisition retains its binding and
requires explicit cancellation/refund recovery; it cannot silently orphan a
continuing charge.

Dedicated `sms_runtime` app keys authenticate provider recovery and SMS physical
dispatch operations, independently of Ledger runtime keys and AI delegation.
They share the existing app-key creation/revocation authority and never authorize
customer Checkout or top-up actions. Reserve additionally requires the fresh
credential-bound actor for the exact active user, organisation and assigned team.
No customer message body enters UOA billing.

| Path | Body |
| --- | --- |
| `/billing/v1/sms/reservations` | subject, dispatch_id, request_fingerprint, number_id, allocation_id, account_sid, from, to, quote_id, max_segments |
| `/billing/v1/sms/reservations/read` | product, dispatch_id |
| `/billing/v1/sms/reservations/claim` | product, dispatch_id, request_fingerprint |
| `/billing/v1/sms/reservations/receipt` | claim body plus message_sid |
| `/billing/v1/sms/reservations/release` | claim body plus proof=no_provider_dispatch and nullable dispatch_token |
| `/billing/v1/sms/numbers/attach` | product, resource_id, account_sid, phone_number_sid |

The backend confirms reservation and wins one dispatch claim before provider
egress. Only the winning claim receives its dispatch token; replay is recovery,
never a second send authorization. Before claim, verified no-egress may release;
after claim the exact claim token and proven no-egress are required. Provider
timeout retains funds. Receipt processing verifies the exact account, MessageSid,
sender, recipient and direction, then waits for actual complete charged price.
Failure/undelivered alone never proves zero cost. Unknown price is unresolved,
not zero. A trusted receipt exceeding the frozen hold requires reconciliation,
never an unfunded debit or automatic retry.

Reservation `number_id` is the monthly UOA `resource_id`, not a product's local
number row ID. UOA matches its attached provider account/number against `from`.
Outbound destination country is verified with Twilio's free Basic Lookup;
prefix guessing cannot authorize a country. The outbound quote's
`rate_basis=maximum_mobile_carrier` selects the conservative maximum applicable
mobile sender rate across the verified destination country's carriers, with
carrier/MCC/MNC null. Caller-selected cheap carrier hints cannot narrow admission.
Inbound/monthly bases are `inbound_mobile` and `monthly_mobile` respectively.
Provider fee completeness still requires verified route evidence before dispatch.

Inbound provider charges precede callback admission. History remains deliverable
even when funds are insufficient. A bounded standing reserve can fund documented
inbound routes; any uncovered actual liability must remain explicitly uncollected,
never called prepaid or silently post-paid. This policy and lifecycle implementation
remain part of the pending financial gate.

Inbound contracts are now declared at `/billing/v1/sms/inbound/holds` (actor
assertion; subject plus `number_id`, `allocation_id`, `reserve_credits` and
`idempotency_key`). Only existing canonical wallet credits can fund this consent.
Machine reads and retirement use `/inbound/holds/read` and `/inbound/holds/retire`
with `product`, `number_id` and `allocation_id`. Retirement stops new funding
authority; it does not silently release funds needed by delayed provider receipts.
`/billing/v1/sms/inbound/receipts` accepts that frozen binding plus `message_sid`;
UOA retrieves provider evidence. Its public result distinguishes pending, funded,
uncollected and reconciliation, with final customer credits only. Product callback
history remains intact regardless of financial outcome. Server handlers are pending.

## Provider and FX evidence

Verified on 2026-10-08 against official documentation:

- [Messaging Pricing API](https://www.twilio.com/docs/messaging/api/pricing):
  account-specific country prices, outbound carrier/MCC/MNC and mobile sender
  rates, inbound rates by receiver type; current price can be absent.
- [Phone number Pricing API](https://www.twilio.com/docs/phone-numbers/pricing):
  account-specific country/mobile current price and currency.
- [Message resource](https://www.twilio.com/docs/messaging/api/message-resource):
  immutable account/message binding, segment count and delayed price fields.
- [Message and carrier fees](https://help.twilio.com/articles/46871410243099-Understanding-SMS-Message-Fees-Carrier-Fees-and-Phone-Number-Fees):
  final message price includes applicable carrier fees.
- [Failed processing fees](https://help.twilio.com/articles/27502337507483):
  failed messages can still incur a processing charge.

The canonical credits conversion remains 1,000 credits per US dollar. Currency
conversion must use a UOA-owned immutable dated policy/rate with source provenance
and expiry. No implicit 1:1 conversion or product-supplied exchange rate is allowed.
An actionable validated rate refresh/import path is required before closure.

The private provider evidence adapter now reads only fixed official HTTPS endpoints,
refuses redirects and mismatched resource/country identities, and retains exact
decimal strings. Basic Lookup establishes the destination country without requesting
paid enrichment. Outbound evidence selects the maximum applicable mobile carrier
rate; this alone does not establish completeness of additional carrier charges.
Reservation admission must separately prove a complete conservative bound. A final
failed receipt with absent price remains unpriced, never a zero-cost settlement.
Adapter and protocol focused tests are authored; the remote gate is pending.

The FX evidence parser accepts only a single dated USD-per-EUR record from the
fixed ECB daily XML source, rejects entities and stale/future dates, and binds a
content hash. Refreshing the same source cannot extend its seven-day maximum
validity. ECB rates are informational reference rates, not executable bank FX;
using this commercial reference conversion requires explicit operator policy
acceptance. Persistence, operator acceptance and reachable refresh remain pending.
Private rating uses rational integer arithmetic and rounds once at the requested
quantum, including the monthly Stripe cent quantum and SMS microcredit quantum.

Schema preparation declares immutable FX/quote evidence, exact number resources,
allocation-bound outbound reservations, inbound standing holds and receipt liability.
All holds reference the existing canonical `BillingCreditAccount`; no alternate
balance is introduced. The schema checkpoint is not deployment-ready until its
bounded migration, forced RLS, provenance/transition guards and shared availability
queries land together. Runtime endpoints and collection remain pending.

The prepared migration now forces RLS on all SMS financial tables, restricts
external references, makes quote/FX evidence immutable and serializes AI/SMS hold
admission through the same credit-account row lock. The database balance guard and
availability projection include outbound uncertain/reconciliation funds and retired
inbound standing funds. These changes still need isolated migration/race tests;
SMS debit provenance and public runtime handlers remain pending.

Number end uses the purpose-bound machine credential with `product`, `resource_id`
and `reason`. UOA must verify provider absence in the original account before
release cancellation; acquisition-unavailable recovery retains the exact paid
resource. Recovery does not depend on an expired actor assertion. An unpaid open
Checkout remains `payment_required` with a reusable URL; `payment_pending` is
reserved for processing or unconfirmed outcome, not merely an opened browser.

Agent dispatch uses an explicit actor-created grant at `/billing/v1/sms/grants`:
subject, number/allocation/delegate IDs, maximum segments and idempotency key. This
is billing delegation for the existing responsible-agent consent, not an agent
identity. Machine `/grants/read` and `/grants/revoke` take product/grant ID;
`/grants/quotes` additionally takes verified destination country and E.164.
Reserve now requires nullable `grant_id` and `delegate_id`: both null for a fresh
human actor, both exact for machine delegation. Every machine quote/reserve/claim
rechecks live original actor epoch, membership, grant revocation and allocation,
plus canonical credits/budgets. The product revokes on agent/grant/allocation/number
changes; old receipts remain bound to their original financial reservation.

Prepared service code verifies exact endpoint audiences for new SMS actor requests
even while legacy billing runs in warning mode. It reacquires canonical global
authentication epoch, active app-key/service and exact org/team membership locks.
Quote service stores immutable provider/FX evidence and projects only final USD
price, scope and expiry. `sms_runtime` is a separate app-key purpose with no redirect
origins; operator issuance API accepts it. Operator UI and HTTP handlers are still
pending, so these services are not yet a reachable production capability.

Quote and verify HTTP routes are now registered and described in `/api` and `/llm`.
They use strict shared request/response schemas and no-store responses. Until an
operator accepts a fresh FX snapshot they return the explicit policy-required
reason. `BILLING_SMS_ENABLED` defaults false; read-only private Twilio evidence
requires `BILLING_SMS_TWILIO_ACCOUNT_SID`, `BILLING_SMS_TWILIO_API_KEY_SID` and
`BILLING_SMS_TWILIO_API_KEY_SECRET` in the API secret environment. These are not
Twilio webhook-signature credentials and are never sent to a browser. Provision
them through the existing Cloud Run Secret Manager environment workflow; no secret
contents belong in Git. Monthly collection independently requires the existing
verified Stripe gate. Neither credential presence nor Checkout creation is payment.

Official Message resource read fixtures include non-null price with `sent` status;
priced sent evidence can therefore settle routes without delivery receipts.
Delivery failure still may carry a charge. Later conflicting price evidence must
enter explicit reconciliation rather than silently replacing an already-settled
receipt or repeating a debit. Missing price remains held regardless of status.

### Machine recovery and prepaid refusal contract

POST /billing/v1/sms/numbers/runtime-status uses the SMS_RUNTIME key with product and resource_id. An exact product-scoped missing resource is 404; visibility-masked human status is not absence proof. Resources are persisted before Checkout effects and cannot be deleted. HTTP 402 insufficient prepaid funds has the exact public body code BILLING_SMS_INSUFFICIENT_CREDITS, reason insufficient_prepaid_credits, can_dispatch false. Funding permission is independently resolved by existing customer funding authority; this refusal does not grant it.

Standing hold replenishment adds the explicitly requested credits to the same active allocation pool once per idempotency key; a repeated key returns its recorded result without adding funds. Retired pools cannot receive replenishment. Implementation and database validation remain pending at this checkpoint.

### Reachable SMS operator policy workflow — 2026-10-08

Current platform administrators open **Admin → Billing → SMS policies** for the
private evidence controls. Refresh ECB evidence fetches only the fixed official
daily XML without redirects; the expandable import control accepts that source's
current daily XML. The review shows source, complete-document SHA-256, rate date,
observed time, exact USD-per-EUR decimal and source-date expiry. Operators must
explicitly adopt the informational reference rate for commercial conversion and
record an 8–500 character reason. The original source-date seven-day validity
cannot be extended by refresh, import or retry.

The structured route evidence form requires an exact Twilio account SID, country,
direction and provider currency, both additional per-segment and per-message
bounds, a source reference, documentary terms and a source-supported expiry.
Review shows the original text, every dimension, bound and server-computed
complete-import digest. Separate acceptance checkboxes cover carrier/segment
charges and processing/failure/message charges. Missing fee evidence never
establishes zero; explicitly documented zero is an operator responsibility.
Keep the original document in the operator evidence archive so its digest can
be independently checked. The stored source/digest/subject/time/reason is immutable.

Preview capabilities last five minutes and bind the exact operator, credential
epoch, policy kind and evidence. Acceptance rechecks ACTIVE platform authority
after canonical session and billing authority locks and refuses a review or
policy that expires while waiting. Exact retries return the original acceptance
without rewriting its provenance or freshness. Responses use private/no-store.
History shows the latest 50 currency and 100 route acceptances. These controls
do not enable the SMS environment gate or install provider/payment credentials.

Under **Product billing → selected product → App keys**, operators can issue an
**SMS runtime** key through the existing one-time credential reveal and revocation
workflow. It uses the dedicated `sms_runtime` purpose, refuses redirect origins,
and remains separate from entitlement, customer lifecycle and Ledger runtime
keys. Install it only through the approved deployment secret store. Issuance is
not installation, provider provisioning or permission to perform a live charge.

**Number payment recovery** on the SMS page provides paged outstanding resources
and exact-resource lookup. Its detail shows the immutable final customer quote,
original organisation/provider binding, and available Stripe account/mode,
subscription and paid initial-invoice references. Existing contract-invoice
manual refund adjustments do not cover these SMS add-ons. The initial operator
read never creates a refund or claims completion; an unavailable paid resource
remains explicitly `refund_required`. Use the authorized Stripe operator workflow
and preserve verified evidence until the corresponding reconciliation capability
is deployed. Unknown references remain unavailable, never presumed zero.

### Existing refund verification and SMS liability recovery

The operator recovery detail now has a separate **Verify existing Stripe refund**
form when the exact resource is `refund_required` and original paid references
are available. This completes the reconciliation capability described above:
issue any refund in the authorized Stripe operator workflow first, then select
the original subscription and enter its existing refund IDs. The UOA action
does not create refunds or cancel subscriptions. It proves the configured Stripe
account/mode, exact resource/org/offer/subscription/customer/currency, paid initial
invoice, actual cash payment and charge set, canceled remote subscription, and
complete succeeded refunds with source-bound negative balance movement. Partial,
pending, foreign, duplicate or conflicting evidence cannot complete recovery.
Any additional nonzero paid or collectible invoice, a missing initial invoice
in the inventory, or an incomplete invoice page also blocks this completion:
the original refund alone cannot settle unreviewed renewals. These cases require
separate explicit reconciliation; no new payment/refund subsystem is inferred.

The acceptance transaction reacquires canonical operator session/epoch and
billing authority locks, then the runtime's exact resource advisory and row
locks. It rechecks original bindings and `refund_required` before persisting
the immutable refund evidence digest/source time and administrator audit.
Only that verified transition sets the resource to `ended`. Exact proof replay
returns original completion without another write or audit. Raw provider costs
and the private commercial formula remain absent from this surface.

**SMS dispatch and inbound recovery** separately lists inbound pending/uncollected/
reconciliation receipts and outbound dispatching/uncertain/reconciliation holds.
Expand a row for original number/allocation/org/team, provider account, MessageSid
or dispatch identity, and final customer credits. Unknown credits remain visibly
unknown; funded zero remains zero. Bounded pages have an older-record cursor.
This review does not release holds, waive liability, charge an unfunded wallet
or authorize a resend. Original receipt recovery uses the approved product runtime
workflow; above-bound resolution remains a separate explicit financial decision.
Evidence shapes follow official
[refund retrieval](https://docs.stripe.com/api/refunds/retrieve) and
[balance transaction](https://docs.stripe.com/api/balance_transactions/object)
contracts. No live financial/provider action is part of development verification.

### Financial schema preparation — next checkpoint

Dispatch grants bind exact actor epoch, team, resource, allocation and delegate. Route fee policies are immutable operator-accepted private evidence bound to provider account, country, direction and currency, with separate per-segment and per-message bounds. SMS credit entries have dedicated reservation or inbound receipt provenance, sharing the canonical wallet. These newly declared fields require their dedicated migration and transaction tests before deployment; handlers are not complete.

SMS funded debits reuse the frozen customer statement usage_settlement kind and its seven-locale verified-usage copy. The new internal provenance kind is not added to the public statement enum.

### Exact-number monthly lifecycle checkpoint

The registered monthly begin/status/runtime-status/attach/end handlers reuse recurring add-on Stripe catalog, hosted Checkout and verified initial invoice evidence. Offers are resource-bound organisation subscriptions, excluded from generic shared add-on storefront listings. Pinned paid terms survive display expiry; unavailable paid acquisition is canceled with refund_required rather than silently claiming a refund. Before-begin cancellation is an immutable tombstone under the same resource lock, and missing end returns only resource_id/state ended/acquisition_authorized false. Existing Checkout creation is fenced by a locked number state; uncertain creation cannot be reported ended.

Provider evidence was checked on 2026-10-08 against https://www.twilio.com/docs/phone-numbers/api/availablephonenumber-mobile-resource and https://www.twilio.com/docs/phone-numbers/api/incomingphonenumber-resource. Hosted URL fragments are preserved under the fixed HTTPS Stripe Checkout host. Cancellation/expiry evidence: https://docs.stripe.com/api/subscriptions/cancel and https://docs.stripe.com/api/checkout/sessions/expire. Database migration, monthly service race tests and compile closure are required before this checkpoint is deployable.

Runtime status absence is only the strict 404 body {code:BILLING_SMS_RESOURCE_NOT_FOUND,resource_id}. A proxy/router/authentication 404 is not resource absence. Even verified absence does not fence concurrent begin; explicit machine end cancellation proof is required.

### Recovery financial provenance

Missing dispatch cancellation is fingerprint-bound; missing grant revocation is bound to the deterministic consent operation ID. Both use durable append-only tombstones so a delayed admission cannot create orphan authority after retirement. Standing replenishment has its own immutable idempotency records. The monthly refund recovery projection records only verified refund evidence digest and completion time, never a manually asserted success. These schema preparations still require migration and tests.

### Financial runtime implementation checkpoint (2026-10-08)

The registered reservation, one-winner dispatch claim, receipt settlement, grant
and inbound handlers now use the canonical credit account, budget dispatch and
paid-usage liability services. Customer SMS quotes are maxima per segment,
including accepted route-bound additional per-segment and per-message evidence.
The per-message bound is conservatively reserved once for every segment; actual
settlement uses only verified total provider charge, never that maximum.
Evidence above the accepted hold remains in reconciliation without a larger debit.

Inbound machine requests include frozen organisation_id and team_id. Existing
standing funds must match that original allocation exactly. Without a standing
fund, active canonical hierarchy is checked and the charge is recorded as
uncollected liability; received messages are never discarded and no wallet is
overdrafted. Late receipts use funding terms accepted before provider creation;
second-precision creation overlapping retirement is refused as ambiguous.
Retirement retains funds for earlier unknown usage. Missing retirement writes an
immutable allocation tombstone and returns number_id/allocation_id/state retired/
can_fund false, fencing delayed funding. These contracts are machine recovery
proofs, not generic HTTP-404 assumptions.

Grant revoke and dispatch release may return their strict minimal tombstone
proofs. Receipt and funding mutations are durable and idempotent. The new SQL
migrations enforce shared holds, immutable financial identities, runtime-key debit
provenance and terminal wallet-entry coherence. This checkpoint still requires
fresh compile, migrated-database and race verification before deployment.

Fresh financial database verification exposed the standing app-key purpose/origin check. A dedicated migration permits SMS_RUNTIME only with no Checkout return origins; CUSTOMER_LIFECYCLE still requires its explicit approved return origin. Other purposes retain their existing constraints.

SMS final maximum quotes round upward only to the established USD-per-microcredit wallet quantum. Private provider evidence retains exact precision. Outbound receipt creation must not precede the persisted one-winner physical claim second; inbound must not predate the exact number resource. Initial grant and standing funding repeat live manager checks under final admission locks, and incoming budget exhaustion is durable uncollected liability rather than an invisible rollback.

Financial database tests exercise PostgreSQL advisory locks through Prisma's supported text result and combine resource advisory locking with row locks. Final reserve, claim and standing-fund admission take the exact number row lock so a concurrent release after a serializable snapshot forces retry rather than admitting stale active state.

The outgoing financial service fixture exercises canonical fresh signed actor admission, one-winner claim, exact cash-backed monthly projection, actual provider receipt debit/replay, held unknown/above-bound outcomes, historical receipt rejection, ordinary-member grant refusal and verified provider release before monthly cancellation. Fixture providers and Stripe evidence are injected; no live charges are generated.

### Private deployment policy and accepted terms

SMS commercial settings are supplied only through the private deployment
configuration: `UOA_SMS_COMMERCIAL_POLICY_VERSION`, `UOA_SMS_MONTHLY_FEE_EUR`
and `UOA_SMS_MESSAGE_MARKUP_BPS`. None has a default. Missing or malformed
configuration refuses quotation; it never supplies sample commercial terms.
Each quote stores an immutable private policy version, monthly increment and
message rating basis. Reservation and settlement use that accepted snapshot,
including after deployment configuration changes. Public projections expose
only final customer prices. Tests use unrelated synthetic policy values.
