# Enterprise SSO backend integration

The canonical design is
`Docs/plans/2026-10-17-organisation-enterprise-sso.md`. Customer activation is
gated per consuming product and organisation by the checks below. Protocol test
mode remains separate from live account admission; local verification does not
attest a customer deployment.

The current backend exposes the version1 exact-product status, assurance
validation, owner continuation/settings, scoped DNS claim, real OIDC/SAML test
and ordered revocation-feed routes documented by `/api` and `/llm`. Settings
reserve a stable connection identifier before requiring upstream credentials.
Secrets are write-only. Test callbacks cannot create/link accounts, change
membership or issue a relying-product session.

## Authority and wire

The consuming client domain and exact existing UOA organisation scope every
policy/connection. Existing multiple organisations and authorized cross-origin
membership remain intact. Initial email-domain claims use the organisation
origin unless the consuming product explicitly supports `all_active_memberships`.
That mode permits a reachable cross-origin organisation, still under its exact
consuming-client/org policy. Refusal uses `SSO_ORIGIN_DOMAIN_REQUIRED` and never
removes ordinary cross-origin access.
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
membership role array. The management initiation, browser binding and owner chooser have local API/PostgreSQL and headless browser coverage; integrated consuming-product admission remains a release gate.

Pre-authentication email-domain routing remains deferred. Provider tiles and
bookmarks use the tested relying-product start flow. There is no discovery
checkbox or writable discovery policy in the owner surface; a future discovery
endpoint requires its own explicit product and organisation consent. The unused
database column does not enable routing.

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

Cloud Run's main workflow explicitly preserves enterprise KMS configuration
through `UOA_ENTERPRISE_SSO_CONFIGURED` and `ENTERPRISE_SSO_KMS_KEY`; see
[deployment configuration](../deploy.md). Configured enterprise custody keeps
background CPU available independently of Stripe billing. This infrastructure
setting does not activate a customer arrangement or attest consumer readiness.

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
remains available independently. Bounded scheduled domain rechecks preserve the observed claim revision before applying continuity changes.

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
Recovery uses two distinct independent custodians; enforcement requires their completed setup and a successful recovery drill. Integrated live account linking, provisioning and consuming-product artifact journeys remain release verification gates.

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

