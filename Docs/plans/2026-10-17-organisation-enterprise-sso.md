# Organisation-level enterprise SSO — implementation plan

**Status: implementation in progress; customer activation remains gated.**
The implementation branches do not establish deployment or closure of all
review findings. The activation gates below still apply.

This revision replaces the working `org-sso-plan.md` supplied for review. Its
reported Fable review contained 19 findings; §15 preserves their traceability.
This revision is a documentation and code-boundary audit, not a fresh Fable
review or a claim that the findings have passed implementation tests.

Code evidence was inspected in UOA at `05ffc0e6e74b72316ed23822ab7aabf7e9bd807e`
and the Nessie checkout at `ca6425a47ed87bb9dcc3bbe9b3ea7d6d363b1185`. Paths below
are relative to the named repository. Recheck them before implementation;
line numbers from the earlier draft are not current evidence.

**Confirmed product decisions:** enterprise SSO is enabled and managed only in
UOA. It sits outside Nessie billing: no Nessie plan, subscription or paid-tier
gate is added. SSO and SCIM use custom commercial arrangements for now, managed
in UOA. Nessie provides live status and an in-context
UOA settings link, never its own enablement switch. Administration must be
simple and intuitive (§6.8). Self-hosted arrangements are managed internally;
contractors on unverified domains are off by default. Recovery uses two narrow,
independently authenticated custodians, while UOA retains one canonical owner
and its prohibition on backup codes.

**Do not activate customer SSO until the account-authority boundary, exact
session-assurance contract, Nessie identity migration and credential revocation
gates in §9 have passed.** The product decisions are recorded in §12.

## 1. Goal and scope

A customer organisation connects its identity provider to UOA. Its people enter
Nessie through that connection, and UOA remains the sole durable authority for
human identity, authentication factors, profiles, organisations, teams,
membership and invitations.

Nessie retains stable UOA subject, organisation and team references plus
product-specific data. One UOA organisation binds to one Nessie org-tenant; one
UOA team binds to one Nessie team. Teams remain independent data boundaries,
including for organisation owners and admins. No shared local container may
flatten several UOA organisations. An install without an identity provider keeps
one unbound org-tenant.

The enterprise connection is scoped to an exact **consuming client domain and
UOA organisation**. Several connections may exist for that pair. A connection
is not an unrestricted login method for every product using the same UOA user.
An independently configured connection in another product may use the same IdP;
it must not cause UOA or Nessie to duplicate an existing organisation.

This needs a correction to the previous draft's reading of current UOA:

- `Organisation.domain` and `@@unique([domain, slug])` still exist. The old
  `org_members_one_active_org_per_domain` index was **dropped** by
  `20260901090000_allow_multiple_organisations_per_user`. Multiple ACTIVE
  memberships, including on one origin domain, are supported. The schema's
  old field comment is stale; exact `(orgId, userId)` uniqueness remains.
- The origin domain is not a universal product-access boundary.
  `getActiveClientOrgContext` can resolve an exact organisation across origins
  when the server-owned product policy is `all_active_memberships`.
- Therefore preserve authorized multiple memberships and exact-org uniqueness.
  JIT may add an authorized membership without moving the person out of
  another organisation. Do not reinstate the retired uniqueness constraint,
  remove legitimate cross-origin selection, or infer a move from sign-in.
- Every SSO policy check must name both the consuming client domain and selected
  organisation. Connection ownership, domain-claim uniqueness and enforcement
  must agree on this pair. The product/domain binding is verified server-side;
  a browser cannot opt into cross-product access.

In scope: OIDC and SAML 2.0 engines; seven launch presets; verified email domains;
optional discovery and enforcement; JIT; optional SCIM 2.0; group-to-team/role
mapping; the existing UOA MFA policy; bounded deprovisioning across all Nessie
credentials; reachable settings, recovery and audit surfaces.

Out of scope: direct LDAP, Kerberos or WS-Federation; consumer identity changes;
Nessie-to-customer-IdP authentication; a cross-product connection object;
automatic organisation moves; migration of existing social `AuthIdentity`
subjects; vendor presets without evidence. LDAP/AD customers need an OIDC/SAML
gateway. Ordinary non-UOA self-hosted authentication is a separate mode and
must not be used as a fallback for a UOA-bound tenant.

## 2. Authority and architecture

```text
Customer IdP
  OIDC or SAML, exact tenant and stable subject
        |
UOA enterprise connection (consuming client domain, org ID)
  UOA-owned identity, membership, assurance and revocation
        |
Existing signed product configuration and UOA token exchange
  plus an explicit, authenticated assurance reference
        |
Nessie
  stable UOA references + product extensions
  live UOA identity/entitlement reads; bounded in-memory reuse only
```

UOA authority is an existing user instruction, not a pending permission to make
a second identity store. Using UOA as the enterprise broker follows that rule.
The self-hosted packaging commitment is a separate product decision (§12).

A connection's credentials authenticate UOA to the customer's IdP. They are
envelope-encrypted, write-only and rotatable. They are not product-client OAuth
secrets or browser configuration. Amend the historical “no per-client OAuth
secrets” wording narrowly before introducing this credential class.

Nessie may hold an encrypted, scoped, rotating **UOA-issued** refresh token or
opaque session handle needed to act as a relying party. That exception permits
session custody; it does not permit copied profiles, local passwords, durable
membership mirrors or customer-IdP credentials in Nessie.

An enterprise IdP controls its connection's assertions. Even after explicit
account linking, that authority must not silently become authority to reset the
person's global UOA credentials, read unrelated products, acquire platform
administration or add further login methods. Preserve enterprise provenance on
every derived session and delegation (§6.3, §6.5). This isolation is required
before the first real enterprise login, including when enforcement is off.

## 3. Current state and verified gaps

### UOA

The schema and services inspected above show:

- Existing email/password, magic-link/email-code and social paths. The social
  route imports Google, Apple, Facebook, GitHub and LinkedIn, not a shipped
  Microsoft enterprise implementation. Native policy currently allows
  `email_password` and `google`.
- `AuthIdentity` is unique per user/provider, and `login-log.service.ts` still
  writes email as `providerSubject`. `social/social-login.service.ts` links by
  verified email. Global and per-domain users are distinguished through
  `buildUserIdentity`/`userKey`; email alone is not globally unique in the
  schema. Do not reuse social resolution for enterprise SSO.
- The September migration drops the July active-membership partial index.
  `Docs/brief.md` §24.14 explicitly supports multiple organisations. Historical
  migrations and stale schema comments must not be read as current constraints.
  JIT still must not deactivate or transfer any existing membership.
- `org-context.service.ts` exposes `getActiveUserOrgContext`,
  `getActiveClientOrgContext` and `getUserOrgContext`. The first performs the
  underlying lookup; the client wrapper can enable exact cross-origin context
  through `product-team-policy.service.ts`. All three call paths need coverage.
- Context consumers include code exchange/refresh, team switch, confidential
  and chained token exchange, session broker, debug-login redemption, native
  OAuth and subject-assertion `/org/me`. Other membership-sensitive `/org/*`
  routes also need inventory; reading a context is not every authorization path.
- `RefreshToken` contains `twoFaCompleted`, `credentialEpoch`, `orgId` and
  `teamId`, but lacks the enterprise connection/provenance proposed here.
  `User.tokenVersion` is a global credential epoch, **not a family identifier**.
  It cannot recover which SSO login authorized a product-signed assertion.
- Existing scoped revocation helpers include
  `revokeRefreshTokenFamiliesForUserOrganisation` and
  `revokeRefreshTokensForUserDomain`. Their callers and legacy-null bindings
  must be audited before promising exact connection revocation.
- Reusable foundations: `utils/ssrf.ts`, the pinned JWKS fetcher,
  `OrgAuditLog`, `Organisation.twoFaPolicy`, allowed-email restrictions, the
  team-switch grant, live lifecycle gates and canonical ownership transfer.
- `Organisation.ownerId` is canonical. `organisation.service.members.ts`
  refuses ordinary assignment of `owner`; `organisation.service.ownership.ts`
  transfers ownership and demotes the outgoing owner. Two independent owners
  cannot be assumed available for recovery.

The corporate-domain plan dated 2026-08-20 is marked **Proposed — reviewed by
Kimix**. It specifies `OrganisationEmailDomain` and an Auth management
continuation, but that is not evidence that either is shipped. Microsoft/SCIM
requirements and parts of the ReBAC brief describe aspirational or conflicting
models, including a now-retired one-org placement rule. Resolve those conflicts
explicitly in §14 before coding their contracts.

### Nessie

`api/src/services/team-principal.ts` currently:

- resolves a non-UOA principal by email without excluding `uoaSub` rows;
- adopts an unbound email row into a UOA subject on a subject lookup miss;
- creates durable UOA-derived `email`, `displayName` and `avatarUrl` fields;
- calls `syncProfileMirrorFromClaims` and projects organisation/team/project
  memberships; a missing role claim can make a first materializer an owner.

**These are existing authority violations or takeover risks, not patterns this
plan endorses.** A non-UOA login must never authenticate a UOA-bound principal.
Email adoption and first-materializer ownership cannot replace UOA proof. The
correct remedy is a live API boundary and reviewed migration (§8), not a new
email update/merge path. Nessie's `docs/standards/team-model.md` already records
durable profiles and membership projections as migration gaps.

`api/src/services/external-auth.ts` uses a public-client path for generic
OIDC/custom providers; the earlier draft's claim that this is secure end-to-end
is not established. SAML being present in a configuration schema is not a
working SAML integration.

`assertUoaSessionAdmission` checks the exact external organisation, live UOA
authorization and `admitsUoaSelectedTeam`. Nessie's product team enablement is
an additional product gate; UOA membership alone does not enable a Nessie team.
The people-directory migration has bounded in-memory UOA reads, but that does
not mean all profile or authorization consumers are migrated.

