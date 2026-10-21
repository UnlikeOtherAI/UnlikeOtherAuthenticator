export const llmBillingVoiceMarkdown = `
## Prepaid telephone calls

Voice v1 is machine-only billing infrastructure. Nessie owns number/agent controls and call history.
Use /billing/v1/voice/grants with a CUSTOMER_LIFECYCLE key and a fresh exact-endpoint X-UOA-Actor
for explicit selected-team manager consent. Body includes subject, idempotency_key, number_id
(UOA paid resource), allocation_id, delegate_id, direction, purpose, max_duration_seconds,
max_concurrent_calls and destinations. Outbound requires exact permitted E.164 destinations;
inbound destinations is empty. Grants cannot authorize personal context from caller ID.

All remaining Voice routes require a dedicated VOICE_RUNTIME key. /grants/read and /grants/revoke
accept product and grant_id. /quotes accepts product, grant_id, delegate_id, from, to and
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

Quote/reserve/claim are disabled without operator-owned complete pricing and failure-safe cutoff
evidence. This version settles USD connectivity only; do not enable billed Say/Gather, recording,
AMD or other ancillary features without an additional evidence/receipt contract. Model usage and
OTP SMS have separate prepaid admission. Receipts/releases remain available after Voice admission
is disabled. No live calls, payments or provider resources are created by UOA.
`;
