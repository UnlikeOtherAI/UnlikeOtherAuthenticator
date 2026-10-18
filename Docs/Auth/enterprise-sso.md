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
worker signs exact JSON bytes and requires a JSON acknowledgement containing
`ok: true`, `version: 1` and the exact `event_id` before recording a receipt.
Progress writes bind the captured encrypted key, destination and readiness
acknowledgement, so re-registration cannot inherit an old in-flight success.
The worker retries failures
with bounded backoff. Receivers accept duplicate delivery idempotently. The feed
remains available independently. Scheduled domain rechecks remain unfinished.

Remaining activation prerequisites include complete live identity linking/JIT,
all credential bridges and native/debug/broker/resource boundaries, the Nessie
authority migration and all revocation consumers, browser-bound management
initiation, deployed custody verification, actual protocol attack fixtures,
vendor sandboxes and deployed-version verification. Recovery uses two independently authenticated custodians, with one canonical
owner and no backup codes. Its tested drill remains a gate, so enforcement
fails closed until that implementation and evidence exist. Do not mark readiness satisfied
on the strength of this foundation tranche.

## Authentication evidence and owner entry

Primary verification records immutable authentication evidence with the original
observed and authenticated times. Signed chooser, TOTP, forced-enrollment and
signature artifacts carry its identifier; the authorization code stores it.
Code exchange consumes it once and derives the product-family assurance without
rebasing authentication time. Managed-identity mailboxes cannot reset or add a
global password, or mint independent mailbox-login evidence.

The product management-continuation endpoint returns an `/auth` entry hint with
`flow=organisation_management`, `management_org_id`, the verified source config,
and a server-generated S256 challenge/state. It grants no authority. Its verifier
is discarded: an accidental product-code path cannot finish at the relying party.
The owner authenticates again in UOA. Password and login-code flows hold the team
chooser even for a single team when the management hint is present.

The chooser posts `login_token` and `org_id` to
`/auth/organisation-access/start` with the existing signed-config query. It consumes
the chooser once, rechecks canonical ownership, creates an HttpOnly browser-bound
intent, then uses the existing personal TOTP or enrollment verifier. Finalization
consumes the original evidence into an exact-purpose management child and mints a
fragment continuation. Exchange requires the initiating browser nonce. No product
code or refresh family is created. Lost ownership returns
`SSO_MANAGEMENT_ACCESS_WITHDRAWN`; expired or unsuitable proof returns
`SSO_MANAGEMENT_REAUTH_REQUIRED`.

Custom arrangements are enabled only by the UOA operator for the exact
`(client_domain, org_id)` policy through the machine-only arrangements endpoint.
Owners may prepare drafts while disabled; activation requires the arrangement and
all technical readiness. No subscription tier or new billing system is involved.
Recovery selection is delegated to implementation; enforcement still requires
completed independent custodians and a successful recovery drill. Live SSO
linking/provisioning and some artifact consumers remain unfinished release gates.

Provider callback receipt is an observation, not an authentication timestamp.
Local password/OTP verification records its actual factor time; a social provider
without a validated signed authentication time records `authenticatedAt: null`.
The unknown value survives token-family derivation. Sensitive owner management
requires a fresh independently verified primary event or an existing UOA TOTP
factor. A recent social callback cannot enroll a new factor and use that new
factor to manufacture independent freshness.

UOA owner management requires personal authentication independently of the consuming product's 2fa_enabled setting. Only a verified management-purpose challenge may continue through /2fa/verify when ordinary product 2FA is disabled; live owner, browser intent and authentication evidence checks still apply at finalization.

## Ordinary authority mutations

Organisation/team removals and role changes, ownership handover, organisation
factor-policy changes, lifecycle suspension/deletion and global password/factor
resets share the durable enterprise outbox. The outer effect transaction takes
its feed fence before policy/user/row locks; nested service calls keep that same
transaction. The mutation, scoped assurance/family revocation and event either
commit together or all roll back. Membership writes use the authenticated admin
effect boundary because the tenant RLS role cannot write the revocation ledger.

An organisation/team change notifies each actual consuming domain found on that
exact scope's assurances and refresh families, including authorized cross-origin
consumers. Other organisations, even on the same origin, retain their sessions
and credential epoch. A global credential reset instead advances the user's
epoch and notifies all affected consumers. Origin-only legacy sessions are not
misrepresented as references to a particular organisation. Ordinary events use
revision1; the durable sequence and unique event ID order them, and consumers
revalidate the original proof rather than comparing that number as a policy age.

Mailbox admission also protects existing, not-yet-linked accounts whose email
belongs to any previously verified enterprise domain, including lapsed/revoked
claims. Domain control cannot first reset a global password and then present it
as independent linking proof. The legacy social adapter has no stable provider
subject, so its email match and best-effort identity audit cannot bypass this
fence or overwrite the account profile. Ordinary unclaimed-mailbox behaviour is
unchanged; full social-provider subject migration remains separate.

The focused real PostgreSQL `enterprise-ordinary-authority.test.ts` gate checks
failed-write rollback, exact-org sibling preservation across consuming domains,
global epoch propagation and the pre-link corporate-mailbox takeover boundary.

### Scoped live entry and membership sources

