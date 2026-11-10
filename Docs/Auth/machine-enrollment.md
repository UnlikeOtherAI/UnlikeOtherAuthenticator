# Machine enrollment, version 1

Implementation status: in progress on `t3/machine-enrollment-authority`. This is
the proposed exact v1 wire contract for consumer implementation. It is not a
claim that these endpoints are deployed. Activate only after the implementation,
persistence/HTTP checks, browser review and exact deployed capability checks pass.

UOA authorizes one named protected device key to maintain one product connection
for one subject and exact organisation/team. The capability is
`machine_enrollment_v1`, wire version `1`, minimum consumer version `1`. It does
not identify a physical installation. Native installation continuity, caller
admission and dual proof of an old connection key remain the product's duties.
Device names are display text and never deduplicate devices or authorize access.

## Boundary and policy

The original machine grant has an immutable subject, authenticated client domain,
exact HTTPS audience, organisation, team, `purpose: computer_connection` and
product-owned opaque `binding_id`. Its immutable first consent is distinct from
the current, append-only authorization event. A credential rotation changes only
the opaque machine credential/generation. Explicit human reauthorization appends
a linked authorization event. It cannot rewrite its predecessor, recapture an
old human proof, or renew any binding-editor, run, provider or automation grant.

V1 admits the canonical server-mapped `nessie` product only, using its existing
active ClientDomain and unambiguous active product mapping. The exact audience
is `https://` followed by that full client-domain/service identity. No new
credential framework, operator resource, profile mirror or synthetic user is
introduced. The website signed-config and domain-hash boundaries stay mandatory.

Default independent consent lasts at most 365 days. Inactivity and each rotating
credential last at most 30 days. Effective enterprise reauthentication policy may
shorten the authorization deadline; it never lengthens it. All deadlines are
absolute UTC instants owned by UOA. Browser access/refresh families remain human
authority and are not machine transport. Ordinary **family-only** logout and
ordinary browser rotation leave machines authorized. Any global `tokenVersion`
increment, including legacy global logout or replay/corruption handling, fences
machine authorization as `revoked/security_reset`.

Device revoke, revoke-all, account disable, product disable, lost scope and SSO
generation changes fence affected enrollments. Re-add, re-enable, a new login,
polling, reconnect, cache hits and process restart never revive them. An explicit
reauthorization needs a fresh UOA human authorization plus protected-key proof.
Device/theft/corruption retirement requires a deliberately new grant. Private key
rotation within an existing grant is unsupported in v1 and refused; a human must
authorize a new key explicitly. Old history remains retained.
`binding_id` is a product-owned **authorization binding ID**, unique per original
grant. It is separate from the stable Computer installation ID, per-team
connection/Executor ID, host IDs and resource IDs. Terminal device/theft/corruption
retirement requires a deliberately new `enrollment_id` and `binding_id`, fresh
human consent and protected-key proof. Nessie preserves its Computer, connection,
host, existing operation-grant/resource and history references through an additive,
explicit adoption mapping. It must not delete/recreate a connection just to select
a fresh authorization binding. Protected installation and original connection
continuity plus explicit lawful authorization remain required. A name, IP address
or matching owner alone must never auto-link a replacement grant.

For example, fictional Computer `computer-studio`, team connection
`connection-design` and host `host-studio` may retain those exact references
while an explicit adoption adds authorization binding `binding-review-2` and new
enrollment `00000000-0000-4000-8000-000000000022`. Retired binding
`binding-review-1` and enrollment `00000000-0000-4000-8000-000000000011` remain in
history and stay retired. The new grant authorizes only the exact new consent's
purpose/scope; existing unrelated binding-editor/run/provider grants receive no
renewal. Ordinary explicit reauthorization of a nonterminal grant instead keeps
its original enrollment/binding and appends a linked human authorization event.

## Authentication and routes

