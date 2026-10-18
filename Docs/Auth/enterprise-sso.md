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


### Recovery contacts

The canonical owner remains the only owner. Recovery uses two distinct active
organisation members; the owner may be one of them. Both must already have a
personal authenticator. Designation pins each factor fingerprint and credential
epoch, so factor replacement, global reset, inactive membership or account
deletion withdraws recovery authority. No mailbox challenge or new enrollment
can substitute for the pinned factor.

Owner `GET /auth/organisation-access/sso/recovery` returns revision, contact
statuses, confirmation/drill times and canonical member candidates with
eligibility. Candidates paginate by `cursor` in pages of 100. `PUT` with
`{revision,custodian_user_ids:[id,id]}` replaces the contacts while enforcement
is off and returns their recovery URLs once. The URLs are address hints, not
login credentials. An unconfirmed invitation expires after seven days.

Each contact opens `/auth/organisation-recovery#contact=<opaque>` and submits
`POST /challenge {contact,purpose}` for `confirm`, `drill` or `recover`.
The response contains an opaque challenge, organisation name, exact `client_domain` and expiry;
a Strict HttpOnly cookie binds the initiating browser. `POST /complete
{challenge,code}` verifies the original personal authenticator and consumes
the exact action. Challenges last five minutes and permit six durable guesses.
Successful confirmation and a separate successful drill by both contacts are
required before enforcement can activate. Drills are current for 30 days.

Either confirmed contact can perform the narrow emergency action: turn off
enforcement and suspend connections for that exact organisation and consuming
product, revoke its provisioning tokens, withdraw its managed memberships and
publish scoped revocation in the same transaction. This issues no product or
global-account session, changes no owner, and affects no sibling organisation.
Immutable action evidence records recovery provenance with global account
control explicitly false. The customer surface must provide setup, contact
confirmation, drill and emergency suspension before this flow is ready.

### Domain continuity and transient retention

Verified domain TXT records are rechecked at six-hour intervals by the bounded
enterprise maintenance worker. Three failed checks, or a failed check after
24 hours without a successful verification, mark the claim `LAPSED` and suspend
only identities originally admitted through that claim. Managed source grants
and scoped revocation change atomically. Independently linked identities are
unaffected. JIT and existing claim-backed proof use also require a successful
verification within 24 hours, so an unavailable scheduler cannot extend trust.
DNS queries have a three-second deadline and bounded records. Owner reissue
supports `LAPSED`; fresh proof does not automatically resurrect suspended people.
Historical `verified_at` remains intact, with `last_verified_at`, `checked_at`
and `failure_count` describing current continuity.

Cross-origin claims are accepted only when the existing server-owned product
policy permits all active memberships; origin-only clients retain isolation.
An expired pending verification is persisted as `EXPIRED` before returning its
error. Maintenance expires pending claims and removes at most 200 records per
transient class per tick. It preserves live account-link children of expired
protocol flows and source evidence still referenced by authorization artifacts.
Stable identity links, provisioning tombstones and erasure hashes are excluded
from transient pruning. Recovery action evidence is retained for 90 days.

Debug sign-in derives a child assurance from its live source family. The child
retains the source method, connection, authentication time (including an unknown
time), observed time and factor provenance. Its family and grant cannot outlive
the source proof; source revocation invalidates the child. A product requiring
assurance refuses a pre-assurance family before a debug grant is created.


### Metadata and credential rotation

Owner `POST /auth/organisation-access/sso/connections/:id/metadata/parse {xml}`
parses at most 256 KiB of pasted or locally uploaded IdP metadata. It returns
`{ok,configuration:{entity_id,sso_url,certificates}}` without saving configuration
or fetching remote URLs. Only one entity, one IdP descriptor and one unambiguous
HTTPS Redirect endpoint are accepted. External entities, ambiguous issuers and
invalid or weak signing certificates are refused. Tenant and subject mappings
remain explicit owner configuration.

`POST /credentials/rotate {revision,secret}` replaces an OIDC secret;
`{revision,certificates:[PEM]}` replaces SAML IdP trust with up to three overlapping
RSA certificates. The stable connection, issuer, tenant, client ID and subject
mapping do not change. A durable activation marker prevents a later test or
suspension from reopening identity configuration. RSA signing keys are bounded
to 2048–8192 bits and certificates must be suitable for current use.

