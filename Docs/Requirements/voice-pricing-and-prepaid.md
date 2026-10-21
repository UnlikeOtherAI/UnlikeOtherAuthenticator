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