Every `/machine/v1/*` route requires `Authorization: Bearer <this product's domain
hash>` and `?domain=<exact service>&config_url=<verified signed config URL>`.
Neither that app credential nor a machine credential is a human identity. Every
body is strict: unknown fields, inexact audiences and partial scope are refused.
Responses are private/no-store. Credentials and proof material stay out of URLs,
browser storage, screenshots, diagnostics and public error bodies.

| Method | Route | Request and result |
| --- | --- | --- |
| GET | `/machine/v1/capabilities` | Exact public policy/version/deadline/proof profile under product authentication; discovery also appears in public `/api`. |
| POST | `/machine/v1/authorization-requests` | `AuthorizationRequest` below; returns `{version,request_id,challenge_id,transcript,expires_at,authorization_url}`. Intent only; no grant. Same request ID and exact arguments replay that intent; mismatch is 409. |
| POST | `/machine/v1/authorization-requests/:requestId/proof` | `{proof:{challenge_id,signature}}`; verifies fresh installation key possession. No human grant. Exact retry is idempotent. |
| POST | `/machine/v1/authorization-requests/:requestId/result` | `{}`; returns pending/denied or committed enrollment metadata. It never returns a machine credential without fresh key proof. |
| POST | `/machine/v1/management` | `{}`; returns a normal UOA human sign-in URL for the selected-team connection home. No machine grant. |
| POST | `/machine/v1/recovery/challenge` | Full `Binding` plus `{request_id:UUID,operation_id:UUID}`; fresh current-bound-key challenge for the exact saved issuance/rotation operation. |
| POST | `/machine/v1/recovery` | Same body plus `proof`; returns only that same current committed credential and `fresh_validation_required:true`, or 409 if superseded. No allowed admission, grant, successor or deadline extension. |
| POST | `/machine/v1/challenges` | `{operation:"validate"|"rotate"|"revoke",request:Operation}`; fresh exact-operation challenge. |
| POST | `/machine/v1/enrollments/validate` | `Operation` plus `proof`; fresh exact decision below. |
| POST | `/machine/v1/enrollments/rotate` | `Operation` plus `proof`; atomically returns the one committed successor credential and decision. |
| POST | `/machine/v1/enrollments/revoke` | `Operation` plus `proof`; idempotent exact device retirement. |
| POST | `/machine/v1/revocations/checkpoint` | `{}`; signed pre-walk high-water cursor. |
| GET | `/machine/v1/revocations` | `cursor`, `limit` (1–200); authenticated immutable version events, `next_cursor`, `has_more`. |
| POST | `/machine/v1/reconcile` | `{enrollment_ids:UUID[]}` (1–100); exact-domain current fences only, never an allowed admission or profile directory. |
| POST | `/machine/v1/revocation-consumer/challenge` | `{}`; readiness challenge for the existing enabled operator-provisioned revocation consumer. |
| POST | `/machine/v1/revocation-consumer/ready` | Exact readiness acknowledgment and dedicated-key HMAC described below; opt-in machine push, never a native correctness attestation. |

The hosted `/auth/machines` consent and owner home use UOA's normal human
authentication and existing theme/layout controls. Entry is reachable from the
authorization intent. Fresh post-factor authentication opens a browser-bound
HttpOnly session; GET/login never grants a device. The separate, CSRF-protected
Approve POST records consent. The home lists only this person's admitted device
connections and offers explicit per-device and all-device revoke. Operator
revocation is reachable from the existing Admin user Security panel. These
browser and Admin credentials never enter product machine APIs.
The home preserves the original config URL for a fresh normal human sign-in
after page expiry. That sign-in does not renew any machine approval. A required
agreement retains the exact original opaque state through its canonical signing
continuation; only the subsequent explicit machine-consent POST creates authority.
New renewal intents must match the original authorization binding, device label
and current protected key. Terminal originals return
`409 MACHINE_NEW_GRANT_REQUIRED` before presenting another approval. Exact replay
of an already published intent continues to return that original intent.
The UI labels enrollment creation as “Record created”, preserves millisecond
precision and shows the canonical approval reference. It never presents that
timestamp as the latest approval or revocation. A security-reset hold remains
separately revocable; only terminal retirement reasons appear as ended history.
An exact key-proven request for an SSO-governed team starts the existing canonical
enterprise flow. V1 requires one unambiguous active enterprise connection for
that scope; absent/ambiguous routing holds the request. It never falls back to
an independent sign-in to bypass an enforced enterprise policy.

