# Enterprise SSO backend integration

This implementation is under construction. The canonical design remains
`Docs/plans/2026-10-17-organisation-enterprise-sso.md`. Protocol test mode is
separate from live account admission. A schema or passing unit test is not
evidence that a customer deployment is ready.

The current backend exposes the version1 exact-product status, assurance
validation, owner continuation/settings, scoped DNS claim, real OIDC/SAML test
and ordered revocation-feed routes documented by `/api` and `/llm`. Settings
reserve a stable connection identifier before requiring upstream credentials.
Secrets are write-only. Test callbacks cannot create/link accounts, change
membership or issue a relying-product session.

## Authority and wire

The consuming client domain and exact existing UOA organisation scope every
policy/connection. Existing multiple organisations and authorized cross-origin
membership remain intact. Initial email-domain claims require the consuming
client to equal the organisation origin; refusal uses
`SSO_ORIGIN_DOMAIN_REQUIRED`, and never removes ordinary cross-origin access.
Claims are exact domains, not implicit wildcard suffixes; PENDING claims expire
after24hours and DNS proof values are hashed. Public suffixes and public mailbox
providers are refused. Reclaim never restores old links.

`EnterpriseProductReadiness.minimumAssuranceVersion` is server-owned, never a
signed-product-config override. Enrolled clients require backend custody
`assurance_ref` on human subject and billing assertions. UOA signed access
tokens carry only `assurance_id`. Scope/epoch/family/ancestors and current
membership/connection/policy generations are live-checked. Refresh copies
original lineage and expiry. Enterprise and recovery evidence cannot satisfy
global account control. Legacy rows have no fabricated provenance backfill.

The owner management continuation expires within two minutes and the source
independent authentication's ten-minute management window. Exchanged cookies
are HttpOnly, SameSite Strict and HTTPS Secure, with same-origin and CSRF checks.
Every mutation rechecks the live canonical owner, epoch, source family and age
after acquiring the exact enterprise-scope lock. Owner is not inferred from a
membership role array. The management initiation/browser binding and chooser
intent remain release blockers until their full interactive flow is verified.

## Protocols and provisioning

Seven preset definitions share two engines. OIDC accepts RS256, exact issuer,
audience/azp, nonce, state, signed tenant proof and present at_hash. auth_time
is never synthesized from callback time. Entra requires tid/oid and its exact
tenant v2issuer; Workspace requires signed hd. Okta and Keycloak use exact
org/realm issuer discovery. Discovery cannot authorize foreign token endpoints.
All upstream fetches are HTTPS, DNS-pinned, bounded and refuse redirects.

SAML uses `@node-saml/node-saml`, signed requests/responses/assertions, pinned
certificates, mandatory request correlation, exact issuer/audience/recipient,
bounded XML, unique IDs, strong algorithm checks and durable replay records.
Draft SAML connections generate a dedicated signing/decryption key and public
certificate on the server. Private keys stay in encrypted custody; metadata and
callback values exist before the customer registers the IdP application.
Encrypted/wrapping/comment attack integration fixtures and real vendor sandboxes
remain required before any SAML support claim.

SCIM's dedicated hashed bearer is connection-scoped. Users/Groups resources
are UOA-issued IDs; externalId is optional client metadata. Supported filters
are exact eq on id, externalId, userName and displayName. PATCH supports bounded
replace/add/remove and members[value eq "id"] removal; versions use ETags.
Unreconciled resources stay pending inside UOA, never email-autolink a person.
Disable/delete tombstones the managed source and revokes exact lineage without
deleting the global user. Immutable SSO/SCIM reconciliation, effective grant
contribution admission and recorded Entra/Okta integration remain release gates.

## Custody and operations

`ENTERPRISE_SSO_CUSTODY_PROVIDER` explicitly selects `local` or `gcp_kms`.
Each record uses a random data key and context-bound AES-256-GCM. The data key
is wrapped with the selected provider. The separate local keyring has a current
key ID and overlapping keys; the GCP provider uses a configured Cloud KMS key,
authenticated context and bounded RPC deadlines. No enterprise key is derived
from SHARED_SECRET. Cloud IAM, actual KMS operations and rotation drills still
need deployment verification. Never log plaintext credentials or keys.

Revocation mutations and their scoped event commit together. Event-producing
transactions acquire the global outbox fence before authority locks or writes,
so feed cursors describe a committed prefix. Connection events revoke only their
source assurance/families; wider events preserve unrelated organisation access
and do not increment User.tokenVersion. Feed cursors expire after thirty days.
Capture the checkpoint BEFORE a full live reconciliation and publish it only
after that walk commits, then resume the feed from the captured cursor.

Operators provision an encrypted webhook key and destination through the
machine-only internal registration endpoint. Delivery starts only after the
product acknowledges its one-time challenge with the installed key. The durable
worker signs exact JSON bytes, records successful receipts, and retries failures
with bounded backoff. Receivers accept duplicate delivery idempotently. The feed
remains available independently. Scheduled domain rechecks remain unfinished.

Remaining activation prerequisites include complete live identity linking/JIT,
all credential bridges and native/debug/broker/resource boundaries, the Nessie
authority migration and all revocation consumers, browser-bound management
initiation, deployed custody verification, actual protocol attack fixtures,
vendor sandboxes and deployed-version verification. Recovery design is still an
explicit decision, so enforcement fails closed. Do not mark readiness satisfied
on the strength of this foundation tranche.
