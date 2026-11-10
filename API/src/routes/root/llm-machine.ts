export const machineEnrollmentMarkdown = `
## Protected machine enrollment (version 1)

Discovery capability: machine_enrollment_v1, minimum consumer version 1. Exact
schemas: /schemas/machine-enrollment-v1.json; every route/body appears in /api.
This authorizes one Nessie product connection, not physical installation identity,
inference capacity, a human session, or any other automation/provider grant.

Authenticate /machine/v1 with the product's existing domain bearer and verified
config_url plus domain. POST /machine/v1/authorization-requests with the saved
request UUID, strict public Ed25519 JWK, device_name, subject, exact HTTPS audience,
organization_id, team_id, purpose=computer_connection and product binding_id.
Validate the locally expected typed context and RFC8785 SHA256 request preimage
before signing the exact returned UTF8 UOA-MACHINE-POP-V1 transcript. An arbitrary
text signer or accepting an unknown hash is forbidden. Submit detached proof to
the request /proof route. The authorization_url uses normal UOA authentication,
current scope, factors and agreements, then explicit cookie/CSRF HUMAN consent.
Neither a GET nor successful login grants a computer. The /result route returns
status only. Fresh CURRENT bound-key recovery retrieves the SAME issued credential.

The immutable original grant is enrollment_id; authorization_id is the exact
append-only human consent event. Scoped explicit reauthorization links a new
event; legacy_assurance_id must name the exact original person/client/org/team.
Nothing changes or validates that old proof, and adoption still requires the
product's separate protected-installation and existing-connection dual proof.
Same labels never merge devices. UOA keeps canonical people/membership; products
retain stable references and encrypted scoped opaque credentials, not profiles.
binding_id is the product's authorization binding, separate from stable Computer,
per-team connection/Executor and host/resource IDs. Terminal retirement needs a
deliberately new grant/binding plus fresh human and key proof. Preserve those
stable refs through explicit additive adoption and protected-installation/original
connection continuity; never delete/recreate the connection or link by name/IP/owner.

Use /challenges then /enrollments/validate, rotate or revoke with exact Binding,
request_id, enrollment_id, authorization_id, safe credential_generation,
lossless canonical int64 decimal source_version, opaque credential and proof.
One predecessor has one successor. Exact response-loss rotation retries recover
that successor for 120 seconds; different operations conflict. After ANY ambiguous
rotation, persist uncertainty and use recovery FIRST with the saved operation_id
and a fresh recovery request UUID and full Binding. Do not blindly present an
old predecessor after120seconds: that is theft policy. Recovery returns credential
metadata with fresh_validation_required=true, never an allowed admission or
extended authorization/credential deadline. It never accepts a replacement key,
creates another grant or silently reauthorizes a connection.

Decisions are allowed, reauthorization_required, revoked or access_removed with
finite safe reasons and an absolute recheck_by no later than issued_at + 30 seconds
and every authority/credential/account/inactivity deadline. A dependency/transport
outage is a SEPARATE unavailable outcome (HTTP503 MACHINE_AUTHORITY_UNAVAILABLE
where UOA can reply), with no invented grant/version/identity fields. HOLD new
work on unavailable checks, missing/expired receipts, cursor/version conflicts,
event gaps and incomplete pull reconciliation; preserve queues and uncertainty.

Prepare outside effect locks. Consume an unserializable process-local receipt
under original connection/grant locks, comparing exact owner/client/audience,
org/team/purpose/binding/key, original grant, authorization, generation, connection
epoch and durable replica revocation/freshness fence. Subtract the FULL monotonic
roundtrip from the issuer's lifetime, measured before request; also enforce the
absolute UTC deadline minus local clock uncertainty. Unsynchronized clocks or
negative budget HOLD. No positive skew grace, cache hit, refresh, reconnect or
restart can extend that 30-second ceiling. Recheck scope before output exposure.
A delayed response cannot clear a newer fence or reconciliation gap. An old event
cannot retire a newer legitimate consent by arrival order. This is bounded NEW
admission/disclosure, not zero post-revocation effect commit or automatic stopping
of provider-accepted work. Existing receipts and stop/uncertainty settlement stay
separate from authority; never blindly replay already accepted effects.

Pull /revocations at least every 15 seconds. Persist idempotent event IDs/content
digests and monotonic per-grant versions before acknowledgment. Conflicting repeated
IDs/versions HOLD. The feed exposes a txid-safe committed prefix; a long transaction
can delay delivery, never extend an admission deadline. Signed cursors expire after
24 hours. On expiry HOLD, capture /revocations/checkpoint BEFORE walking all retained
local grant references through /reconcile (max100 per batch), drain events through
the returned high-water mark, and persist complete reconciliation plus cursor
atomically before fresh key-proven admission. Partial walk/restart is not freshness.
Push reuses the existing operator-provisioned dedicated revocation HMAC key only
after explicit machine-v1 readiness. Ready proof is HMAC-SHA256(secret, UTF8
UOA-MACHINE-REVOCATION-READY-V1 newline + JSON.stringify({client_domain,key_id,
challenge,cursor,capabilities}) in that order). Delivery headers and timestamp.body
HMAC match the existing revocation transport; payload additionally names capability
machine_enrollment_v1. Exact acknowledgment is {ok:true,version:1,event_id}.
Receiver admission/readiness does not establish installed/native correctness.

Independent consent lasts at most365days; each credential and inactivity at most
30days, shortened by enterprise policy. Ordinary family-only browser logout and
rotation are independent. ANY global tokenVersion increment remains a security
fence, including legacy global logout/replay/corruption paths. Device/revoke-all,
account/product disable, lost membership/entitlement and SSO generation changes
stop affected machine authority. Re-add/reenable/new login never restores it.
The owner home is /auth/machines, reached through /machine/v1/management and fresh
normal sign-in; Admin user Security provides operator revoke/revoke-all.
The home preserves config_url for fresh human sign-in after page expiry; that
sign-in alone grants no machine authority. Agreement continuations retain the
exact original opaque state and complete before separate explicit machine consent.
New renewal intents must match the original binding/name/current key. Terminal
originals return409 MACHINE_NEW_GRANT_REQUIRED before a new human review; exact
replay of an already published request still returns its original intent.
No production grant is seeded and no consumer should activate until exact deployed
version/capability plus its protected native installation contract are verified.
`;