```ts
type Binding = {
  subject: string; audience: string; organization_id: string; team_id: string;
  purpose: 'computer_connection'; binding_id: string;
};
type PublicKey = { kty: 'OKP'; crv: 'Ed25519'; x: string /* 32-byte base64url */ };
type AuthorizationRequest = Binding & {
  request_id: string /* UUID saved before sending */;
  device_name: string /* 1..100 characters */; public_key: PublicKey;
  enrollment_id?: string /* explicit linked reauthorization only */;
  legacy_assurance_id?: string /* exact retained original, explicit adoption only */;
};
type Operation = Binding & {
  request_id: string; enrollment_id: string; authorization_id: string;
  credential_generation: number; source_version: string /* positive decimal */;
  credential: string /* opaque uoa_machine_...; server/native custody only */;
};
type Proof = { challenge_id: string; signature: string /* detached Ed25519 */ };
```

The original grant ID is `enrollment_id`; `authorization_id` identifies its exact
human consent event. `credential_generation` increases on rotation or explicit
reauthorization. `source_version` is a positive decimal string increasing on
every authority fence, rotation or reauthorization. None may regress. Compare canonical decimal source versions with BigInt or an
equivalent lossless integer; never Number or lexicographic ordering. V1 generations
are integers in 1..2147483647. No coercion, leading zero, exponent or signed string
is accepted for source versions, whose maximum is 9223372036854775807. The key
thumbprint is RFC 7638 SHA-256 over the public JWK. No private JWK fields, alternate
curves, wildcard client/audience/team or display-name matching is accepted.

## Proof and response-loss rules

The native broker first parses and validates the typed expected issuer, client,
operation, saved request ID, challenge ID, nonce, deadline and locally expected
request digest/context. It must reject unexpected or ambiguous fields. Only then
does it sign the exact validated UTF-8 `transcript` bytes, without reformatting.
This is never an arbitrary-text signing primitive, and possession of a digest is
not human consent. Example bytes:

```text
UOA-MACHINE-POP-V1\n{"version":1,"issuer":"https://authentication.example.test","client_domain":"api.product.example.test","operation":"validate","request_id":"00000000-0000-4000-8000-000000000001","request_hash":"<sha256>","challenge_id":"00000000-0000-4000-8000-000000000002","nonce":"<random-256-bit-base64url>","expires_at":"2026-11-10T12:05:00.000Z"}
```

The `\n` above represents one newline byte. The request digest is lowercase SHA-256 over UTF-8 RFC 8785 canonical JSON
`{operation,request}`. The strict normalized request omits absent optional
properties; a credential value is replaced with its lowercase SHA-256 digest.
This bounded profile uses strings, booleans, null and safe integers only; lone
UTF-16 surrogates are refused. Authorize uses operation `authorize` and the exact
AuthorizationRequest; recovery uses `recover` and the complete Binding plus
saved `operation_id` and new `request_id`. No secret config fingerprint or
server-only field enters this digest. The native journal must retain the
expected operation preimage/context and credential digest; an untrusted caller
cannot bless an unknown hash. UOA separately binds the verified config URL and
fingerprint in persistence. The challenge binds this digest, and binds challenge,
operation, client, expected grant/generation/version, scope and five-minute
deadline. The signature is 64 bytes encoded as unpadded canonical base64url.
Only the registered exact key verifies it. A challenge cannot authorize another
request, operation, key, owner, audience or team.

