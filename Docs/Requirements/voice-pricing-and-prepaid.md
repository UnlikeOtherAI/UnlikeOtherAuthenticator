# Prepaid telephone call legs

## Delivery status

Voice v1 adds a separate call-leg protocol over the canonical wallet and budgets.
Implementation and synthetic verification are in progress. Live admission is disabled
by default. No provider/account mutations or real calls are part of development.
This is machine-only UOA infrastructure; Nessie owns grants' customer controls and call history.

## Contract

The strict types and JSON schemas are `packages/billing-statement-protocol/src/voice-{types,schema}.ts`.
The published `/api` and `/llm` list all `/billing/v1/voice` POST routes.

`/grants` uses CUSTOMER_LIFECYCLE plus an exact-endpoint RS256 `X-UOA-Actor` from a
live selected-team manager. The immutable grant binds original subject/epoch/key,
paid number resource, exact allocation/delegate, direction/purpose, duration,
concurrency and explicit outbound destination list. Inbound grants accept arbitrary
external callers without impersonating them. No grant is a caller authentication proof.

`/quotes`, `/reservations`, `/reservations/{read,claim,receipt,release}` and
`/grants/{read,revoke}` require VOICE_RUNTIME. Quote takes product/grant/delegate,
from/to and max_duration_seconds. Reserve adds dispatch_id/request_fingerprint,
quote_id, conversation_id/leg_id, nullable call_sid and parent_reservation_id.
The service derives payer, organisation, team, number and allocation from the grant.
A human transfer is a separate outbound leg, reserved before dialling, linked to a
same-team active parent. Both legs may charge concurrently.

Read takes product/dispatch_id. Claim adds request_fingerprint; receipt adds
request_fingerprint/call_sid; release adds request_fingerprint,
proof=no_provider_dispatch and nullable dispatch_token. Responses carry
reservation_id, dispatch_id, state, dispatch_token, reserved_credits,
consumed_credits, call_sid, max_duration_seconds and claim_expires_at.
The winning claim alone returns a token. Timeout is uncertain, never permission
to redial. Releases with an existing CallSid require a provider receipt instead.
A terminal absent price is unresolved, not zero. Settled receipts cannot change.

## Financial boundary

One fixed maximum duration is reserved per leg. No rolling extensions are supported.
Existing paid number subscriptions are reused; Voice creates no second monthly charge.
Quotes retain provider pricing plus private accepted policy; only final credit bounds
leave UOA. Holds share the AI/SMS wallet lock, SQL availability guard and team budgets.
Actual connectivity liability uses frozen rating and the existing credit-lot ledger.
Unpriced, changed, over-duration or over-bound receipts retain reconciliation holds.
Late receipts retain original team/payer even after grant revocation or number reassignment.

## Required operator evidence before enabling

`BILLING_VOICE_ENABLED=true` and `BILLING_VOICE_POLICY_JSON` are deployment-owned.
The strict JSON requires version, accountSid, region (us1/ie1), expiresAt, markupBps,
billingIncrementSeconds, minimumBilledSeconds, maxDurationSeconds,
pricingEvidenceDigest, cutoffEvidenceDigest, featureProfile=connectivity_only and
ancillaryCharges=none. There are no commercial defaults. Evidence hashes refer to
operator-reviewed evidence retained outside source control; they are not an attestation
from a customer. Never populate these fields merely to bypass an unavailable gate.

The adapter currently accepts USD only and conservatively selects the maximum
exact-destination price across all reported origin groups. It verifies owned voice
capability and exact account/from/to/direction/parent CallSid. Runtime and regional
Twilio credentials reuse the existing SMS account configuration; separate VOICE_RUNTIME
UOA credentials are required. Price evidence cannot establish destination permission.

Twilio Call price covers connectivity only. Say/Gather choices, recording, AMD,
Media Streams and any other enabled feature need a complete charge inventory before
this connectivity-only profile is accepted. Charged ancillary features need an
additional independent receipt contract. Nessie's SMS/DTMF call proof cannot be
claimed live under this profile until its exact prompt costs are resolved.