Sessions are not the whole credential inventory. MCP agent credentials can live
90 days and use local `User.tokenVersion`; device tokens, executor host sessions,
personal delegations/enrollments, trigger personal authorizations and queued work
also need admission and revocation. `AuthSession` and local `RefreshToken` do not
themselves identify an organisation; `UoaSessionCredential` carries the UOA org
binding. A revoke-by-user update would cross tenant boundaries. Audit each
credential's actual lineage and consumers before adding the event receiver.

Existing user-facing interaction codes include `INTERACTION_REQUIRED` and
`SSO_TEAM_REAUTH_REQUIRED`. Reuse them where their semantics fit; their existence
does not establish the new assurance or redirect contract.

## 4. Protocol engines and presets

Two generic engines own validation. Presets supply validated defaults,
tenant/subject rules, explicitly supported options and setup instructions.
There are seven launch entries: **Entra ID, Okta, Google Workspace, Keycloak,
AD FS, Other OIDC and Other SAML**. “Generic” does not promise compatibility with
every deployment or insecure legacy configuration.

| Preset | Protocol | Stable subject and tenant boundary | Provisioning evidence needed |
|---|---|---|---|
| Entra ID | OIDC v2; SAML variant after its tests | Required `tid` and `oid`; key contains both. Exact tenant issuer, no `common`/`organizations`. Guests remain resource-tenant subjects. | An explicitly configured SCIM object-ID mapping, not an assumed `externalId` convention. |
| Okta | OIDC or SAML | Exact org/custom-server issuer and stable `sub`, or validated persistent SAML identifier. Server/client changes can change identifiers. | Confirm each app template's SCIM-to-SSO mapping; never assume all `sub` values equal Okta IDs. |
| Google Workspace | OIDC or SAML | OIDC requires signed `hd` in the configured hosted-domain set plus `sub`. The request's `hd` hint and email suffix are not checks. SAML uses its own exact entityID and stable signed identifier. | No generic SCIM capability is promised; verify the chosen deployment. |
| Keycloak | OIDC or SAML | Exact realm issuer/entityID and immutable configured subject. | Confirm configured mappers and any SCIM extension before enabling reconciliation. |
| AD FS | SAML | Exact entityID; persistent NameID or immutable configured attribute, not mutable UPN/email. | No SCIM support is assumed. |
| Other OIDC | OIDC | Exact issuer plus `sub`; a shared issuer requires an additional signed tenant discriminator. | Customer setup must demonstrate a stable mapping. |
| Other SAML | SAML | Exact entityID, stable signed subject, additional tenant discriminator if entityID is shared. | Customer setup must demonstrate a stable mapping. |