The operator registers each consuming product's fixed HTTPS login initializer
and canonical signed configuration URL through
`PUT /internal/admin/enterprise/products/:domain`. Its compatibility revisions
record the authority migration and webhook plus feed/reconciliation consumers.
The assurance minimum is monotonic. A connection tile at `/sso/:id/start` returns
to that registered login initializer with a random, two-minute, one-use
`sso_intent`. The relying product creates its own fresh state and PKCE verifier,
then forwards the intent through its normal UOA `/auth` request. UOA refuses a
different client, configuration source, connection revision or generation.
Owner protocol testing never enters this relying-product flow.

The live callback revalidates signed product configuration and exact connection
and policy generations. Known identities resolve only by the stable connection,
issuer, tenant and subject tuple. An email match enters explicit account-link
proof; it never selects or mutates that existing person. New JIT identities need
an active verified domain claim and explicit JIT/default-team policy. They have
no password and their evidence remains scoped SSO evidence with the original
nullable upstream authentication time and bounded session deadline. Existing
accounts complete a separate independent proof before linking. Activation remains gated until recovery and provisioning readiness is complete.

Manual, SSO and SCIM membership contributions are separate sources. Replacing
one source does not overwrite another. Ordinary manual deactivation/removal
records a suppression tombstone that managed sources cannot clear. Aggregate
writes cannot silently become manual grants. Database constraints reject owner
mapping and foreign-organisation team references. A scoped SSO chooser exposes
only its exact organisation and cannot accept invitations, create teams or
present owner-management authority from that organisation's IdP evidence.

### Existing account link proof

A pending link redirects to `/auth?flow=enterprise_link` with
`enterprise_link_intent` and the original relying-product state, redirect and
PKCE challenge. An HttpOnly Strict `uoa_sso_link` cookie binds the original
browser. The intent identifier grants no authority by itself. The normal
password endpoint accepts that hint and always returns a chooser proof rather
than silently completing a one-team product login. The client submits
`POST /auth/enterprise-link/start {link_intent_id,login_token}` with its verified
configuration. A fresh existing password is sufficient only when that person
has no enrolled personal MFA; enrolled MFA must still be completed.

For a person with only an existing personal authenticator, submit
`POST /auth/enterprise-link/personal-factor {link_intent_id,email}`. Both known
and unknown hints return `{ok:true,personal_factor_required:true,challenge,
expires_at}` with a random opaque challenge. No canonical subject or epoch is
returned. Submit the existing authenticator code to
`POST /auth/enterprise-link/personal-factor/verify
{link_intent_id,challenge,code}`. Challenges expire within five minutes, remain
bound to the browser and exact link, and permit six guesses. Incorrect guesses
commit their count; exhausted, unknown and unsuitable accounts receive the
same generic refusal. New factor enrollment cannot prove a link.

A successful proof consumes the intent and independent proof together with the
stable identity link and normal SSO continuation. It returns
`{ok:true,redirect_to}`. The final product evidence remains SSO-scoped and keeps
the original upstream authentication time, including unknown time. A separate
verified personal factor marker may satisfy UOA MFA; upstream AMR never becomes
that marker. SSO and recovery sources cannot enter global TOTP enrollment.

### Scoped provisioning and erasure

SCIM is enabled by a UOA custom arrangement and an explicit per-connection
owner switch. It has no product subscription gate. The product must acknowledge
authority migration and revocation consumers before tokens are accepted.
The owner uses `/auth/organisation-access/sso/connections/:id/scim` to inspect
transport state, token metadata, pending resources and already linked stable
identities. `POST /state {revision,enabled}` changes transport state;
`POST /tokens {}` returns a token once, and `DELETE /tokens/:tokenId` revokes
that exact token. At most two unexpired tokens overlap for rotation.

Incoming User resources remain unbound until the owner submits
`POST /reconcile {resource_id,external_identity_id,version}`. The selected
external identity must already have independent account-link proof. User names,
email addresses, group names and external IDs never select canonical people.
The resource-to-identity binding is immutable, including after deletion.
Groups refer only to User resource IDs in the same connection. Group mappings
grant member or team-admin authority; they cannot grant ownership.

The protocol supports bounded User/Group CRUD, equality filters, pagination,
attribute projection, weak ETags, sequential PATCH and Entra member-list removal.
Its dialect follows [SCIM HTTP](https://www.rfc-editor.org/rfc/rfc7644.html) and
[Entra provisioning](https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups).
Updates recheck bearer authority inside the same transaction as reconciliation.
Deactivation and deletion withdraw only the matching managed sources and emit
scoped revocation atomically. Independent manual grants survive. Manual removal
suppression survives future provisioning, and canonical deleted people cannot
be reactivated by the provisioner. Disabling the transport revokes tokens;
disabling the connection also withdraws its managed membership contributions.

The lifecycle ERASE seam is `eraseEnterprisePerson(userId, tx)`, called before
canonical hard deletion under the existing outbox, product and user locks.
It removes private link/evidence data, scrubs provisioning attributes, and keeps
only the stable inactive SCIM resource ID and an append-only hash of the upstream
connection/issuer/tenant/subject tuple. Subsequent admission refuses that tuple.
It never deletes lifecycle jobs or receipts. RETAIN preserves the canonical
deleted person and suspends their stable external links.
Both seams run inside the existing lifecycle sweep after the canonical person
becomes terminal and before any hard delete. ERASE also scrubs enterprise links
when protected financial evidence requires a terminal canonical stub to remain.
