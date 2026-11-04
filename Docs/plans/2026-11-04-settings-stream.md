# Versioned settings updates across devices

The user requested immediate cross-device updates for Kelpie favourites and a
reusable mechanism for all UOA settings. This authorizes an additive change-feed
extension to the historical scope of Docs/Auth/user-settings.md. UOA remains the
only settings authority. No identity/profile copy is introduced in products.

## Contract

Add authenticated WebSocket GET `/oauth/me/settings/:namespace/:key/events` for
public native clients with `settings.read`. Credentials stay in headers; query
parameters are rejected. Incoming application messages close the socket. Any
existing namespace/key is supported. Native and confidential writers both
trigger updates; v1 has no unused confidential reader endpoint.

Every frame includes protocolVersion:1, namespace, key and an opaque quoted ETag
version. An initial settings.snapshot carries value (null for a missing key).
Subsequent settings.delta frames carry baseVersion and operation: either a
single root-array splice {type,index,deleteCount,items}, or {type:"replace",value}.
Use replacement when a splice is larger or the array comparison exceeds its
bound. Nested objects are replaced whole. Versions are equality tokens.

Malformed deltas, base-version mismatches and reconnects recover through a fresh
authoritative snapshot. No durable event history is required. Writes retain the
existing If-Match transaction and conflict retry contract.

## Cross-replica delivery and resource bounds

Every committed settings mutation (native or confidential, including namespace
and key deletion) publishes a PostgreSQL NOTIFY hint inside the same transaction.
The hint contains subject, namespace and key, never values or credentials. A
single dedicated pg LISTEN connection per active API process receives hints;
it does not occupy a Prisma pool slot. Connection loss triggers bounded jittered
reconnect and reconciliation. A 30-second bounded reconciliation also recovers
missed hints. LISTEN starts lazily and stops after the last subscriber leaves.

All stream authorization/value reads share one serial, coalescing queue per
process, with bounded pending work and bounded sockets (32 total, 8 per subject).
Each delivery rechecks the live credential authority and expiry before reading
and sending. Failures close the socket; no stale authorization cache grants data.
An initial post-subscription read closes the handshake race. Slow consumers close
when buffered output exceeds 1 MiB. Payloads are bounded by the existing 256 KiB
setting limit. A 30-second repair/authentication check closes expired sessions. Sockets recycle
after 240–280 seconds, before the Cloud Run request timeout.

The pre-implementation deployment inspection found maxScale3, minScale1, concurrency80, 300-second
request timeout, and unthrottled CPU. Database is db-g1-small; code/docs cap app/
admin pools at3/2. Budget one extra listener per serving process, allowing revision
overlap; do not enlarge those pools. Verify actual capacity before rollout and
stress the queue to show settings pushes do not consume parallel sign-in capacity.
Five-minute Cloud Run reconnects are normal and must be verified.

## Kelpie consumers

Swift (iOS/macOS) and Kotlin (Android) share the same wire contract. Keep the raw
settings array and ETag in memory. Apply a delta only when baseVersion matches;
validate/decode the resulting tree before publishing. Serialize push delivery with
queued mutations. Each mutation still GETs the latest value and uses If-Match;
a push must never overwrite a newer save or hide a failed save. Use a stream
generation so late frames after sign-out/account changes are discarded. Obtain a
fresh token on reconnect, retry network failures with capped jittered backoff,
resume after foregrounding, and fetch a snapshot when returning from suspension.
No background execution guarantee is claimed on mobile operating systems.

## Verification

Verify root splice/replacement round trips, size fallback, no-op updates and
strict client version/bounds validation. Exercise two real API listeners sharing
PostgreSQL, HTTP writes and direct namespace deletion, scope/subject isolation,
revocation, reconnect snapshots and admission limits. Three signed-in client
connections must also demonstrate one mutation reaching both other devices.
Local tests, deployed service checks and signed-in app verification are distinct
evidence; none substitutes for the others.

## Cross-provider review

Claude and Codex reviewed the design before implementation. Database capacity
and Cloud Run request timeout are explicit constraints.

### Review decisions

Claude and Codex independently reviewed the plan. Accepted: cap below live HTTP
concurrency, reserve admission before queued authentication, independent live
authorization before each send, a dedicated session listener, bounded coalescing,
jittered socket recycling before the 300-second Cloud Run timeout, and snapshot
recovery. Use an AFTER-row database trigger so every committed writer is covered,
including namespace deletion; no hints contain values. No-op updates emit no hint.

For v1 use `operation:{type:"splice",index,deleteCount,items}` for a single root
array splice, or `operation:{type:"replace",value}` for other JSON/replacement.
Nested objects are replaced whole, eliminating
three custom JSON Pointer interpreters. Both clients strictly validate the base
version, type and bounds with shared fixtures. Versions stay opaque; copying JS
number/canonical hashing into native code is rejected as unnecessary complexity.
The sender derives the operation from authoritative snapshots and tests verify
round trips. A malformed delta never becomes mutation input: writes always GET
the latest authoritative array before applying intentions.

Keep the native reader endpoint only in v1; it supports any existing settings
namespace/key through settings.read. Both native and confidential writers trigger
updates. A confidential reader can be added with an actual backend consumer; no
unused parallel credential stream is introduced. Each read reruns token/client
binding outside its transaction, then authorizes and reads inside one transaction.
A verified native-app revision is already checked by getOAuthClient; the additional
reverification also covers scope changes.