Nessie must prove provider-enforced duration for inbound streams, outbound calls
and transfers across process loss. Set the authorized cap before answering/dialling.
Reserve inbound before any answering TwiML, including verification guidance. A local
timer alone is insufficient. Missing funds or evidence must reject before answer;
provider charges outside that boundary require explicit reconciliation, never an
invented zero receipt. Ledger inference and OTP SMS retain separate admission.

Sources: [Voice pricing](https://www.twilio.com/docs/voice/pricing),
[Call resource](https://www.twilio.com/docs/voice/api/call-resource).

## Verification scope

Focused gates are `billing-voice-provider.test.ts` and
`integration/billing-voice.persistence.test.ts`, alongside existing SMS dispatch and
telephone OTP financial regression suites. They use synthetic provider and Stripe
evidence and a dedicated migrated PostgreSQL database. They do not prove live cutoff,
provider permissions, ancillary prices or the consuming Nessie deployment.

The first isolated verification passed API typecheck and four provider-evidence
unit cases. Database setup identified a missing runtime-key purpose constraint;
the additive `20261021153000_voice_runtime_key` migration extends that constraint
without weakening lifecycle-key return-origin requirements. Financial integration
verification continues after that correction.

The dedicated database uses Europe/London to expose timezone assumptions. It found
that the existing customer-action intent guard compared UTC timestamp columns to
session-local timestamptz values. `20261021154000_voice_timestamp_authority` makes
that comparison explicitly UTC and gives new Voice evidence UTC defaults. Existing
customer-action authority checks remain intact.

Financial fixtures use an explicitly synthetic opening wallet large enough to keep
independent unsettled call cases. The race case then attempts four holds whose sum
exceeds that wallet, proving only three admissions succeed. Transfer tests verify
separate child funding and exact provider parent-call evidence.

Voice runtime keys are issued through the existing system-admin app-key API. The
existing product App keys tab reads and revokes them; the issuance form remains
limited to its existing purposes. This tranche adds no customer grant-management UI.
A focused headless browser fixture covers the Voice key row and revocation wording.

### Completed isolated verification (21 October 2026)

On Maxis Windows, the dedicated PostgreSQL database on port 55452 passed all eight
Voice financial cases, four provider cases, seventeen personal-telephone cases,
six existing SMS dispatch cases and four existing telephone proof-SMS cases.
API and Admin typechecks passed, as did ESLint over changed TypeScript files.
The desktop and mobile headless Edge journey passed for API-issued Voice key
inspection and revocation. Both screenshots were reviewed. Database and browser
servers were stopped after verification. No live Twilio or paid account was changed.

Self-review covered endpoint-purpose separation, live grant authority, selected-team
binding, immutable dispatch/receipt evidence, shared wallet holds, late settlement,
private-number routing and call-scoped lower assurance. Deployment remains gated by
the provider pricing, ancillary-charge and process-loss cutoff evidence above.

## Provider activation audit, 21 October 2026

The public [Voice pricing table](https://www.twilio.com/en-us/voice/pricing/us?content_language=English)
lists Media Streams at USD 0.0044/minute, basic TTS free, premium TTS by character
and speech Gather by use. These are public list prices, not verified negotiated
prices for the installed account. Pin a supported basic `man`/`woman` voice and
language explicitly for free prompts; do not rely on the account TTS default.
DTMF-only Gather must not enable speech recognition. Free prompts cannot remove
the Media Streams charge from an AI conversation.

[Twilio rounding](https://help.twilio.com/articles/223132307-How-do-you-round-minutes-for-billing-)
applies whole-minute rounding independently to call legs and Media Streams. The
current connectivity policy now requires 60-second increments and a 60-second
minimum. A one-second increment could under-reserve even a correctly priced route.

### Remaining receipt prerequisite

The [Call resource](https://www.twilio.com/docs/voice/api/call-resource) price excludes
ancillary features. The documented [Streams resource](https://www.twilio.com/docs/voice/api/stream-resource)
does not establish an independently readable final stream charge. The documented
[Usage Records](https://www.twilio.com/docs/usage/api/usage-record) aggregate by
account, category and date; their totals cannot attribute concurrent calls to teams.
No exact stream-charge endpoint was established by this audit. This is a provider
contract gap, not a claim that Twilio cannot supply the evidence.

Before implementing ancillary settlement, obtain an account-specific supported
receipt/export contract that binds the charge or billable units to AccountSid,
CallSid and StreamSid, with currency, finalized state, rounding and correction
semantics. Verify bidirectional IE1 coverage. Persist that evidence independently
and settle the sum of connectivity and ancillary liability once. A signed stream
start/stop callback supplies operational evidence, not a provider price receipt.
Do not charge a full-call rounded estimate as actual streamed usage. Do not spread
account totals between customers, substitute a zero, or silently absorb a paid
feature under the current prepaid contract.

### Remaining cutoff prerequisite

REST Call create/update documents `timeLimit`; `<Dial timeLimit>` terminates its
called leg. These are provider-side controls, so they are the candidates for
surviving Nessie process loss. [Connect](https://www.twilio.com/docs/voice/twiml/connect)
has action/method attributes and no documented duration attribute. A timer in the
WebSocket process or a Hangup after a still-running Connect is not an independent
cutoff. Do not add an unsupported `timeLimit` to Connect or Stream.

The exact-account proof must cover: outbound creation with its funded limit;
inbound acceptance of the limit before any answering TwiML; transfer with separate
child and parent limits; process loss immediately after dispatch; and delayed or
missing callbacks. Record provider acceptance, CallSids, start/end timestamps,
actual durations and finalized charges. Determine whether inbound REST update is
accepted while the incoming webhook is pending and whether updates measure total
or remaining duration. Reject before answer when a safe bound cannot be installed.
A successful unit mock or documented parameter alone does not establish this race.

No live provider writes or calls were authorized for this tranche. Consequently
these account-specific receipt and cutoff proofs remain external prerequisites;
`BILLING_VOICE_ENABLED` must remain false for Nessie Media Streams. Existing API
request/response shapes are unchanged. New policy tests reject unsupported ancillary
configuration, sub-minute billing, disabled activation and expired evidence.

## Live payer attribution for agent inference

`POST /billing/v1/voice/grants/read` returns `billing_origin` on an active grant:
`{subject, token_version, organisation_id, team_id, expires_at}`. The subject and
epoch are the immutable consenting issuer, and org/team are the exact grant scope.
UOA rechecks current issuer epoch, active selected-team membership, billing manager
authority and the original lifecycle consent key. Failed authority returns 401/403.
The tuple expires within 60 seconds; revoked grants return null, as do create/revoke
responses. A new read is required for later use. No schema migration is needed.

Nessie may use this tuple only as an independent agent's billingOrigin, followed by
a fresh ordinary UOA `ai.invoke` delegation exchange. The external caller remains
a separate principal. Neither the tuple nor a Voice grant grants personal context,
tools, sign-in or a browser session. This addition does not enable paid telephone
audio or remove ancillary pricing and provider cutoff gates.

Payer attribution verification on Maxis: protocol build, API typecheck and scoped
ESLint passed. All ten Voice persistence tests passed against the isolated migrated
database on port 55452, including issuer epoch change, team removal, original
consent-key revocation, foreign product refusal and revoked-grant null attribution.
The database was stopped afterward. No live provider was used.

## Approved fixed-rate Media Streams tariff

The customer-approved fixed tariff supersedes the earlier requirement for a
provider-priced stream receipt **only for Media Streams**. UOA bills a disclosed
fixed USD rate from trusted Nessie-reported duration and separately reconciles the
provider invoice. It does not claim the fixed charge equals Twilio's actual cost.
Connectivity still uses independently fetched `Call.price`. Other ancillary
features remain unsupported; live admission remains disabled until validated
policy and provider-enforced cutoff evidence are installed.

Policy `featureProfile=media_streams_fixed`, `ancillaryCharges=fixed_rate` requires
`streamPricePerMinute`, `streamDisclosureVersion` and
`streamBillingBasis=nessie_duration_rounded_minute`, in addition to all existing
account, region, expiry, pricing and cutoff evidence fields. Currency is USD.
No new environment switch enables this implicitly. Existing connectivity-only
policies refuse a quote requesting a stream.

Quote and reserve optionally accept `media_stream=true`. The quote returns nullable
`stream_tariff`: `currency`, `price_per_minute`, `customer_price_per_minute`,
`rounding_seconds:60`, `max_streams:1`, `disclosure_version`, and
`basis:nessie_duration_rounded_minute`. The customer rate includes the frozen markup;
quote/hold calculation uses the base rate plus that same markup exactly once.
Nessie must display the customer per-minute rate, per-started-minute rounding and
minimum one minute separately from telephone connectivity and model inference.
Reserve echoes `stream_disclosure_version`; a missing/mismatched version refuses.
A connectivity-only transfer can omit the stream even under a stream-enabled policy.

The prepaid bound includes maximum rounded connectivity and maximum rounded stream
duration. There is one StreamSid per reservation; reconnecting with another stream
requires a separately funded call. Quotes and consent-version bindings are immutable.

`POST /billing/v1/voice/reservations/stream` uses the existing VOICE_RUNTIME key and
accepts `{product,dispatch_id,request_fingerprint,call_sid,stream_sid,event,started_at,
stopped_at}`. Event is `start` or `stop`; stop is null for start. Timestamps are UTC
ISO values from Nessie's observed stream lifecycle. Nessie must verify Twilio's
signature/account/call/stream bindings, retain a durable outbox, and persist start
before stop. UOA independently fetches the CallSid to verify its route before
recording evidence. Account/StreamSid and reservation ownership are unique. Exact
retries are idempotent; changed bindings or stopped timestamps are conflicts.
Evidence is immutable except filling the initially absent stop once.

Settlement waits for both finalized connectivity and stream stop. Duration is
rounded up to seconds, then whole minutes, minimum one minute once started. Missing
start/stop after dispatch retains the full hold as uncertain; a late durable stop
and ordinary receipt retry recover it. A stream above the funded maximum, a call
above that maximum, or combined cost above the hold remains in reconciliation with
no debit. A one-second comparison tolerance accommodates provider whole-second
call duration versus millisecond stream observations; it never widens the funded
maximum. No timer-derived stop or zero-price substitute is accepted.

### Separate account invoice reconciliation

`POST /billing/v1/voice/stream-reconciliation` is deliberately machine-only
operator infrastructure. It accepts `product,account_sid,billing_month` and nullable
`invoice:{id,amount_usd,reference}`. The authenticated product may report the
account's Media Streams invoice line total, not its entire telephone invoice.
Evidence is explicitly `operator_reported`; UOA does not label it provider-verified.
New IDs append corrections; reusing an ID with different values refuses.

The response exposes base fixed stream amounts, pending call count, invoice total,
reference, difference and status (`awaiting_invoice`, `pending_calls`, `matched`,
`difference`). It aggregates across that product's teams for operator reconciliation
only; member billing remains selected-team scoped. Known multi-product accounts
are refused. The operator must confirm the invoice covers only the product's
stream traffic; untracked provider traffic can cause a difference. Attribution uses
the stream-start UTC month; cross-month calls may differ from the provider invoice
and require review. Differences never change customer debits or allocate an account
bill among teams. Existing wallet statements remain the source for customer charges.

Fixed-stream verification on Maxis: Prisma generation, protocol build, API
typecheck and scoped ESLint passed. Twelve Voice persistence tests and eleven
provider/policy tests passed (23 total) against the isolated migrated database on
port 55452. Coverage includes concurrent exact starts, changed/reused stream
receipts, immutable stop amounts, missing start/stop holds, over-duration retention,
disclosure-version refusal, one debit, separate invoice differences, existing
selected-team refusal and concurrent prepaid wallet admission. These use synthetic
provider evidence; a real concurrent two-team telephone call was not performed.
The database was stopped after the run. Self-review confirmed that invoice reports
cannot alter customer debits and that connectivity-only quotes cannot accept stream
evidence. No live policy, provider resource or paid call was changed.