Keys use canonical 32-byte Ed25519 point encodings and unpadded base64url.
Small-order keys and noncanonical field encodings are refused; a trivial
low-order signature is not protected-key possession. OpenSSL verifies signatures.
The [fictional interoperability fixture](fixtures/machine-enrollment-v1-proof.json)
publishes a complete normalized request, canonical UTF-8 digest and exact
transcript bytes/hash. It is deliberately expired, has no signature or server
record, and grants nothing. It proves neither human approval nor native custody.

The public schema publishes `transcript_fields`. The prefix and one JSON object
are one typed protocol message: reject duplicate keys, extra bytes, unsupported
fields, an unexpected HTTPS issuer/client, wrong operation or saved request,
challenge/nonce mismatch, or a deadline outside the locally expected challenge
budget. The digest must match the locally retained normalized operation preimage.
Signing validated bytes does not make a caller-provided text or digest trusted.
V1 emits compact JSON in the exact field order shown. A consumer may compare
the validated object with that producer form to reject ambiguous encodings,
then sign the original bytes. It must never sign a reconstructed replacement.

Issuance is atomic. One original request creates at most one consent and grant.
Rotation serializes on the original enrollment and database uniqueness enforces
one credential per generation and one successor per predecessor. Save the
operation ID before sending. Concurrent rotation and lost replies reconcile to
the **same** committed successor for 120 seconds. Different rotation IDs against
the same predecessor conflict without creating another successor. After a timeout
or ambiguous response, persist the uncertain operation and use recovery FIRST
with the original saved operation ID. Do not automatically present a consumed
predecessor after 120 seconds: that would manufacture a theft revocation.
Recovery and local journal reconciliation precede any new rotation. After that
window, presentation of a consumed predecessor is theft policy and retires only
that machine lineage. A structurally corrupt machine chain retires that lineage;
it cannot safely mint credentials or affect unrelated human families. Proven
theft or corruption remains terminal when discovered after a prior scope,
policy, expiry or security-reset stop. Fresh consent then requires a new grant
and authorization binding; it cannot reauthorize the retired original.

Recovery uses a fresh proof from the current protected key and the original
operation ID; it can recover only the exact persisted credential while it is
still current and live. It does not rotate, restore revocation, extend expiry,
switch authorization events or mint another grant. A superseded result is an
explicit conflict, not permission to retry enrollment under a new ID.

The consumer's durable journal follows this order:

1. Persist the exact binding, current grant/authorization/key/generation/version,
   normalized rotation request and original `operation_id` before sending.
2. Mark the operation uncertain before the first request can leave the process.
   A crash or lost response keeps that state across restart.
3. On any ambiguous result, HOLD new work and request a **new** recovery challenge
   with full Binding, a new `request_id`, and the persisted original `operation_id`.
   Validate its typed context, then prove the **current existing bound key**.
4. `recovered` returns the same current committed credential, generation/version
   and original absolute credential/authorization expiries, plus
   `fresh_validation_required:true`. Atomically store it with the journal result;
   perform fresh validation and check the replica fence before admitting work.
5. `pending` keeps uncertainty. `not_committed` is returned only after the original
   unconsumed rotation challenge expires and the enrollment lock confirms no
   committed successor. Only that explicit result settles the uncertain attempt.
   A new rotation may then start from the retained current credential if live.
   A conflict, denied outcome or outage never authorizes a replacement grant/key,
   blind predecessor retry or deadline extension.

## Typed decisions and freshness

After exact app/credential/key/binding authentication, the decision is:

```ts
type Decision = {
  version: 1; capability: 'machine_enrollment_v1';
  decision: 'allowed' | 'reauthorization_required' | 'revoked' | 'access_removed';
  reason: 'active' | 'authorization_expired' | 'inactive' | 'security_reset' |
    'device_revoked' | 'all_devices_revoked' | 'credential_replay' | 'lineage_invalid' |
    'account_unavailable' | 'product_disabled' | 'access_removed' |
    'sso_policy_changed' | 'authentication_policy_changed' | 'credential_expired';
  original_grant_id: string; authorization_id: string;
  credential_generation: number; source_version: string; client_domain: string;
  binding: Binding; key_thumbprint: string;
  issued_at: string; recheck_by: string; authorization_expires_at: string;
};
type Unavailable = { decision: 'unavailable'; reason: 'authority_unavailable' };
```

Allowed decisions have `reason: active`. UOA rechecks the active account and
expiry, global security epoch, source product/client, exact organisation/team
authority and enterprise connection/identity/policy. Authentication failures
stay non-oracular. Dependency/DB failure is HTTP 503 with exactly
`{decision:"unavailable",reason:"authority_unavailable"}`. Network failures and
upstream/proxy 5xx responses normalize to the same separate outcome. It means
unavailable, never denied or revoked. Consumers normalize that transport outcome to
`{decision:"unavailable",reason:"authority_unavailable"}`, without any grant,
identity, generation, version or deadline fields. This is a separate union member,
not a full Decision populated with fabricated references or zero identifiers.
An authentication/config refusal before exact machine proof (HTTP 401/403) is
not a machine revocation decision either: HOLD and repair transport/config or
reconcile an authenticated exact fence. A disabled client domain may refuse the
normal domain-authenticated transport before a typed decision can be formed;
its transactional revocation fence and expired admission still stop new work.

Allowed pairs only with `active`. `reauthorization_required` pairs with
`authorization_expired`, `inactive`, `credential_expired`, `sso_policy_changed`
or `authentication_policy_changed`. `revoked` pairs with `security_reset`,
`device_revoked`, `all_devices_revoked`, `credential_replay`, `lineage_invalid`,
`account_unavailable` or `product_disabled`. `access_removed` pairs only with
`access_removed`. A denial's `recheck_by` equals `issued_at` and grants no grace.

The hard maximum for **new admission and disclosure** is the earlier of the
issuer's absolute `recheck_by` and locally observed revocation/freshness fences.
`recheck_by` is never later than `issued_at + 30 seconds`, authorization expiry,
credential expiry, account expiry or inactivity deadline. Output exposure also
requires current exact scope. This is a bounded distributed guarantee; it does
not promise zero post-revocation effect commit/disclosure from a previously
prepared decision or cancellation of provider-accepted work. Existing receipts,
stop/uncertainty settlement and reservation rules govern already accepted work.
They never authorize new work or blind replay.

Validate before accepting work outside effect locks. Consume only a process-local
unserializable receipt under the original connection/grant locks. Atomically
compare original grant, consent event, generation, key, client/audience, subject,
org/team/purpose/binding, connection epoch and the durable replica fence. Missing
or expired capability, cursor/version conflict or gap, incomplete reconciliation,
or unavailable required checks means **HOLD**, preserving queues and uncertainty.
Do not turn missing freshness into a false revocation.

Use a monotonic timer captured **before** the HTTP request. Budget at most
`recheck_by - issued_at - full monotonic roundtrip`, never more than 30 seconds.
Also require the local UTC clock to be before `recheck_by` after subtracting
the consumer's configured clock uncertainty. Negative budget, unsynchronized
clock, future/invalid issuer time or non-monotonic timer fails closed. No positive
clock-skew grace is added to UOA's deadline. Cache hits, reconnects and restarts
cannot restart this timer. Restart discards every prepared receipt.

Capture the durable local event/freshness fence before requesting validation;
compare it again while publishing/consuming the receipt. An in-flight response
cannot overwrite a newer authorization/generation/version or clear a gap. A
delayed allow with an older version is discarded; equal version with conflicting
content is a conflict/HOLD. An old event only invalidates decisions at or below
its exact original-grant/version. It never retires a newer human authorization
by arrival order. Credential rotation does not extend a prepared decision.

## Events, pull recovery and explicit legacy adoption

