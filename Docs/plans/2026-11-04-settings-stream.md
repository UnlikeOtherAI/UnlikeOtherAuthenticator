# Versioned settings updates across devices

The user requested immediate cross-device updates for Kelpie favourites and a
reusable mechanism for all UOA settings. This authorizes an additive change-feed
extension to the historical scope of Docs/Auth/user-settings.md. UOA remains the
only settings authority. No identity/profile copy is introduced in products.

## Contract

Add authenticated WebSocket GET `/oauth/me/settings/:namespace/:key/events` for
public native clients with `settings.read`. Also expose the equivalent
`/settings/me/:namespace/:key/events?domain=...` for confidential clients through
the existing domain bearer plus X-UOA-Access-Token guards. Credentials stay in
headers, never query parameters. These are server-to-client streams; incoming
application messages close the socket. Arbitrary existing namespaces and keys
are supported, not only browser/bookmarks.

The initial frame is `{type:"settings.snapshot",namespace,key,version,value}`;
a missing/deleted key has value null. Thereafter send
`{type:"settings.delta",namespace,key,baseVersion,version,patch}`. Versions are
existing quoted canonical SHA-256 ETags. Patch is an RFC6902 add/remove/replace
subset with JSON Pointer paths. Object changes recurse; array changes use equal
prefix/suffix to emit a bounded splice as indexed removes/adds. If a patch is
larger than the replacement or exceeds 256 operations, send a snapshot instead.
A version mismatch, malformed delta, disconnect, or missed notification is
recovered by reconnecting for an authoritative snapshot. No durable history is
needed; the stream sends deltas against its last successfully written frame only.
Writes retain the existing If-Match whole-value transaction and conflict retry.

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
setting limit. A heartbeat and expiry timer close abandoned/expired sessions.

The live service currently has maxScale3, minScale1, concurrency80, 300-second
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

Unit/property fixtures exercise nested objects, JSON Pointer escaping, array
insert/remove/reorder, null/missing keys, no-op writes, size fallback and delta
base mismatch. Integration tests cover writer rollback/no notification, namespace
delete, two API replicas with one database, wrong subject/scope, token expiry and
live revocation, disconnect/reconnect, slow consumers, and coalesced load. Exercise
three signed-in client connections through the supported interfaces and check that
one mutation reaches both others without a manual refresh. Production delivery is
separate from tests and requires deployment evidence plus live verification.

## Cross-provider review

Pending. Existing Codex review has identified database capacity and Cloud Run
request timeout as required design constraints.

### Review decisions

Claude and Codex independently reviewed the plan. Accepted: cap below live HTTP
concurrency, reserve admission before queued authentication, independent live
authorization before each send, a dedicated session listener, bounded coalescing,
jittered socket recycling before the 300-second Cloud Run timeout, and snapshot
recovery. Use an AFTER-row database trigger so every committed writer is covered,
including namespace deletion; no hints contain values. No-op updates emit no hint.

For v1 use `operation:{type:"splice",index,deleteCount,items}` for a single root
array splice, or `operation:{type:"replace",value}` for other JSON/replacement.
This supersedes RFC6902 above: nested objects are replaced whole, eliminating
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