SAML SP keys are generated and sealed by UOA. `POST /sp-key/prepare {revision}`
publishes the next signing and encryption certificates beside the current ones.
After an owner test, `/sp-key/activate` switches the active key while retaining
the previous decryption key. Test again, then `/sp-key/retire` removes overlap.
At most two context-bound key pairs are accepted for at most 14 days. The
maintained [node-saml metadata contract](https://github.com/node-saml/node-saml#service-provider-metadata)
publishes signing certificates; UOA also publishes both encryption certificates
and bounds full-signature-verified decryption attempts during overlap.
Request-cache removal is committed after those attempts, including failure.

These actions return the redacted connection with `sp_key_state` (`current`,
`prepared`, `overlap`) and `key_overlap_expires_at`. Private keys and client
secrets never appear in responses or audit data. Every credential change advances
the connection revision and invalidation generation, invalidates previous proof,
and requires a successful owner test before new product sign-ins resume.
Access JWT expiry and the returned `expires_in` are also capped to the exact
authoritative assurance deadline, including when it is shorter than the product
access-token setting. An invalid or expired deadline cannot issue a token.

### Receiver capability acknowledgment and protocol verification

The authenticated `POST /domain/revocation-consumers/ready?domain=...` body is
`{key_id,challenge,proof,capabilities:{version:1,feed:true,reconciliation:true,
use_time_assurance:true,immutable_custody:true}}`. Both objects are strict.
The existing `uoa.revocation-ready.v1` HMAC input remains unchanged; domain
authentication and TLS bind the capability declaration to the consuming client.
Only a verified acknowledgment stores capability version 1. Re-registration or
rotation resets it to 0 and disables delivery until the new challenge is proved.
`enterpriseRevocationReady` requires an enabled receiver, acknowledgment timestamp
and version 1. Product revision strings cannot substitute for that state.
Activation, new enterprise sign-ins and new provisioning tokens require it.
Existing authorized provisioning remains available during receiver rotation so
deprovisioning cannot be delayed by transport maintenance.

Focused protocol tests include an actual local HTTPS OIDC provider implementing
discovery, authorization codes, client authentication, PKCE, RSA token signing
and mixed-key JWKS. Only the test outbound transport trusts its isolated private
certificate; production TLS, public-address resolution and redirect refusal are
unchanged. Cryptographic SAML fixtures sign both response and assertion, encrypt
to current or overlap keys, and use the real persisted request/replay cache.
These engine tests complement the real API/PostgreSQL and headless customer
journeys; they do not replace the final credential-route coverage audit or
establish compatibility with an untested customer IdP configuration.



### Credential route admission

`credential-route-registry.service.ts` dispatches source validation and exact target policy checks. The configured human access verifier defaults to global account control; only explicitly requested organisation access applies that organisation's SSO policy. An independent global operation does not become an organisation operation merely because its access token remembers a selected team.

Signed chooser and login-factor capabilities revalidate their original authentication evidence before use. Login-bound factor enrollment requires independent evidence. Personal settings enrollment continues to require its independently validated global access token. Signing continuation reads and signature writes revalidate the original evidence under the authorization locks before exposing documents or accepting a signature. A signed `sso`, `sso_recovery`, or `recovery` method without its source proof is rejected even below the legacy minimum. Revocation, expiry, credential epoch changes and foreign client scope therefore end these continuations rather than minting new proof.

Previously issued mailbox or legacy social evidence and session families are rechecked after a corporate-domain claim or stable enterprise link is introduced. They cannot establish independent authority unless their source records an actually completed personal UOA factor. Password and existing personal-factor credentials retain their independent semantics; upstream AMR is not a personal UOA factor. Public/native grant and bridge propagation remain part of the registry audit, so the launch blocker remains in force until their live paths and consuming products pass that audit.


`POST /auth/enterprise-link/context` uses the same signed consuming config and same-origin browser requirement as link completion. Body `{link_intent_id}` plus the original HttpOnly link cookie returns `{ok:true,org:{id,name},client_domain}` from the live canonical destination. It neither consumes the link nor exposes an account/profile hint. Expired, foreign-browser, changed-configuration and unavailable-connection intents fail before disclosing context.


Group mappings require `{connection_id,external_group_id,team_id,team_role}`. The owner policy write validates every provider and team against the exact organisation and consuming client. Both signed-login and SCIM reconciliation select only mappings for their authenticated source connection: an identical upstream group identifier on another provider grants nothing. Unscoped historical mapping objects fail validation rather than being assigned to an arbitrary provider. Owner GET returns only valid exact-scope mappings and `policy.invalid_group_mappings`, allowing a repair save without decoding invalid historical JSON. Saving the repaired list withdraws old sources, reconciles scoped SCIM sources and emits revocation in the same transaction.
