export const llmBillingVoiceMarkdown = `
## Prepaid telephone calls

Voice contract 2.0.0 uses the existing /billing/v1/voice endpoint namespace and is machine-only billing infrastructure.
Upgrade the consumer protocol with UOA: grant responses require nullable billing_origin and quote responses
require nullable stream_tariff. A missing tariff never authorizes streams. Nessie owns number/agent controls and call history.
Use /billing/v1/voice/grants with a CUSTOMER_LIFECYCLE key and a fresh exact-endpoint X-UOA-Actor
for explicit selected-team manager consent. Body includes subject, idempotency_key, number_id
(UOA paid resource), allocation_id, delegate_id, direction, purpose, max_duration_seconds,
max_concurrent_calls and destinations. Outbound requires exact permitted E.164 destinations;
inbound destinations is empty. Grants cannot authorize personal context from caller ID.

All remaining Voice routes require a dedicated VOICE_RUNTIME key. /grants/read and /grants/revoke
accept product and grant_id. Active grant reads include billing_origin with subject, token_version,
organisation_id, team_id and expires_at (at most 60 seconds). UOA rechecks the original issuer
epoch, selected-team membership/management and consent key. Failed live authority returns 401/403;
revoked grants and create/revoke responses have billing_origin=null. Use this tuple only as
agent billingOrigin to exchange a fresh ai.invoke delegation; it never identifies the caller or
authorizes personal context/tools. Do not persist it as a profile or use it after expiry.
/quotes accepts product, grant_id, delegate_id, from, to and
max_duration_seconds. /reservations additionally takes dispatch_id, request_fingerprint, quote_id,
conversation_id, leg_id, nullable call_sid and nullable parent_reservation_id. Inbound needs its
verified provider CallSid before any answering TwiML. Human transfer requires a separately funded
child leg bound to the parent reservation. Payer/team/allocation come from UOA's grant.

/reservations/read accepts product and dispatch_id. /claim adds request_fingerprint and returns a
one-winner dispatch_token; never redial on timeout. /receipt adds call_sid and independently fetches
Twilio evidence. /release adds proof=no_provider_dispatch and nullable dispatch_token; unknown
outcomes retain funds. Inbound CallSid reservations resolve through receipts, including rejected calls.
Every reservation response contains reservation_id, dispatch_id, state, dispatch_token,
reserved_credits, consumed_credits, call_sid, max_duration_seconds and claim_expires_at.

For an explicitly configured fixed Media Streams tariff, quote/reserve add media_stream=true.
Quote returns stream_tariff with USD price_per_minute, customer_price_per_minute (including frozen
markup), rounding_seconds=60, max_streams=1, disclosure_version and basis=nessie_duration_rounded_minute.
Show that fixed charge separately from connectivity and model usage. Reserve must echo
stream_disclosure_version after disclosure. No stream is authorized by a connectivity-only quote.

POST /billing/v1/voice/reservations/stream takes product, dispatch_id, request_fingerprint, call_sid,
stream_sid, event=start|stop, started_at and stopped_at (null for start). Persist start before stop;
retry exact evidence after timeout. Nessie must validate Twilio signatures/bindings and durably queue
both events. This is trusted Nessie duration evidence, not a Twilio price receipt. Missing stop or
start after claim keeps funds uncertain; overbounds retain reconciliation. /receipt fetches Call.price
and adds the frozen fixed stream charge for each started rounded minute (minimum one).

POST /billing/v1/voice/stream-reconciliation is an operator machine surface, never a member billing
surface. Body: product, account_sid, billing_month, invoice=null or {id,amount_usd,reference}.
It stores immutable operator-reported account Media Streams invoice totals; use a fresh id for a
correction. Returns fixed_stream_amount_usd, pending_streams, invoice_amount_usd, invoice_reference,
difference_usd and status. Shared multi-product accounts are refused. Differences are operational
reconciliation and never alter customer fixed-rate debits or distribute charges across teams.

Quote/reserve/claim are disabled without operator-owned complete pricing and failure-safe cutoff
evidence. Connectivity-only policies still refuse streams. A fixed stream policy additionally requires explicit
rate/disclosure configuration and existing cutoff proof; billed Say/Gather, recording, AMD and other
ancillary features remain unsupported. Model usage and
OTP SMS have separate prepaid admission. Receipts/releases remain available after Voice admission
is disabled. No live calls, payments or provider resources are created by UOA.
`;