Events contain `{id,version:1,client_domain,original_grant_id,authorization_id,
credential_generation,source_version,decision,reason,occurred_at}` and no
profiles or credentials. Persist each event ID plus content digest and the
per-grant version before acknowledging. An exact duplicate is idempotent;
conflicting repeated IDs/versions or missing history cause HOLD and reconciliation.

Push uses the existing operator-provisioned revocation destination and dedicated
HMAC key only after explicit machine-v1 readiness acknowledgment. It is a hint
with durable retry, not the maximum-delay authority. Pull repair runs at least
every 15 seconds. The 30-second decision ceiling holds even if delivery fails.
An unhealthy pull/reconciliation fence stops new admission until repaired.

Readiness requires the existing enabled consumer and its dedicated HMAC key.
POST `/revocation-consumer/challenge`, then submit strict
`{key_id,challenge,cursor,capabilities,proof}`. `capabilities` is exactly
`{version:1,exact_binding:true,monotonic_versions:true,idempotent_events:true,
deadline_fencing:true,pull_reconciliation:true,lossless_versions:true}`.
`proof` is lowercase hex HMAC-SHA256 over UTF-8
`UOA-MACHINE-REVOCATION-READY-V1\n` followed by compact `JSON.stringify` of
`{client_domain,key_id,challenge,cursor,capabilities}` in that field order and the
capability field order shown above. Readiness challenge lifetime is ten minutes.
Push JSON is `{version:1,capability:"machine_enrollment_v1",audience,event}`.
Headers are `x-uoa-revocation-key-id`, `x-uoa-revocation-timestamp` (Unix seconds)
and `x-uoa-revocation-signature` (lowercase hex HMAC-SHA256 over
`timestamp + "." + exact_body`). Verify expected audience/key, a bounded timestamp
window and exact bytes, then persist idempotent event content/fence before
replying exactly `{ok:true,version:1,event_id}`. An expired sender cursor disables
machine push pending fresh checkpoint/reconciliation/readiness; required pull
and decision deadlines continue to govern. Readiness cannot certify native custody.

Feed ordering uses transaction IDs plus sequence, exposing only the prefix below
the database snapshot's oldest active transaction. This prevents a late commit
from appearing behind an acknowledged cursor, without adding a new global lock
to human login or effect transactions. A long-running transaction can delay the
feed; it cannot extend a decision deadline. Signed exact-domain cursors expire
after 24 hours. On expiry: HOLD, capture a checkpoint **before** the walk, reconcile
every retained product grant in batches of at most 100, then drain events from
that pre-walk cursor through the returned high-water mark. Concurrent changes
are replayed. Persist completion and cursor together before resuming fresh
key-proven admission. A partial walk or restart never counts as a fresh fence.

Legacy adoption names the exact retained `legacy_assurance_id` and product
binding in a new human-approved request. UOA checks that the retained original's
subject/client/org/team match. Its old epoch/family may be stale; this is new
explicit consent, not validation or mutation of that old human proof. UOA retains
the immutable link. The product must additionally prove protected installation
and original connection-key possession and exact old connection/epoch under its
own locks. No production adoption or enrollment is part of this delivery.

## Delivery and acceptance

Runtime schemas live in `API/src/services/machine-contract.ts`; public discovery,
endpoint schema and `/llm` must publish the same version and policy. Deploy the
additive migration and API/Auth/Admin together through normal Cloud Run release.
No existing grant is backfilled and no production machine grant is seeded.
Consumer activation requires exact source/image/capability verification plus its
own native and human acceptance; fixture cryptography proves no installed broker,
physical machine identity, inference execution or production enrollment.

Immutable machine consent, original request, credential-operation and event
history is restricted UOA evidence and is included in canonical deletion
previews. Canonical lifecycle removal fences it; it cannot reauthorize a deleted
person/team. Expired browser transport sessions alone are pruned after one day.
This retention does not authorize product-side profile or membership copies.