Entra's `email`/`preferred_username` are mutable and unsuitable as identity
keys. Google requires checking the returned `hd` claim for a hosted-domain
restriction. These distinctions are documented by the
[Microsoft claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference)
and [Google OIDC guide](https://developers.google.com/identity/openid-connect/openid-connect).

Requirements retained from the source review:

- **R1:** two engines, seven initial presets. Further Ping, OneLogin,
  JumpCloud, Duo, CyberArk, IBM, Oracle, SAP IAS, Authentik, ZITADEL, Rippling
  and Shibboleth/eduGAIN coverage requires sandbox evidence.
- **R2:** subject keys never use email. Subject mapping, issuer, tenant,
  OIDC client/sector and SAML SP identity are identity-affecting configuration.
  Lock them after activation; changing them requires an explicit migration.
- **R3:** tenant pinning is mandatory on every assertion, even when contractors
  are admitted. A preset cannot disable it. No v1 Entra or SHA-1 compatibility
  switch ships implicitly.
- **R4:** email is an attribute and routing hint; existing-account linking
  requires §6.3 proof.
- **R5:** groups map to existing UOA teams and permitted roles, never UOA
  `Group` rows or automatic new teams. Missing/incomplete groups cannot prove
  removal and never downgrade an explicit human grant.
- **R6:** JIT is available only where enabled and authorized. SCIM is optional;
  JIT never resurrects a deprovisioned member.
- **R7:** MFA uses existing UOA requirement policy and connection-specific
  verified evidence or an explicit attestation; no vendor-wide magic string.
- **R8:** SAML accepts a bounded set of trusted signing certificates with
  controlled overlap rotation, metadata checks and expiry alerts.
- **R9:** use SP-initiated tiles/start URLs. Unsolicited SAML is deferred until
  a separately tested login-CSRF design exists; a confirmation click alone is
  not proof of account possession.
- **R10:** all customer-controlled network destinations are SSRF inputs (§7).

## 5. Data model and invariants

Names below are proposed, not existing API/schema names. All new writes use
current UOA transaction, locking, RLS and audit conventions. Bind relations
structurally so a connection, domain claim, mapping or token cannot point at a
different organisation/product pair. Add migration preflights, bounded locks
and explicit conflict reports; never edit applied migrations.

### Domain claims and policy scope

Reuse `OrganisationEmailDomain` from the corporate-domain proposal, not a
parallel ownership table. Its original scope derives `domain` from the org's
origin. Before extending it to cross-origin consuming products, amend that
proposal and its constraints together. Initial activation may be restricted to
origin-domain pairs until the exact cross-product claim authorization has been
implemented; that restriction must be visible, never worked around by copying
an org. An authenticated cross-origin member keeps existing non-enterprise
access until an explicit supported SSO policy applies.

For each supported claim scope, permit one current claim per exact normalized
email domain while `PENDING` or `VERIFIED`. Use IDNA normalization, explicit
subdomain matching, public-suffix/public-mail exclusions, expiring DNS TXT
challenges, hashed proof and audited reissue/revoke. Pending claims expire so
they cannot squat indefinitely. Recheck verified claims daily; define the
failure threshold, retry window and maximum freshness before rollout. Reclaim
does not reactivate old links. `allowedEmailDomains` remains an independent
restriction; verification does not edit that list.

Store enterprise policy by `(clientDomain, orgId)` rather than blindly adding
product-specific enforcement to a global `Organisation` row. Existing org
`twoFaPolicy` remains the requirement source. Proposed policy fields:

- `ssoEnforcement`: `off`, `required_for_verified_domains`,
  `required_for_all_members`;
- discovery opt-in and an explicit default routing connection, or an authorized
  choice when several active connections match;
- `ssoSessionMaxAgeSeconds`, `ssoReauthMode` (`detect_only` or `force`);
- `allowUnverifiedDomainUsers` default false, and JIT enabled/default eligible
  team settings; initial JIT organisation role is `member`;
- recovery design/version and tested designated subjects (§6.5, §12), with
  no unimplemented “1–3 owners” array treated as sufficient recovery.

### Connections, identities and membership grants

- **`OrgSsoConnection`:** stable id; exact client domain and org; protocol,
  preset, display name; status `draft/testing/active/disabled/suspended`;
  configuration revision; immutable tenant/subject binding; bounded health
  timestamps and non-sensitive failure codes. Test success binds the revision.
- **OIDC config:** exact issuer/discovery, registered client ID,
  supported client-auth method, encrypted secret reference or generated
  `private_key_jwt` key; scopes; asymmetric algorithm allowlist; typed mapping
  rules; trusted endpoint allowlist; bounded discovery/JWKS cache. Prefer
  `private_key_jwt` only where the provider actually supports it. Google's
  documented code exchange uses a client secret; validate the exact negotiated
  method rather than infer support from another preset. No OIDC encryption
  keys or upstream offline grants unless a later requirement needs them.
- **SAML config:** exact IdP entityID and endpoints; approved metadata source;
  trusted certificates with validity; SHA-256-or-stronger algorithm allowlist;
  persistent subject selector, typed attribute mapping, request signing and
  assertion-encryption settings; skew default 120 seconds, maximum 300.
- **SP identity:** `https://<uoa>/sso/saml/{connectionId}`; fixed for the
  connection's lifetime. ACS `…/{connectionId}/acs`, metadata
  `…/{connectionId}/metadata`; OIDC callback
  `https://<uoa>/sso/oidc/{connectionId}/callback`. SAML signing/encryption keys
  rotate with overlap. Changing SP identity can change pairwise subjects;
  deleting/recreating must never relink them by email.
- **`ExternalIdentity`:** UOA user, connection, immutable issuer/tenant/subject
  tuple, identity-scope discriminator, status, link-proof provenance, optional
  domain-claim dependency and last authentication time. Unique connection and
  subject; exact scope/config checks on every resolution. A collision is a
  refusal/reconciliation case, never a merge.
- **`OrgSsoGroupMapping`:** connection and stable external group ID where
  available; explicit name mapping only if documented; existing same-org team
  or permitted organisation role target. Owner, platform/admin-domain superuser,
  recovery authority and global credentials are never mapping targets.
- **Membership provenance:** one `source` string cannot represent manual plus
  SSO plus SCIM grants. Retain independent source contributions to the existing
  UOA membership, keyed by connection/resource and grant. Compute effective
  allowed membership/role through one service. A connection removes only its
  contribution; explicit deactivation/removal tombstones defeat JIT. Legacy
  rows default to human/unknown provenance, never silently to IdP ownership.
- **SCIM:** connection-scoped hashed token with rotation/revocation;
  `ScimResourceLink` with UOA-issued resource ID, resource type, optional
  client-supplied `externalId`, stable reconciliation proof and version.
  Group resources are external groups/mapping inputs, not UOA teams.

### Session assurance and revocation state

Authorization codes, refresh families and every derived credential need a
server-owned assurance record/reference containing:

- user and credential epoch; exact consuming client, organisation and where
  appropriate selected team; connection ID/revision and identity binding;
- method (`sso` on the wire), UOA-observed SSO completion time,
  provider-asserted authentication time when validated, MFA evidence source,
  normalized `amr`/`acr`, and effective absolute expiry;
- source family/authorization lineage, policy/connection revocation generation
  and explicit recovery provenance where applicable.

Rotation copies provenance and the original time bounds; it cannot refresh
authentication age. `tv` is never a lookup substitute for this record.
`twoFaCompleted` is not enough to identify IdP provenance, evidence expiry or
whether a global credential operation is allowed.

Define one opaque **assurance reference** issued by UOA and bound to the
authenticated product and source session. Possession alone grants no rights.
Products authenticate normally and present it in their signed subject context;
UOA verifies the signature, exact subject/client/org, current epoch, active
source record, scope and expiry. Never accept product-written `amr`, `method`,
`auth_time` or connection ID as evidence. This is a **new wire contract** to
specify and publish before enforcement, not a field already carried by current
Nessie assertions. Derive narrower UOA references for authorized downstream
exchange instead of forwarding source credentials to another product.

The build contract for this reference is:

| Element | Proposed exact behavior |
|---|---|
| Storage | `SessionAssurance` has an internal ID, a SHA-256 digest of a random 256-bit `assurance_ref`, subject, credential epoch, exact client/org binding, optional selected team, source family ID, optional parent assurance ID, connection/revision, authentication times, MFA evidence, policy generation, expiry and revocation time. The reference is not a refresh token. |
| Initial issue | Create it in the same locked transaction as the family after final authentication/authorization, including independent non-enterprise methods so they carry distinguishable account-control evidence. Return `assurance_ref` and `assurance_expires_at` only in the authenticated backend token response. The browser gets neither. Encrypt the reference in Nessie's existing session-credential custody. |
| Refresh | Resolve the exact family and reference; preserve original evidence/times. Return the same valid reference or an atomically replaced successor when scope changes. Old scope references cannot be used for the new target. Expired/revoked proof requires interaction. |
| Subject assertion | Add top-level `assurance_ref` to the existing product-signed assertion schema beside subject/epoch/active context. Keep existing issuer, audience, short lifetime and replay rules. Require it on every human assertion for a product once its server-owned assurance-contract version is enabled, including independent authentication. Missing proof cannot masquerade as legacy independent auth. |
| UOA verification | Hash the supplied reference; require exact subject, epoch, authenticated client, selected org, valid team membership, live source family/parent chain, connection and policy generation, and unexpired/revoked state. A ref for another client, family or context grants nothing even with the same subject and `tv`. |
| Signed access/resource token | Carry internal opaque `assurance_id` as a signed reference, never the backend custody reference or upstream bearer. Validator resolves current provenance for protected use. No claim-only promotion into global account control. |
| Derivation | Debug/broker/resource tokens record a parent assurance ID and exact narrower audience/scope. Validate all required live ancestors at use or within the single bounded deadline. Credential derivation cannot outlive or widen any parent. Team switch rebinds only after the target's current policy passes. |
| UOA account mutation | Introduce a typed authorization requirement: `global_account_control`, `enterprise_org_access` or `sso_recovery`. Every human credential/profile/link operation explicitly selects one. Enterprise and recovery assurance cannot satisfy `global_account_control`; independent existing-account reauthentication can. A domain credential or product-signed claim cannot self-assert this class. |
| Error | Absent/expired/nonmatching enterprise proof uses existing interaction-required semantics with a UOA-minted target-bound continuation. Invalid proof fails closed; UOA dependency failure is retryable and never treated as authorization or account deletion. |

Implement these as one shared validator and narrow derivation service, with
bounded parent depth and no cycles. Public schema names above are the proposed
wire extension, so update `/api`, `/llm`, TypeScript validators and consuming
products together. Do not accept unknown fields before the validator is ready.
UOA's server-owned product registration records the minimum supported assurance
contract; signed product configuration cannot downgrade it. Migrate all human
issuers/consumers for that product before switching the minimum. Old sessions
with unknown provenance require fresh authentication. Unmigrated products cannot
accept or exchange an enterprise-derived session from another product. Inventory
direct UOA browser/token account-management paths too: they validate their own
authenticated session provenance and do not accept a bare subject or missing
claim as independent proof. Preserve independently authenticated access to other
products; do not infer global denial merely from the presence of an external
identity on the user.

The gate is implementation and verification of this contract, not a request
for a separate product decision about how to associate a session with SSO.

OIDC state is a single-use server record containing nonce, PKCE verifier,
browser binding, connection revision and verified product continuation. A
second nonce store adds no value. SAML request/assertion replay records are
shared across instances and retained through accepted expiry plus skew.

Revocation needs a durable UOA outbox/feed with event scope, revision and
delivery receipts; this is revocation state, not a second identity store in
Nessie. Nessie may persist credential status, stable-reference bindings,
revocation generations and feed cursors. It must not persist roster/profile
snapshots from the feed.

## 6. Flows

### 6.1 Starting and routing sign-in

The Nessie doorway remains **Login / Register**. A verified backend continuation
may carry `login_hint` and the existing `team_hint`; neither is identity proof.
Never read a durable mirrored email merely to populate the hint.

The SP-initiated URL `https://<uoa>/sso/{connectionId}/start` works for tiles and
bookmarks. It resolves an enabled connection and its registered product entry,
fetches/verifies that product's signed config, and uses an allowlisted callback.
An arbitrary return URL, connection ID or hint cannot select a different
product, organisation or account. Preserve the relying product's state through
all continuations without reinterpreting it as a redirect.

A tile or bookmark begins without a relying-product PKCE verifier or pending
state. The start URL must therefore hand off to the registered product login
entry so the product begins its normal browser-bound authorization flow, carrying
only the connection/target hint or a bounded UOA launch intent. UOA validates that
selection again after signed-config verification. Do not issue a code directly
to a product callback that has no matching product-owned pending flow. Test-mode
callbacks remain separate and never issue a product code.

Optional `POST /auth/sso/route` is an Auth UI email-step endpoint. The product
integration advertises support through `sso` in `enabled_auth_methods` and
`org_features.enabled`; this is protocol capability, not a Nessie administrator
or billing flag. UOA alone enables the connection, enforcement and discovery.
Any signed `login_flow.sso_discovery` capability must still require the
organisation's explicit discovery consent in UOA. Resolve only fresh verified
claims and active connections in the
exact client scope. A default connection or deterministic chooser handles
multiple matches; do not pick the first database row.

Discovery deliberately reveals that a domain has enterprise SSO, never whether
an individual account exists. Unknown/nonparticipating cases share a generic
response shape and bounded execution behavior; do not promise physically
constant network timing. Rate-limit by IP and normalized domain, avoid raw
email logs and measure existence-oracle tests. Verifying DNS alone is not
consent to publish the organisation's login routing.

This is a proposed amendment to the earlier “no pre-auth discovery” decision.
Until approved and implemented, use start URLs. `/auth/start` and the legacy
`GET /auth/domain-mapping` do not acquire a second discovery implementation.

### 6.2 Callback validation

Connection selection comes from the fixed path and single-use, browser-bound
request record. Re-read connection revision, active state, product gate and
policy before consuming the response and again under issuance locks. Test-mode
callbacks cannot become live authorization codes.

**OIDC:** use authorization code, S256 PKCE, state and nonce. Pin the issuer,
audience and asymmetric algorithms; validate signature, time bounds and nonce.
When `azp` is present it must identify this client; require it for multiple
audiences and reject untrusted extra audiences. Validate returned `iss` as
specified by [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html), requiring
it when advertised. Tenant proof must come from the validated ID token, not
UserInfo or hints. Unknown `kid` gets one bounded, rate-limited JWKS refresh.

UserInfo must match ID-token `sub`. Only explicitly mapped profile fields may
be added; never merge arbitrary claims into tenant, subject, assurance or role
data. Validate `at_hash` when supplied. Its absence in authorization-code flow
does not by itself forbid UserInfo. When sending `max_age`, require and
validate `auth_time`; `force` uses `max_age=0` for a fresh IdP authentication
request. These distinctions follow
[OIDC Core §§3.1.3 and 5.3](https://openid.net/specs/openid-connect-core-1_0.html).

Do not substitute ID-token `iat`, callback receipt time or token refresh time
for provider authentication time. Keep UOA-observed completion time separately
for `detect_only` (§6.6). Entra guests still require the configured resource
tenant; a foreign email does not bypass tenant checking or account-link proof.

**SAML:** use a maintained library with reviewed signature parsing and attack
fixtures, not handwritten XML-signature logic. The launch validation profile
requires HTTPS HTTP-POST ACS, DTD/external-entity refusal, one signed assertion,
an approved signing key and algorithm, successful response status, exact issuer,
audience, destination and recipient, and matching request correlation. Check
both response/request correlation and bearer SubjectConfirmation data, temporal
conditions, AuthnStatement and assertion replay. Honor signed session expiry.
All conditions/audience restrictions must be satisfied; one matching value is
not permission to ignore another restriction.

Read claims only from the validated signed node. Reject duplicate IDs and
ambiguous assertion/attribute structures; ignore untrusted `KeyInfo` as a trust
source. Test XML wrapping and comment-injection attacks against the chosen
library. Do not override canonicalization with the previous draft's blanket
“keeps comments” instruction. Support tested `EncryptedAssertion` and
`EncryptedID` processing; encryption never replaces signature validation.
The protocol definitions are in
[SAML 2.0 Core](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf).

Sign AuthnRequests by default. Request an explicitly configured authentication
context when policy needs it; do not send REFEDS context to every IdP by
default. Validate the returned context and `AuthnInstant`; `ForceAuthn` alone
is not proof of a fresh completed login. RelayState is an opaque request handle.
Unsolicited/IdP-initiated responses remain disabled for launch (§4 R9).

Failures expose a generic public error and correlation ID. Authorized
connection administrators see redacted diagnostic codes; neither raw tokens,
assertions, secrets nor unrestricted test-user claims go into logs.

### 6.3 Identity resolution and global-account protection

Resolve in this order after protocol validation:

1. **Known stable identity.** Resolve exact connection/issuer/tenant/subject
   under the configured UOA identity scope. Require ACTIVE user, link,
   membership/admission and current policy. A suspended or removed link never
   falls through to email/new-user resolution.
2. **Existing UOA account.** Never auto-link by email, including an ordinary
   nonprivileged account. A verified corporate domain proves domain control,
   not possession of that person's existing global account. Require a fresh
   existing-account authentication independent of the candidate enterprise
   connection, enrolled TOTP where applicable, and explicit account-link
   confirmation bound to both subjects, connection revision and browser.
   A bare code sent to an address controlled by the candidate employer/IdP
   is not independent proof. If no independent method exists, stop with an
   authenticated recovery/reconciliation path; do not weaken the test.
3. **New account.** Only an exact `userKey` miss after canonical normalization
   may create a UOA user. Require a valid stable subject and an address
   acceptable under UOA's registration rules; independently verify a
   suggested/untrusted email. Do not manufacture email placeholders for a
   schema that requires an address. Missing/unverified email pauses enrollment.
   Create the user, external link, approved membership, audit and authorization
   state transactionally. A race that finds an existing user returns to proof,
   never changes that user's binding.
4. **Contractors.** Default off. If enabled after the product decision, a
   foreign-domain address still requires verification, stable tenant proof and
   explicit admission/invitation. It never claims the foreign domain or
   auto-links an existing user. Do not accept a new global-account existence
   oracle merely because contractor mode is enabled. Administrative responses
   are restricted to identities already authorized in this connection.

Privileged users, enrolled 2FA users and recovery custodians therefore always
require independent proof; the protection also applies to everyone else.
Link/unlink changes take the account and connection locks, reject conflicting
subjects, preserve other links and notify through an independently authorized
channel without exposing another product's membership.

**The result is scoped authentication, not global account control.** An SSO
session can act in its authorized product/org context. It cannot change global
passwords, recovery methods, MFA, primary email or other provider links; acquire
system-admin access; mint unrestricted native credentials; or switch into an
unrelated product solely because the UOA subject matches. Explicitly authorized
resource delegation may narrow this context. All other escalation requires
fresh independent account proof. Existing UOA self-service/recovery endpoints
must enforce this provenance before enterprise authentication is activated.

The current email-canonical UOA model also means recycled corporate mailboxes
are a risk through existing recovery/social paths. Do not silently extend
email-only recovery to enterprise-created accounts or claim this plan fixes all
legacy recovery risk. Audit recovery and global-profile writes as a launch
blocker; unresolved account-possession cases stay unlinked.

**Profile authority.** IdP/SCIM attributes are connection-scoped assertions held
inside UOA, not automatic writes to a shared global profile. A global email/name/
avatar change follows UOA's canonical user-authorized workflow; changing DNS
ownership is not consent. New-account initialization may use verified attributes
under that workflow. Nessie reads the canonical result through UOA APIs.

**Domain lapse/revoke/reclaim.** Suspend every link/grant whose proof explicitly
depends on that claim, revoke its assurance/families, invalidate caches and emit
events. Include any historical `linkedVia=email_domain` links. Independent
session-proven links do not become auto-linked again on reclaim. Stop discovery
and new domain-based enrollment. An already enforcing policy becomes suspended/
fail-closed for affected access; it must not silently revert to password access
because verification lapsed. Recovery remains available under its own policy.

**Credential management is separate from workplace admission.** Having an
`ExternalIdentity` must not globally disable a person's password or recovery
rights in other products. Conversely a password reset, email-code login or
invite acceptance can never mint SSO assurance or admit an enforcing org. An
SSO-created account has no password until the independent global-account
workflow authorizes one; a reset request cannot bootstrap that authority from
the employer's claim alone.

### 6.4 Organisation and team placement

JIT may add a first ACTIVE membership to the connection's org only when enabled,
allowed by current lifecycle/bans/capacity/seat policy, and not contrary to an
explicit prior removal. Default organisation/team role is `member`. Do not
inherit a first-user domain superuser bootstrap or first-materializer ownership
path. Product-specific team enablement is checked separately before entry.

JIT suppresses unnecessary personal-org fallback for this transaction. Existing
membership in another organisation is not an error: UOA now supports multiple
organisations. Authorize the new target under its explicit JIT/invitation policy
and confirmed user intent, leaving all other memberships intact. Concurrent
logins, SCIM and invite acceptance use the same locked admission service and
exact `(orgId, userId)` constraint; no account merge or partial creation.

**Moves are deferred.** Remove `acceptPersonalOrgMoves`; no preapproval setting
may move someone on login. A future move requires fresh independent user
confirmation, authorized target admission, source ownership/last-owner and
billing/content checks, explicit treatment of existing teams and credentials,
and one audited transaction. A move necessarily changes membership, so the
earlier promise “move but never deactivate a membership” was contradictory.
Joining another organisation does not need this move workflow. Only a request
to leave/transfer the original organisation needs its own normal membership/
ownership management and continuity checks. Never invent an automatic owner
transfer or silently empty a personal org.

Group mappings reference existing same-org UOA teams. The settings UI obtains
Nessie's eligible product-team set through a scoped authenticated contract;
UOA cannot query Nessie's database. Nessie repeats its local enablement gate
at admission. If no mapped team is usable, use only an explicitly configured,
currently eligible default; otherwise show `TEAM_NOT_AVAILABLE` after proof.
Do not create a team or choose a sibling tenant to make login succeed.

Reconcile source contributions, not whole membership rows. Incomplete groups
(overage, omitted claim, partial page) are add-only for that sync, with a visible
warning; they do not prove removal. Such a connection cannot promise timely
group-removal enforcement until complete group reads or SCIM are configured.
Human deactivation remains authoritative even if the next IdP response lists
the user. Connection disable withdraws that connection's contributions and
assurance, without deleting unrelated/manual authority.

### 6.5 Enforcement, assurance and recovery

Use one `assertOrgAccessPolicy(subject, client, org, assurance)` service. Call it
from both public context entry functions and the underlying direct lookup path,
and at relevant membership-sensitive authorization/issuance boundaries. Avoid
a copied predicate in each route. Every exact target must be resolved before
policy evaluation, including cross-origin product contexts.

`required_for_all_members` needs current assurance from an allowed active
connection of that exact product/org, valid time/MFA and live membership.
`required_for_verified_domains` selects its governed subjects by canonical
UOA/domain-claim policy, never arbitrary submitted email; domain loss does not
downgrade existing enforced access. A permitted recovery session has explicit
bounded recovery provenance, never fabricated SSO claims.

The assurance contract must cover each path:

| Path | Required evidence and behavior |
|---|---|
| Interactive callback → code → token | UOA writes assurance after validated proof; code issuance and redemption preserve exact binding under locks. |
| Refresh and team switch | Resolve the exact source family; keep original authentication times. Evaluate the selected target; return interaction-required when its connection proof is missing. |
| Product subject assertion, including `/org/me` | Authenticate the product and its signed subject assertion plus UOA-issued assurance reference. `tv`, subject equality or a copied connection claim alone is insufficient. |
| Confidential/chained resource exchange and session broker | Preserve verified original provenance, target mapping, narrowed scope and shortest expiry. A backend app credential cannot invent a human SSO session. |
| Debug login | Derive from the live issuing family/assurance; recheck source revocation and exact target on redemption. Never upgrade unknown/non-SSO proof. |
| Long-lived personal grant and unattended work | Bind issuance to exact proof and authorizer; recheck current UOA admission before protected use and dispatch (§6.6). No background assertion may fabricate fresh user presence. |
| Native password/Google | May retain unrelated authorized account use, but cannot access an enforcing enterprise org until a supported native SSO journey exists. |
| SCIM | Provisioning credential only. It never mints human context, assurance or sessions. |

Add a shared credential-route guard with an explicit registry of credential
establishing/consuming routes. Cover password/login/start/verify-code/register/
reset, email registration and invitation completion, social start/callback,
native login/social, debug issue/redeem, factor changes and action-verification
continuations. Tests compare the registry with the actual route table and
exercise denial; the existence of a wrapper alone is not a passing test.
Evaluate the product/target context, not a global “email has SSO” flag. Global
credential changes still use existing user-global lock/epoch semantics.

Enabling enforcement, changing a tenant/assurance requirement, or disabling a
connection invalidates relevant assurance and exact scoped families. Already
issued tokens require the live/bounded revocation checks in §6.6. Never claim
that revoking a refresh family instantly rewrites an access JWT.

**Recovery is a release gate.** The earlier draft both allowed one owner and
required two, and current UOA has one canonical owner. The chosen resolution is
two independently authenticated, explicitly designated recovery custodians,
with a narrowly scoped UOA recovery capability. The user delegated the recovery
choice; its reachable implementation must pass a recovery drill before
enforcement. Do not create fake
owner memberships. Backup codes remain prohibited under current UOA rules.
The real canonical owner may be one of the two explicitly designated custodians;
designation is separate from ownership. The second custodian must be another
active canonical member with their own existing independent factor. This requires
two people rather than a third administrator solely for recovery.

Recovery must be independent of the failing IdP: tested password plus enrolled
TOTP or another explicitly approved independent UOA factor flow; no email-only
bypass through the corporate mailbox. Fresh authentication is required, attempts
are strictly rate-limited/audited, and authorized custodians receive bounded
alerts without a spam oracle. A recovery session may inspect/repair the SSO
configuration it is authorized to recover; it does not grant platform authority
or unrelated product data. Enrollment, removal and ownership handover recheck
continuity under locks. Never remove the last viable recovery route.

Require a passing test for the exact connection revision, tested recovery and
all revocation consumers before enforcement. Routine deletion of the last
usable connection is refused until an explicit recovery/policy transition;
emergency compromise suspension must remain possible and fail closed while
preserving recovery. An expired certificate must not leave password login open.

Switching operates on an exact live target, within or across org origins where
the server product policy permits. Reuse the team-switch grant and interaction
codes. Return a trusted UOA continuation bound to that target; Nessie validates
the configured UOA origin/path and its own state before redirecting. Never
follow an arbitrary URL copied from an IdP error.

### 6.6 Session lifetime and deprovisioning

For `detect_only`, cap every family/derived grant at UOA-observed SSO completion
plus the configured maximum age. A new IdP round trip may be silent; it is a
fresh check with that IdP, not proof of a fresh factor challenge. For `force`,
validate provider authentication time and requested fresh authentication, and
cap from that time. Never substitute a fresh issuance timestamp. Use the minimum
of the assurance limit, signed IdP session limit where provided, product refresh
TTL and parent delegation expiry. Recheck changed policy on every rotation.

An IdP may continue its own session after upstream deprovisioning. An SSO round
trip alone therefore cannot guarantee a deprovisioning deadline. The guarantee
starts when UOA learns an authoritative removal/disable through SCIM, an
authenticated administrator or a supported provider revocation signal. State
upstream provisioning delay separately in the customer's runbook.

Org membership removal/deactivation revokes that person's org access across its
bound relying products. Product-only policy changes revoke that product/org
scope. Connection disable revokes its source assurance and grants, while
preserving independently authorized sources. Team removal revokes that team's
access. User-global lifecycle/credential events follow existing UOA semantics.
**Do not increment global `User.tokenVersion` for an org or connection event.**
Do not delete the shared UOA user through SCIM.

Implement revocation before customer SSO activation:

1. Commit authority change, generation and an outbox event atomically. Event
   scope explicitly distinguishes global user, organisation, product/org,
   team and connection. Include event ID, schema version, committed revision,
   occurred-at and stable identifiers appropriate to that scope; a connection
   event need not pretend to name one user.
2. Deliver only to registered authenticated product destinations. Sign the
   exact body with a dedicated per-consumer HMAC-SHA256 secret, key ID and a
   fresh delivery timestamp; allow a five-minute delivery window. Event time
   may be older on retry. Support overlap key rotation and constant-time
   verification. Never reuse UOA domain/app credentials as webhook keys.
3. Receivers verify audience/scope/signature before persisting an idempotent
   event receipt and scoped credential invalidation. Acknowledge only after
   durable commit. Out-of-order events cannot restore authority; deduplicate
   retries across instances and retain replay protection for the retention
   window. Stale “reactivate” deliveries cannot revive old credentials.
4. Provide an authenticated product-scoped pull feed with an opaque cursor,
   stable ordering, pagination, retention and explicit cursor-expiry recovery.
   Advance the cursor only after committed handling. Recovery rechecks current
   authority; it never reconstructs a durable membership directory in Nessie.
5. Recheck live UOA admission on protected credential use. Proposed maximum
   age of a positive org-admission result is **30 minutes**, shortened for
   sensitive management/dispatch boundaries that already require live proof.
   Keep it only in bounded process memory, bound to subject, client, org/team,
   assurance reference, epoch and policy generation. No expired result survives
   an outage; return a retryable refusal while retaining retryable session
   state. Rechecks are independent of webhook delivery and feed availability.

The 30-minute value is a proposed **upper bound after UOA observes revocation**,
not a guaranteed delay, “floor”, JWT lifetime claim, or independent allowance
for each downstream layer to add another 30 minutes. Cap credential validity
and every cache by the same authoritative deadline. Event delivery normally
reduces this delay. Document the actual configured bounds after testing them.

Nessie must cover this matrix, including legacy grants lacking scope:

| Consumer | Required behavior |
|---|---|
| Browser/local API JWT, AuthSession and refresh | Exact session lineage and org/team admission; refresh/issuance recheck; revoked session denied even before JWT expiry at protected boundaries. |
| MCP agent credential | Bind org/team, authorizer and assurance lineage; enforce current admission on use. Ninety-day expiry and local user epoch alone are insufficient. |
| Device token and persistent connections | Same binding; revalidate on reconnect and protected operations. Close/deny already-open streams when admission ends or the recheck deadline passes. |
| Executor personal delegation/enrollment/host session | Revoke the affected personal grant, not a shared installation or unrelated owner's host access. Recheck before dispatch and during long-running authority renewal. |
| Trigger personal authorization and queued/resumed work | Resolve current authorizer/proof at dispatch and resume; refuse new protected effects after revocation. Preserve the queued item and retry state; do not delete it to hide a failing gate. |
| Resource token/broker/debug-derived session | Preserve the originating scope, revocation dependency and expiry through each hop. No family lookup by global epoch. |

A legacy grant without trustworthy scope must be renewed through proof or
disabled in a targeted migration. It cannot inherit ambient session/team scope.
Record which in-flight operations can finish safely and which must stop; no
claim of instant cancellation of already completed external effects.

### 6.7 MFA

Reuse effective UOA domain/org/account 2FA requirements, including mandatory
TOTP for an already enrolled account where current policy requires it. Enterprise
MFA must not silently weaken a global factor or credential-management check.

Per-connection trust choices are `off` (use UOA factors), `mapped_claims`
(validated evidence with tested provider/context rules), or `admin_attested`
(explicit assertion that this exact IdP application enforces the requirement).
Keep attestation distinct from observed MFA. Require fresh UOA-authorized
administration to change it; changes invalidate affected assurance.

Do not assume Entra v2 always supplies `amr`, that Okta emits one universal
`acr`, or that Google can never supply MFA evidence. Google's current
documentation describes optional `amr`/`auth_time` configuration. Each preset
must demonstrate its actual claim contract in its sandbox; absence or unknown
values fail the mapped-evidence check. REFEDS is an optional SAML context for
deployments configured to support it, not a universal requirement.

### 6.8 Administration and reachability

**Home:** UOA Auth organisation access settings → Single sign-on. **Doorways:**
the authenticated UOA workspace chooser's management action and Nessie's
Settings → Organisation → Single sign-on for the exact bound organisation.
Member login errors provide an authorized recovery/re-authentication route,
not an unlinked endpoint name. Reuse existing navigation and settings surfaces.

The UOA Auth management continuation is a dependency, not an existing page.
Follow the corporate-domain plan: short-lived, one-purpose, exact org/client
scope, browser-bound, live actor authorization on every mutation. No general
`X-UOA-Access-Token`, product credential or refresh token is exposed in browser
storage or URLs. Settings mutations require fresh suitable proof within ten
minutes and recheck that age after locks.

The existing corporate-domain proposal is owner-only. Preserve that contract
until an explicit UOA capability amendment authorizes delegation. Do not invent
“owners or admins the owner delegates” without a defined grant/revocation model.
Nessie's owners and admins retain equal product management visibility; its
doorway reads current UOA capabilities and accurately presents an upstream
owner-only action. Nessie must not add an owner-only gate for ordinary product
status reads or grant an admin power UOA has not authorized. Recovery capability
is separate from ownership (§12).

The setup journey:

1. Choose the provider, then follow a short sequence: connect, test, choose who
   can enter, and turn on. Present only the inputs this preset actually needs,
   with copy actions and plain instructions for the customer's IdP console.
   Use shared UOA controls/layout rather than a separate UI per provider.
2. Show the selected organisation and destination clearly. Put metadata,
   certificates, claim mapping and other advanced controls in a secondary
   view unless setup needs them. Keep essential tenant proof mandatory without
   asking the customer to understand protocol jargon.
3. Test with a real login. The main result says whether sign-in works, whether
   the tested person can enter the intended workspace, and the next action.
   Redacted claims and protocol detail belong in protected diagnostics. Never
   provision/link a person, change grants or issue a product session from test
   mode. Bind the result to the exact configuration revision.
4. Activate only after §9 prerequisites. Explain domain verification,
   optional discovery and enforcement in terms of who can sign in. Present
   recovery readiness as a short actionable check before enforcement, with
   a direct path to fix a missing custodian or failed test. SCIM creation uses
   UOA authorization/readiness, not Nessie billing, and shows its token once.
5. Provide health/failure and audit views scoped to authorized administrators,
   plus certificate/known-secret-expiry notices at 30, 14 and 3 days. Unknown
   secret expiry must be shown as unknown, not invented. Notify live authorized
   recipients; do not copy address lists into Nessie.

Nessie reads status/capabilities from UOA through the same bounded live boundary
as its other identity views. Store no connection secret, mirrored provider
profile or hierarchy there. Keep sensitive diagnostic claims out of ordinary
member screens. Nessie has no SSO enablement switch, connection editor,
enforcement toggle or subscription gate; its action opens the owning UOA
surface. No new billing subsystem is part of this plan. Add accurate
translations in every supported language in the
implementation PRs and verify actual headless rendered flows locally.

### 6.9 SCIM 2.0

Proposed base URL: `https://<uoa>/scim/v2/c/{connectionId}`. A dedicated bearer
authenticates only that connection/product/org. Hash it at rest; support
overlap rotation, immediate revoke and rate limits. No platform-admin token,
global user lookup or cross-connection filter is exposed.

Implement `Users`, `Groups`, `ServiceProviderConfig`, `ResourceTypes` and
`Schemas`, with supported filtering, pagination, PATCH, errors, versions and
idempotency documented truthfully. Validate Entra/Okta dialects against recorded
integration cases. Do not promise a provider's delete schedule: test
`active=false`, DELETE, retries and reactivation independently.

SCIM `id` is UOA-issued; `externalId` is optional, client-assigned and scoped to
the provisioning domain. It is not inherently the OIDC subject. See
[RFC 7643 §3.1](https://www.rfc-editor.org/rfc/rfc7643.html#section-3.1).
Only an explicitly configured, tested immutable-ID transform may reconcile it
with SSO (for example an Entra object ID plus the pinned tenant). Changing that
mapping is an identity migration. Without such proof, keep a pending resource
and resolve through §6.3 independent account proof; never fall back to a
verified-domain email match. Namespace resource IDs and filters by connection.

Provisioning uses the shared UOA admission transaction, scope rules, lifecycle,
capacity and provenance model. An existing global user needs the same linking
proof as interactive SSO. SCIM profile writes update authorized connection
attributes only, not global passwords, canonical email, MFA or shared profile.

`active=false` suspends the managed resource and its login/grant source, revokes
affected assurance and prevents JIT resurrection. DELETE removes the
connection's managed contributions and suspends/tombstones its link; it never
deletes the global person. Recompute effective membership when another source
still legitimately grants it. Where an explicitly approved SCIM policy owns
the whole organisation membership, deactivate that membership through the
standard UOA transaction, protecting canonical ownership and recovery. Never
let an old provisioning token remove a human owner or bypass continuity.

`Groups` supplies source contributions to existing teams and permitted roles.
Unmapped groups grant nothing. SCIM does not create UOA teams or replace the
organisation hierarchy. Audit with the existing system/connection actor model
and no plaintext bearer or raw profile dump. This design supersedes the old
email-matched, global `User.scimExternalId` and `/internal/admin` SCIM proposal.

## 7. Security acceptance requirements

The following are release conditions, not claims that a library or phase name
already satisfies them:

- **Network trust:** reuse UOA's DNS-pinned SSRF fetcher for discovery, JWKS,
  metadata, token, UserInfo and any later logout/artifact/Graph endpoints.
  HTTPS only; reject private/link-local/loopback destinations, credentials in
  URLs and DNS rebinding. Explicit issuer/preset endpoint allowlists account
  for legitimate cross-origin vendor endpoints. Never let discovery widen its
  own secret-bearing destination allowlist. Do not follow token POST redirects
  with credentials. Bound other redirects to three, rechecking each hop.
- **Resource limits:** proposed five-second fetch timeout; JWKS/discovery
  64 KiB, metadata 1 MiB, ACS decoded XML 256 KiB plus bounded encoded body
  and parser complexity. Reject oversized/decompression/redirect abuse. Use
  MDQ per entity for later federation support, not unrestricted aggregates.
- **Cryptography:** asymmetric OIDC allowlist; reject `none` and HMAC
  confusion. SAML SHA-1 is excluded at launch, even if the old draft named
  a quirk. Require supported secure key sizes (RSA at least 2048 bits),
  explicit certificate trust and bounded overlap rotation. Metadata updates
  cannot silently replace issuer, endpoints or trust anchors.
- **Trust provenance:** tenant, stable subject, exact audience, browser state,
  request correlation, live connection revision and product gate checked
  before linking/issuing. No arbitrary claim merges or email identity joins.
- **Scope:** every credential and management action names its exact actor,
  product, org and applicable team. Subject assertions and app credentials are
  different authorities. Test cross-origin legitimate selection and refusal.
- **Concurrency:** callback consumption, JIT, SCIM, grant removal, policy
  changes, account linking and issuance serialize against revocation under
  the established lock order. A stale successful login cannot revive access.
- **Recovery and lifecycle:** no last-owner/recovery destruction by group sync,
  SCIM or ordinary member mutation. Lifecycle denial has no superuser escape.
  Recovery does not become unrestricted account control.
- **Abuse and privacy:** rate-limit start, route, callback, ACS, linking and
  SCIM; cap connections, groups, mappings and replay records; bound JWKS
  refetches across instances. Audit changes, proof links, failures and recovery
  with correlation IDs; redact secrets, raw assertions and unnecessary PII.
- **Revocation:** test every consumer in §6.6 with dropped/late events and an
  unavailable UOA. Keep org/connection changes independent of global epochs.

## 8. Nessie implementation and migration

### 8.1 Containment — proposed Phase 0

Refuse a configuration that enables UOA alongside generic `oidc`/`custom` human
authentication. Independently refuse non-UOA resolution to a `uoaSub` principal
or a UOA-bound tenant, including pre-transaction lookups and legacy paths.
Inspect all login/config entry points, not only the ordinary callback. Add
focused takeover regressions and document the explicit modes. The source plan
requested Fable review before writing this fix; that review is not represented
as completed here.

Containment reduces exposure; it does not complete the authority migration.
Do not expand its one-time email adoption bridge or add profile synchronizers.

### 8.2 One live authority boundary

Inventory every UOA-derived profile, hierarchy and membership reader/writer
across API, worker, tools, directories, exports, search, notifications, local
JWT shaping and background tasks. Extend the existing shared UOA live boundary
instead of adding a second roster implementation. Reads take stable subject/
org/team and live entitlement; writes relay to UOA. An owner/admin in one team
never obtains another team's contents merely through org role or ambient claims.

Bounded in-memory display caches may reuse authorized profile data with actor,
scope, epoch, size and freshness bounds. Authorization results have their own
short explicit deadline and prompt invalidation. No cache fallback to stale
durable columns on outages. Display data is never proof of membership.

### 8.3 Login and interaction

Carry the new UOA assurance reference atomically with session credential
rotation and exact context. Add trusted `login_hint` when available in the live
response, preserve `team_hint`, and validate UOA continuations for interaction
errors. Display sign-in method from verified UOA evidence without persisting
copied provider attributes. Native journeys that cannot supply enterprise proof
show an actionable unsupported/reauthentication state; they cannot fall back
to a password for an enforcing org.

### 8.4 Remove duplicated identity and hierarchy through migration

**The prior proposal to update `User.email` and merge an “inactive” email row is
withdrawn.** UOA email changes do not cause local account merges or admission
failure based on a copied `User.email @unique` column.

The required migration is:

1. Produce a read-only inventory of bound principals/containers, duplicate or
   missing stable bindings, copied identity columns, membership projections
   and product-owned foreign keys. Preserve durable product history. Identify
   unbound local accounts separately; never infer their identity from email.
2. Backfill only bindings proved by existing trusted UOA subject records or an
   explicit account-possession reconciliation. Conflicts are operator-visible
   blocked records. An empty/activity-free row is not proof of ownership and
   must not be merged automatically.
3. Move bound consumers to UOA API-backed identity/entitlement reads and writes.
   Remove UOA email/name/avatar and role mirrors from login/materialization
   paths. Require actual UOA role proof; remove first-materializer owner
   inference. Stable local principal IDs may remain for product foreign keys.
4. Make identity-only local fields nullable/inapplicable to UOA-bound records
   and remove their admission/uniqueness dependency there. Retain only UOA
   references and genuine product extensions. Apply local credential/profile
   constraints only to the unbound mode; do not retain a compatibility copy
   for UOA consumers.
5. Remove bound UOA-owned org/team labels, hierarchy and membership projections
   after the readers are cut over. Preserve product container bindings and
   product-specific access rules; do not delete product project/channel
   memberships that are genuinely Nessie-owned. UOA references must remain
   1:1 and must never be reparented from an untrusted response.
6. Verify migration restart/idempotency, old-session behavior and deletion/
   tombstone cases. Stop and report unresolved mappings rather than fabricate
   profile data, silently merge users or flatten tenants. Purge superseded
   mirrors under the approved migration/retention rules after cutover proof.

This is an explicit prerequisite for enterprise rollout, not permission to
copy existing violations for a new login path. Coordinate with Nessie's current
UOA unification work; reuse its migrated surfaces and do not run competing
migrations over the same rows. If an API capability is missing, build it in
UOA first and keep the affected rollout gated.

### 8.5 Credential consumers and settings

Implement the exact-scope receiver, pull recovery and use-time checks from
§6.6. Bind legacy grants deliberately; do not revoke every credential sharing
a local user ID for an org event. Persist only session/revocation/product data.
Reuse the organisation settings and live status/capability route from §6.8.

### 8.6 Unbound self-hosted mode

Generic non-UOA OIDC hardening is separate work: proper confidential-client
handling where applicable, validated ID tokens, `(issuer, subject)` identity
keying, constrained mappings and its own migrations. It must remain exclusive
with UOA human authentication and cannot operate inside a bound tenant. The
enterprise organisation SSO on self-hosted Nessie uses UOA. Deployment and
commercial arrangements are managed internally; this work adds no separate
broker or self-service packaging flow.

## 9. Delivery order and activation gates

These are coherent implementation tranches, not a statement that each incomplete
tranche can be enabled for customers. The user has requested coding after this
document update; unresolved decisions remain explicit. Follow each repository's
worktree, review, tests and green-merge workflow. This documentation revision
does not create implementation PRs or claim completed reviews.

| Phase | Owner/repo | Deliverable | Must precede |
|---|---|---|---|
| 0 | Nessie | §8.1 containment, focused regression and requested security review. | Any mixed-provider rollout; independent urgent fix. |
| 1A | UOA | Reconcile source specs; implement the scoped assurance/provenance wire and global-account authorization contract in §5; enumerate routes and credential consumers. | Enterprise callback implementation that can issue real users/sessions. Recovery decision is required for Phase 4, not containment or protocol test mode. |
| 1B | UOA | Domain claims and continuation/settings surface; encrypted credentials; scoped policy/assurance/provenance schema; live policy seam; atomic outbox/feed and core revocation. | Protocol activation. A no-op hook is not a completed enforcement gate. |
| 1N | Nessie, with UOA API dependencies | §8.2–8.4 authority migration and exact credential lineage/use-time admission; receiver/feed/cache deadlines; migration and multi-instance race tests. | First real SSO login in Nessie, even with enforcement off. |
| 2 | UOA + Nessie | OIDC engine, first five applicable presets, independent linking, JIT, time/MFA semantics, exact assurance propagation, settings doorway and tested interaction handling. | OIDC pilot only after 0, 1A, 1B, 1N and all relevant gates below. |
| 3 | UOA + Nessie | SAML engine, AD FS/Other SAML and individually verified variants; metadata/rotation/expiry; full signed callback tests. | SAML pilot after 2 and protocol-specific verification. |
| 4 | UOA + Nessie | Approved recovery capability, enforcement and optionally approved discovery; guard enumeration; all derivation/reauth paths; outage/recovery drills. | Enforced SSO for either protocol. |
| 5 | UOA + Nessie | Optional UOA-managed SCIM, tested subject reconciliation/provenance and deprovisioning journeys using already delivered revocation infrastructure; no Nessie billing gate. | SCIM customer enablement; not the first delivery of revocation. |
| 6 | Relevant repos | Evidence-backed extra presets, native SSO, optional logout protocols, opt-in complete Entra groups, federation MDQ and separately designed moves. | Only the optional capability's own activation. |

Activation gates:

- **Account authority:** malicious tenant administrators cannot claim existing
  accounts, overwrite global profiles, enroll factors, recover accounts or
  obtain unrelated product/platform access through SSO-derived proof.
- **Exact scope:** exact membership uniqueness, authorized multiple orgs and cross-product policy,
  no automatic moves, live target-team enablement and isolation are demonstrated.
- **Provenance:** every issuing/consuming route has exact assurance lineage;
  missing or pre-migration proof fails closed for enterprise access.
- **Nessie migration:** no UOA-derived durable profile/hierarchy/membership
  fallback remains on enterprise-covered paths; unresolved migration inventory
  blocks rollout instead of being hidden by an email bridge.
- **Revocation:** all §6.6 credentials, streams and background dispatch honor the
  same bound under lost webhook, feed outage and multi-instance races.
- **Reachability:** setup, test, login, error recovery and operator diagnostics
  work through their actual UI doorways, with translations and local headless
  screenshots. No UI suites are added to Nessie CI.
- **Recovery:** independently tested custodians or another explicitly approved
  design exist before enforcement, with last-owner/recovery protection.
- **Operations:** exact deployed UOA and Nessie revisions/configuration are
  verified; a merged PR alone is not rollout evidence.

## 10. Verification plan

Use current repository testing standards and focused component gates. Run
database tests against real isolated PostgreSQL schemas with required database
configuration; do not accept a green suite that skipped database coverage.
Nessie package tests use Turbo and explicit `DATABASE_URL`; UI suites run
locally and headless. Route portable builds/tests through Maxis/Fedora after
checking shared load, and use a native host only for changed native inputs.
This document-only revision requires no app build or fabricated test result.

Required durable regressions:

| Area | Cases and expected result |
|---|---|
| OIDC | Wrong issuer/tenant/audience/`azp`/nonce; `none`/HMAC confusion; unknown key; RFC 9207 stripping; UserInfo subject mismatch and injected role/tenant claims; invalid present `at_hash`; valid code flow without `at_hash`; stale/missing required `auth_time`. Refuse invalid evidence without side effects. |
| Tenant | Consumer Google account against Workspace even with contractor mode on; unlisted `hd`; Entra wrong resource tenant and B2B guest; shared-issuer custom provider missing tenant proof. Tenant checks never depend on email admission. |
| SAML | Wrapping corpus, duplicate IDs, comment injection, unsigned/extra assertion, SHA-1, failed status, wrong audience/destination/recipient/correlation, expiry, replay across instances, unknown cert, encrypted assertion/ID, oversized XML and unsafe parser inputs. No claims escape the signed node. |
| Existing-account takeover | IdP asserts ordinary, admin, owner, platform-superuser, TOTP or recovery-user email; mailbox/DNS recycling; two scopes with the same email; link race. No automatic link, merge or recovery. Independent proof succeeds only for its exact bound action. |
| Global escalation | SSO-derived proof tries another product/org, global email/password/2FA change, provider linking, platform admin, native grant, debug/broker/exchange laundering. Refuse; authorized narrow delegation remains valid. |
| JIT and provenance | First login, parallel first login/SCIM/invite; authorized second org on the same origin; unauthorized target; removed/deactivated user; capacity limits; manual+IdP+SCIM contributions; incomplete groups; owner mapping; disabled team/default. No surprise moves, owner grants or resurrection. |
| Enforcement | Exercise every registry route and continuation, `/org/me`, direct context lookup, native, broker, debug, refresh and pre-enforcement family. Missing assurance fails; independent unrelated product credential management remains possible. |
| Recovery | IdP outage, expired certificate, lost factor, missing second custodian, concurrent role removal/ownership handover, emergency connection suspension, recovery proof expiry. No lockout-prone activation or unbounded bypass. |
| Revocation | Each §6.6 credential, open stream and queued/resumed action; dropped/duplicate/reordered/old events; key rotation; expired cursor; UOA outage at freshness boundary; racing refresh/dispatch and connection disable. Exact scope revoked without unrelated-org logout. |
| Migration | Dirty inventory, duplicate/missing stable subjects, UOA email change, deleted/recreated UOA subject, partial rollout/restart, source profile unavailable. No local email writes/merges, false ownership or stale durable fallback. |
| SSRF/abuse | Metadata/link-local endpoints, foreign secret-bearing token endpoint, redirect credential leak, DNS rebinding, key refresh storm, SCIM filter enumeration and limits. |

Use local protocol fixtures (Keycloak OIDC/SAML, SimpleSAMLphp and a malicious
IdP) for automated integration tests; actual vendor readiness needs sandboxes.
Run the applicable OpenID Foundation RP conformance tests. Before claiming a
preset supported, test the configured Entra tenant including guest behavior,
Okta org/custom server separately, Google Workspace and AD FS on the relevant
test infrastructure. These are planned checks, not completed evidence.

Headless end-to-end journeys must cover setup → test → activate → domain proof
→ explicit discovery/recovery/enforcement; Nessie Login / Register and tile
entry; account linking without global escalation; exact-org/team reauth;
admin/owner capability differences; simple preset setup without raw claims or
advanced fields in the main flow; UOA-only activation with no Nessie billing
gate; SCIM removal ending a browser session and
long-lived grants through webhook and missed-event fallback; recovery during
an IdP outage. Include mobile-width layouts for changed web surfaces, and
native journeys only when native inputs change. Save sanitized screenshots
and result artifacts with exact revisions and configuration.

## 11. Rollout, migration and operations

Keep enterprise activation off until §9 gates pass. Prepare additive schema and
API capabilities first; deploy the consumers and verify the signed product
configuration they actually serve. UOA is deployed separately from Nessie;
follow `Docs/deployment.md` and Nessie's production promotion rules. No change
to a local plan or merged branch proves a live IdP flow works.

Backfill old assurance as `unknown`, never guessed SSO. Migrate old unscoped
grants through fresh proof or exact targeted revocation, without global epoch
bumps for org-local policy. Roll out internally, then one opted-in pilot per
protocol, with measured admission/revocation bounds before broader enablement.
Do not enable a preset merely because its setup form exists.

Use monotonic policy/connection generations. Turning the feature off stops new
enterprise authentication and fails enforcing scopes closed while preserving
recovery; it cannot restore a revoked session, copied identity table or password
bypass. Rollback must preserve revocation, ownership and migration decisions.
Do not restore old email-keyed authentication after the stable-subject cutover.

Runbooks cover certificate/key rotation; IdP outage; domain lapse/reclaim;
compromised connection; lost recovery factor; unresolved migration binding;
membership/move requests; webhook/feed backlog and expired cursor; UOA outage;
legacy credential renewal; and exact deployed-state verification. Repair retry
workers so stuck delivery or migration work recovers in place. Do not cancel,
delete or hand-edit stuck records to disguise an implementation bug.

Social `AuthIdentity` migration remains a separate plan because its per-domain
`userKey` and existing recovery contracts need their own data audit. Deferral
does not authorize reusing email-based social linking for the new enterprise
path. Track any legacy path that can elevate enterprise-derived proof as a
blocking defect until the boundary is enforced.

## 12. Decision register

Record actual decisions and the resulting contract before enabling dependent
functionality. UOA-only enablement and exclusion from Nessie billing are
confirmed. The user has answered the five product decisions and delegated the
recovery implementation choice.

| Decision | Current status | Recommendation / implementation boundary |
|---|---|---|
| UOA sole broker, authority and management | Confirmed: SSO can be enabled only from UOA. | UOA owns connection setup, activation, enforcement and revocation. Nessie exposes only live status and its UOA doorway; integration capability advertisement is not a second enablement control. |
| Enterprise self-hosted packaging | Internally managed. | Use a supported UOA deployment. Deployment and commercial arrangements are handled internally; add no separate broker, installer or self-service packaging flow. |
| Contractors/unverified organisation email domains | Default off, confirmed by the user. | Any explicitly enabled exception still needs verified address, stable tenant proof and explicit admission. Existing-account proof never relaxes. |
| Recovery | Implementation choice delegated; two narrow independent custodians selected. | Keep one canonical owner and no backup codes. Recovery grants only the named product/org's SSO repair capability, with fresh independent authentication and a tested continuity path before enforcement. |
| SSO and SCIM billing | Custom commercial arrangements for now, managed in UOA. | No Nessie subscription, plan-tier or pricing gate. UOA owns custom enablement for SSO and SCIM; add no alternative billing subsystem or public tier matrix. |
| Simple administration | Confirmed user requirement. | Short guided presets, essential inputs, plain test outcomes and next actions, secondary advanced diagnostics, clear recovery readiness and one UOA owning surface. |
| Pre-auth domain discovery | Earlier corporate-domain plan says no; amendment is proposed. | Explicit product and org opt-in, domain-only disclosure. Start URLs work without approving discovery. |
| Cross-origin connection/domain-claim scope | Current code supports cross-origin contexts; old claim proposal derives origin domain. | Freeze and implement exact consuming-domain/org binding before extending to these orgs. No copied org or implicit global policy. Origin-only activation can be a stated first slice. |
| Global account and profile authority | Safety invariant, not optional auto-link convenience. | Independent proof for existing accounts; enterprise assurance cannot elevate to global credentials/profile control. Audit current recovery before first activation. |

## 13. Evidence and limits

Implementation has progressed beyond this document-only revision. Current wire contracts and verification limits are recorded in [the enterprise SSO integration guide](../Auth/enterprise-sso.md). UOA activation remains held until Nessie completes its authority migration and integrated source/revocation journeys; the original document review is not a release approval.

Local code evidence in §3 establishes the starting implementation, not vendor
compatibility or production state. The original source reports Fable's review;
the initial documentation-only revision did not rerun that tool or execute a
provider sandbox, conformance suite, browser journey, database migration or
production flow. Subsequent implementation verification is recorded in the
integration guide linked above.

Protocol corrections were checked against the linked primary OIDC, OAuth issuer,
SAML, SCIM, Microsoft and Google documents on 2026-10-17. Recheck actual provider
application settings and current library behavior during implementation. A
standard allowing an option is not proof every preset supports it.

The following research claims remain excluded from readiness decisions:
market-share percentages; earlier draft 2026 CVE numbers; claims about Entra
gallery submissions; Google custom-OIDC availability by customer configuration;
JumpCloud/Duo MFA formats; arbitrary providers' SCIM subject transforms; fixed
vendor delete schedules; and untested OIDC/SAML variant compatibility. Do not
repeat them as established facts to justify launch.

## 14. Documentation amendments required with implementation

This table records the amendment inventory established before implementation.
Use the current integration guide and affected source documents for their
implemented contracts and remaining release gates. Preserve historical text
where UOA rules require additions, and label superseded instructions explicitly.

| Existing document/contract | Required amendment |
|---|---|
| `Docs/Requirements/roles-and-acl.md` Microsoft proposal | Replace `common`, unenforced `tid`, UPN/email identity and same-email merge with exact tenant, stable subject and independent proof (§4, §6.3). |
| Same document's SCIM proposal | Replace global email matching, `User.scimExternalId`, `/internal/admin` provisioning tokens, automatic teams and shared-profile renames with §6.9. |
| `Docs/techstack.md` provider list | Distinguish shipped social providers from planned enterprise presets. |
| `Docs/brief.md` §24.2 and related ReBAC notes | Flag “Organisation.domain removed” as unimplemented; preserve the shipped origin-domain/cross-product model and §24.14 multiple memberships. The July index was dropped by the September migration. Correct stale schema comments and older placement text rather than reinstating the old constraint. |
| `Docs/Research/api-changes-rebac.md` | Retain proposed `method=sso` vocabulary where compatible, but distinguish proposed token shapes from current flat/context contracts; publish exact assurance extension in actual API schemas. |
| `Docs/plans/2026-08-20-corporate-domain-auto-enrolment.md` | Mark its proposed/shipped state accurately; replace retired one-active-org assumptions; reuse claim/continuation design; explicitly amend discovery and cross-origin scope only when decided; preserve new-account-only corporate auto-enrolment and owner contract unless separately amended. Enterprise JIT is a different authorized policy, not an excuse to resurrect removals. |
| `CLAUDE.md`, brief security/credential rules | Narrowly document encrypted enterprise connection credentials; preserve no-backup-codes until explicitly changed. Update globals across development machines only if a global rule actually changes. |
| UOA auth/API/Admin architecture and token/subject/broker/native docs | Add scoped provenance, exact assertion contract, capability/owner distinction, lifecycle and error behavior, audience and expiry semantics. |
| `API/src/routes/root/index.ts` and `API/src/routes/root/llm.ts` | Publish every actual new/changed endpoint and claim alongside implementation; illustrative paths here are not a shipped API. |
| Nessie brief, team-model, UOA unification and organisation-admin standards | Record removed authority mirrors, stable-reference migration, unchanged owner/admin product parity and explicit upstream owner constraints; replace email-adoption assumptions. |
| Nessie focused gates, navigation, credential/run/trigger docs | Add real reachable surfaces, selected-team boundaries, exact revocation lineage and acceptance tests; no browser suites in CI. |

## 15. Traceability of the 19 reported review findings

“Addressed in plan” means the design response is written. It does not mean
implementation, tests, deployment or a fresh adversarial review has passed.
Several source resolutions needed stronger corrections during this revision.

| # | Reported finding | Resolution in this revision | Remaining proof |
|---|---|---|---|
| 1 | Product-scoped UOA orgs; domain uniqueness | §§1, 3, 5, 14 correct the source inference: org origin is not a universal access scope; supported cross-origin contexts remain. Connections/policies explicitly name consuming domain and org. | Scope/domain-claim contract and race/migration tests; do not duplicate orgs. |
| 2 | One active org per user/client domain | **Superseded by current code.** §§1, 3, 6.4 cite the September migration dropping that index and brief §24.14. Authorized multiple memberships remain; JIT never moves/deactivates another org membership. | Concurrent login/SCIM/invite, authorized second same-origin org and exact context selection tests. |
| 3 | Enforcement choke point; credential routes | §§5, 6.5 cover both wrappers, underlying direct lookup, management boundaries and route registry. `tv` is expressly insufficient assurance. | Published assurance wire contract and every issuance/consumption path tested. |
| 4 | Shared-issuer tenant pin | §§4, 6.2, 10 require signed tenant proof, including Google `hd`, independent of contractor/email policy. | Per-preset positive and malicious-tenant sandboxes. |
| 5 | Global `tokenVersion` | §§3, 6.5–6.6 separate scoped policy/revocation from global lifecycle/credential epochs. | Unrelated org/product remains usable after local revoke. |
| 6 | Email linking, lapse, `user_scope`, oracle | §§5, 6.3 forbid all existing-account email auto-linking, preserve scope, require independent proof, fail closed on dependent-domain lapse and protect global profile/recovery. | Global escalation, mailbox recycling and privacy regressions. |
| 7 | Nessie long-lived credentials; webhook key | §§6.6, 8.5, 9 deliver exact lineage, dedicated signing keys, durable feed and use-time checks before live SSO. | Every consumer and missed-event bound measured. |
| 8 | Contradicting UOA specs | §§3, 14 name Microsoft/SCIM, ReBAC/origin-domain, continuation status and recovery contradictions. | Amend actual source-of-truth docs with implementation. |
| 9 | Session/connection link; max age | §§5, 6.2, 6.6 distinguish UOA completion from provider authentication and preserve exact derived provenance/absolute expiry. | Rotation, silent round trip, force, outage and parent-expiry tests. |
| 10 | SSRF and limits | §7 extends the existing pinned fetcher to every endpoint and forbids secret-forwarding redirects. | DNS/redirect/oversize/refresh-storm regressions. |
| 11 | OIDC gaps | §§4–6.2 cover exact tenant/audience/issuer, conditional `at_hash`, typed UserInfo, authenticated client method and state-bound nonce. | RP conformance and provider-specific configuration evidence. |
| 12 | SAML validation and stable entity ID | §§4–6.2 and 7 preserve stable SP identity, validate the signed node/correlation/time, defer unsolicited SAML and remove unsafe canonicalization advice. | Attack corpus, cert rollover and encrypted-ID interoperability. |
| 13 | SCIM subject transform; password-reset bypass | §§6.3, 6.5, 6.9 use proven immutable reconciliation, no email fallback, scoped admission and independent global credential proof. | Provisioning race plus reset/registration/invite bypass tests. |
| 14 | `/auth/start` and discovery decision 7 | §6.1 keeps a dedicated proposed endpoint and explicit product/org consent; start URLs remain available. | Decision approval, no-account-oracle and target-binding tests. |
| 15 | Nessie team enablement, email uniqueness, errors | §§6.4, 8.3–8.4 keep exact team enablement/errors and replace local email writes/merges with authority migration. | Dirty-data migration and real login/team-switch journeys. |
| 16 | Recovery lockout and carve-out | §§6.5, 12 retain one canonical owner and select two narrow independent custodians; backup codes remain prohibited. | Implemented authority model and independent recovery drill before enforcement. |
| 17 | Settings surface; audit/2FA reuse; allowed domains | §§5, 6.7–6.8 reuse UOA foundations, explicitly build continuation and preserve upstream owner contract with Nessie parity. | Capability, fresh-proof, translations and doorway tests. |
| 18 | Membership source; teams vs Groups | §§5, 6.4, 6.9 use independently revocable source contributions, existing UOA teams and no resurrection/elevated-owner mapping. | Overlapping-source and incomplete-group tests. |
| 19 | Scope cuts | §§1, 4, 5, 11 retain seven presets, separate social migration, no extra nonce store or unnecessary OIDC encryption keys; optional capabilities stay gated. | Each claimed preset has evidence; no deferred path silently enabled. |