Previously issued mailbox or legacy social evidence and session families are rechecked after a corporate-domain claim or stable enterprise link is introduced. They cannot establish independent authority unless their source records an actually completed personal UOA factor. Password and existing personal-factor credentials retain their independent semantics; upstream AMR is not a personal UOA factor. Public/native grants, refresh and Kelpie tickets carry and revalidate their original independent proof; see [native accounts](native-accounts.md#authentication-provenance). Confidential subject and billing assertions, chained exchange, session broker and debug redemption also invoke the registry. The launch blocker remains until the integrated consuming products pass the cross-app readiness audit.


`POST /auth/enterprise-link/context` uses the same signed consuming config and same-origin browser requirement as link completion. Body `{link_intent_id}` plus the original HttpOnly link cookie returns `{ok:true,org:{id,name},client_domain}` from the live canonical destination. It neither consumes the link nor exposes an account/profile hint. Expired, foreign-browser, changed-configuration and unavailable-connection intents fail before disclosing context.


Group mappings require `{connection_id,external_group_id,team_id,team_role}`. The owner policy write validates every provider and team against the exact organisation and consuming client. Both signed-login and SCIM reconciliation select only mappings for their authenticated source connection: an identical upstream group identifier on another provider grants nothing. Unscoped historical mapping objects fail validation rather than being assigned to an arbitrary provider. Owner GET returns only valid exact-scope mappings and `policy.invalid_group_mappings`, allowing a repair save without decoding invalid historical JSON. Saving the repaired list withdraws old sources, reconciles scoped SCIM sources and emits revocation in the same transaction.


### Existing personal authenticator management entry

An enrolled owner with no password can choose their existing personal authenticator from the UOA management sign-in surface. `POST /auth/organisation-access/personal-factor` uses the verified consuming config and accepts `{org_id,email,redirect_url?,code_challenge,code_challenge_method:"S256",state?}`. The email is an untrusted lookup hint. Eligible and unknown hints return the same `{ok:true,personal_factor_required:true,challenge,expires_at,org:{id,name},client_domain}` shape and public destination labels. An HttpOnly SameSite=Strict cookie binds the five-minute challenge to its original browser; no account-existence or principal fields are returned.

`POST /auth/organisation-access/personal-factor/verify` accepts `{challenge,code}` with the same verified config and browser cookie. It uses the shared old-TOTP verifier, six durable attempts, immutable client/org/config/context binding, and the captured credential epoch and factor fingerprint. Product policy, the active canonical owner and the existing personal factor are checked again under product, user and then challenge locks. Success records actual `personal_totp` evidence and consumes it through the existing management-intent finalizer, returning only `{ok:true,redirect_to:<UOA organisation-access fragment continuation>}`. The ordinary management exchange and live owner checks remain mandatory. This path issues no product code, refresh family, global access token or new factor, and does not relax mailbox/social admission. Expired challenges are removed by the bounded transient sweep.


### Signed artifact and action boundaries

After signature, purpose, issuer and audience validation, each credential parser checks its permitted source class and version. A signed version-one marker without proof, ambiguous source identifiers, scoped method without proof, or metadata contradicting the live original proof is rejected even below the compatibility floor. Upstream password AMR cannot relabel enterprise provenance as independent account control. Public and native tickets preserve the same original source; confidential and billing assertions resolve their scoped opaque reference before admitting exact organisation actions.

Cross-consumer broker and chained delegation currently require independent original proof. An enterprise source must authenticate for the exact target rather than become independent through delegation. Debug redemption remains within its source scope and inherits original provenance, time, deadline and revocation ancestry. All delegated expiries are capped by the source proof.

Action verification stores the original assurance identifier, exact organisation/team, signed config URL and action digest. Both creation and consumption revalidate the source under the credential-epoch lock. A new email or personal-factor confirmation authorises that action only; it does not issue independent evidence or change session provenance. A different family, scope or config must start a new challenge. Globally scoped proof-bearing tokens omit ambient organisation snapshots; exact selected scope remains mandatory for organisation authority.

The existing exact-team roster now returns `data[].orgRole` to every authorised roster reader, independently of `teamRole`. It is the active canonical membership role in that exact organisation, or null after withdrawal. This grants no additional roster entitlement or email visibility. Consumers must require active selected-team membership separately.

### Integrated verification checkpoint — 18 October 2026

The updated Auth client and SSR production build passes. All 167 Auth component tests and 22 database-backed native sign-in, native-account and organisation-management-factor cases pass against the updated SSR output. The organisation-management personal-factor browser journey also passes using actual API and PostgreSQL state.

Nessie's consumer proves exact readiness-key acknowledgement against the actual UOA endpoint: an incorrect key and acknowledgement replay are refused. Its original-source executor withdrawal and saved-authority database gates pass without copied organisation or team memberships. These checks establish their named contracts, not complete customer readiness.

Nessie's focused runtime verification now passes 56 SSO cases and 21 disclosure
cases with no skipped database cases. The disclosure fixture retains separate
original grants for one person, rejects a legacy grant with no original, and
requires an explicit new share after revocation; a healthy later login alone
cannot revive it. The actual cross-application browser journey passes at 390 and 1280 pixels,
including sign-in, HttpOnly refresh-cookie rotation, reviewed canonical cleanup,
code replay refusal and removal at the next authenticated read. Final consumer checks include the actual original-authority notification reader
and selected-team bell, count and read paths after copied memberships are removed.
The final focused API gate passes 19 cases, the worker gate nine and the reviewed
cutover gate one, all without skips; the full MCP package suite passes 554 cases
without skips. The browser journey also passes using the shipped reader-version
one cleanup path. Required CI and production preparation remain release gates.

The temporary global `LIVE_IDENTITY_FLOW_REQUIRED` hold is replaced by the actual
per-product checks: minimum assurance version one, reviewed authority-migration
and revocation-consumer revisions, and the current receiver's signed capability
acknowledgement. The exact organisation still needs its custom arrangement and
a successful test of the current connection revision. Enforcement additionally
requires two distinct custodians to confirm and drill their existing personal
factors. Nine real-PostgreSQL readiness/recovery cases verify these gates,
including attestation withdrawal, receiver-key rotation, foreign scope and a
custodian's changed credential epoch. Customer IdP interoperability and production
activation remain separate evidence; neither is asserted by local checks.

The explicit local cross-application browser evaluation is
`pnpm --dir Auth exec vitest run --config vitest.nessie.config.ts`. Set
`NESSIE_CHECKOUT` to the reviewed Nessie worktree, `NESSIE_DATABASE_URL` to a
separate migrated database whose name starts with `nessie_sso_cross_app_`, and
`PLAYWRIGHT_MODULE` to the installed Playwright entry module. Export the isolated
UOA `DATABASE_URL` for schema provisioning. Build Nessie's API and dependencies
through its normal Turbo graph first; the evaluation imports that real build and
serves its current login source with Vite on its own reserved ports 6434/6435.

The journey follows the actual UOA tile into Nessie's login screen, then its
authorize and session routes through the real UOA callback and signed HTTPS
test IdP. It checks wrong PKCE, code replay, canonical identity with no copied
membership/profile rows, actual cookie-based refresh and rotation, reviewed
cleanup of existing copies, the ordinary Channels route with cleared pending
PKCE state, and removal at the next authenticated read. Public
HTTP transport is confined to the two test applications; ordinary product
service-access billing is a separate 204 fixture. This is an explicit local
evaluation, excluded from ordinary unit tests and CI. The journey asserts actual product readiness and uses the shipped reader-version
one cleanup path with its unchanged reviewed digest. Its presence alone does
not attest any production migration or customer connection.


### Producer-first deployment order

Deploy UOA's migrations and configured enterprise signing/encryption custody first.
An authenticated platform operator then prepares the exact consuming product with
`PUT /internal/admin/enterprise/products/:domain`: set
`minimum_assurance_version: 1`, the fixed HTTPS login/config URLs, and explicit
`null` for both revision attestations until their checks have actually completed.
Verify that ordinary independent sign-in issues the scoped version-one proof
before deploying a consumer that requires it. This preparation enables proof
issuance; it does not allow customer SSO activation or enforcement.

Next deploy the strict consumer, perform its reviewed canonical-authority cleanup
and native compatibility/holder checks, and verify receiver, pull reconciliation
and use-time admission. Record the actual reviewed migration and consumer
revisions and complete the receiver's signed capability acknowledgement. Only
then enable each custom product/organisation arrangement in UOA. Connection
activation still requires its tested configuration; enforcement also requires
the independent recovery setup and drill. A missing producer preparation blocks
the Nessie rollout: do not substitute an unproven credential or pre-attest an
incomplete migration.

Withdrawing a product attestation blocks new SCIM token issuance as well as
initial enablement. Existing credentials also require the product attestations.
Receiver-key rotation alone preserves authenticated provisioning so that it can
still deprovision people while the replacement receiver is acknowledged.


### Merge verification - 21 October 2026

Maxis passes the workspace production build and all-package lint. The focused
enterprise PostgreSQL gate passes 68 cases without skips, including original
credential lineage, consumer readiness, provisioning, recovery, rotation and
ordinary-authority withdrawal. The DB-less API run passes 2,635 cases; its sole
remaining failure identified five provisioning hooks overriding the shared hook
budget. Those hooks now use the configured budget and the dedicated gate is
rerun before merge. Three unrelated opt-in cases remain skipped.

Matching owner-chooser Before/After screenshots at 390 and 1280 pixels are in
`Docs/evidence/pr-117-ui`; the local capture uses the actual base/final sources
and fixture directory responses. Required CI, producer deployment and exact
product preparation remain separate release gates.

The integration gate also exercises ordinary global access before a person has
selected an organisation. Such a credential uses the global authority check;
organisation-bound credentials keep the exact organisation check. Billing actor
and chained-resource verification use the same explicitly supplied database
authority as the surrounding service, including isolated schema tests. A missing
proof store remains an availability failure.

Ownership-transfer audits use the mutation's supplied database client, including
production RLS transactions. Refresh/lifecycle race tests bind their credential
to the organisation they exercise; separate coverage preserves unrelated global
and sibling-organisation sessions. `/org/me` returns canonical self identity even
when the caller has no organisation membership.


### Original global confidential validation

`POST /org/assurance/validate` also validates an independent original with no
organisation or team: omit both `org_id` and `team_id`, and send the same
confidential `assurance_ref` in the body and fresh product-signed subject
assertion. The assertion retains the original subject, client and credential
epoch and must omit `active`. The existing UOA access-token transport remains
available. Both paths require that credential and reference resolve to the
same original assurance, even below the legacy compatibility floor. Current
user lifecycle, credential epoch, domain role, family, ancestry and original
deadline remain authoritative. A team still requires its exact organisation.
This endpoint does not grant global control to organisation evidence, disclose
proof by public `assurance_id`, or relax another organisation route's resolver.
Deploy this producer contract before consumers that validate global originals.

### Fresh independent proof before minimum-floor enrollment

A new confidential authorization completed from current independent evidence
receives its original assurance even when the consuming product has no minimum
assurance row or remains at version zero. The evidence must still belong to the
exact person, credential epoch and client, have authorize purpose, and record
completed final authorization. Issuance consumes it once in the same transaction
as the new family. Encrypted custody must be explicitly configured; missing or
unavailable custody fails closed, never falling back to a proof-free response.

The authenticated backend token response carries `assurance_ref` and the original
absolute `assurance_expires_at`. The browser receives neither, and access/resource
JWTs never contain the confidential reference. Refresh returns that same original
proof and deadline. An existing legacy family without original evidence remains
legacy below the floor and is refused once proof is required; refresh alone
cannot manufacture or rebind provenance. SSO and recovery retain their distinct
activation and account-control restrictions. No product floor, attestation or
customer arrangement is changed by issuance or deployment.

A proof-bearing refresh family cannot move its original assurance to another
organisation/team. The team-switch grant validates that original and current
target policy under its existing locks, then returns the existing non-consuming
`403 INTERACTION_REQUIRED` before creating a successor. The product retains its
current session and restarts normal target-bound interactive authorization;
completion creates a separate exact-target family and proof. No historical
holder is rebound, no original deadline is extended, and the exact-scope ancestor
rules remain unchanged. Legacy proof-free families retain the existing switch
contract below the minimum floor.


### One-off login code response

`POST /auth/debug-login/redeem` uses the same confidential token-pair response
as `/auth/token`. A proof-bearing source produces an independent refresh family
with inherited original authentication evidence. Its HTTP response includes
`assurance_ref` and the absolute `assurance_expires_at`; these remain backend-only.
The child retains the original method, selected scope and deadline. Later refresh
returns that child's same proof and deadline, and revocation of the original
invalidates the child. Issued codes last at most 1800 seconds and cannot outlive
the source family or proof. A legacy source never gains manufactured evidence.

The PostgreSQL `debug-login-assurance.test.ts` journey issues and redeems through
the actual HTTP routes with signed config and domain authentication, validates
the returned confidential reference, refreshes it, and checks original revocation
for independent and enterprise SSO sources. Service-only assertions cannot catch
proof fields lost while serializing the HTTP response. No product config change
or native binary release is needed for this response correction.
