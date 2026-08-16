# Central OAuth & Auth Service — Full Build Brief

## 1. Purpose

Build a **centralized OAuth / authentication service** used by multiple products (4–5+), providing:

- Unified login across products
- Configurable branding, UI, and languages per client
- Multiple auth methods (email/password + social)
- Optional 2FA
- Secure, tamper-proof configuration
- Zero admin UI requirement for client onboarding

This service is **stateless where possible**, standards-based, and API-first.

> **Tech Stack:** For technology choices and project structure, see [techstack.md](./techstack.md).

---

## 2. Core Principles

- **Email is the canonical user identifier**
- **One user = one email**, regardless of login method
- **No email enumeration**
- **No public secrets**
- **All client config is signed and verified**
- **Everything UI-related is templated**
- **Everything is configurable externally**
- **OAuth server holds minimal state**
- **No avatars stored locally**
- **Tailwind-only UI**

---

## 3. Architecture Overview

### Components

1. **OAuth/Auth Server (Central)**
   - Issues tokens
   - Renders auth UI
   - Verifies config integrity
   - Handles users, passwords, 2FA

2. **Client Applications**
   - Generate signed config
   - Open OAuth popup
   - Receive auth result

3. **Email Service**
   - Verification
   - Password reset
   - Login/registration flow

4. **AI Translation Service**
   - Fallback for missing translations
   - Cached permanently after generation

---

## 4. Client Identification & Trust Model

### Client Identity

- Each client is identified by a **verified domain**
- The **hash of (domain + shared secret)** is the **client ID**
- First user on a new domain becomes **superuser**

### Shared Secret

- One **shared secret**
- Stored as:
  - Client backend environment variable
  - OAuth server environment variable

- Never exposed publicly

### 2026-04 Admin Update: Domain Client Secrets

- Domain-scoped backend auth now uses **per-domain client secrets** managed in Admin > Domains & Secrets.
- The domain bearer token is still derived as `SHA256(domain + domain_client_secret)`, but the auth server stores only a server-peppered digest of that derived hash plus a short display prefix.
- The legacy global `SHARED_SECRET` is **not accepted** as customer/domain bearer auth.
- `SHARED_SECRET` remains a server-internal/self-login secret until token signing, email-token hashing, social state, 2FA, and refresh-token hashing are split onto dedicated keys.

---

## 5. Config Delivery & Integrity

### Config Format

- Config is delivered as a **JWT**
- Payload contains **all configuration**
- JWT is signed using the shared secret

### Why JWT

- Payload = config
- Signature = tamper protection
- No separate hash field required

> **2026-04 config-signing update:** The original shared-secret config-signing text is superseded. Config JWTs are signed with RS256, include a `kid`, and are verified with the auth service's configured JWKS. Config trust is based on the verified signature plus exact `domain` / `config_url` hostname match.

### Verification Flow

1. Client generates JWT config
2. OAuth server verifies JWT signature
3. If invalid → request rejected
4. If valid → config trusted

---

## 6. Config Contents (JWT Payload)

### Required

- `domain`
- `redirect_urls`
- `enabled_auth_methods`
- `ui_theme`
- `language_config`

### Optional

- `2fa_enabled`
- `debug_enabled`
- `user_scope` — `"global"` (default) or `"per_domain"`
- `org_features` — feature-gated organisations/teams/groups configuration (default: disabled)

`allowed_social_providers` has been merged into `enabled_auth_methods`. Social provider names in `enabled_auth_methods` are both enabled and allowed; clients must not send a separate `allowed_social_providers` field.

---

## 7. UI & Theming

### Rendering

- OAuth UI is rendered server-side
- Fully Tailwind-based

### Customizable

- Colors
- Corner radii
- Button styles
- Card styles
- Typography
- Logo — image URL **or** text with configurable font size, color, and custom CSS styles
- Layout density

### Theming Source

- All UI properties come **only from config**
- No hardcoded client styles

---

## 8. Language & i18n

### Language Config

- Either:
  - Single language (no selector)
  - Array of languages (dropdown enabled)

### Language Selection

- Defaults to language selected on client website
- Dropdown shown only if multiple languages provided
- Client passes the selected language via optional config claim: `language` (must be one of `language_config` when `language_config` is an array)

### Translation Fallback

1. Missing translation detected
2. Translation file sent to AI
3. AI returns translated version
4. Translation cached permanently
5. Used for all future requests

---

## 9. Authentication Methods

### Supported

- Email + Password
- Google
- Apple
- Facebook
- GitHub
- LinkedIn

### Enablement

- Controlled per-client via config
- Any combination allowed

### Account Unification

- All providers resolve to **email**
- Same email = same user
- Logging in via different providers merges automatically

---

## 10. Email & Password Auth

### Email

- Email is the username
- Always required

### Password Rules

> **Decision 2026-06-18 (HUGO-147):** Length is the primary strength criterion. A special
> character is **NOT required** (previously it was). This supersedes the earlier rule that
> mandated 1 special character.

- Minimum 8 characters (length is what matters most — longer is stronger)
- Recommended (encouraged, **not** enforced as hard blockers): uppercase, lowercase, number
- Special characters are **allowed but never required**
- A strong alphanumeric-only password (e.g. a 15-char random string) MUST be accepted

### Password UX & Error Transparency (HUGO-147)

The user must always know **why** they can't proceed and **how** to fix it:

- **On set-password / reset-password:** show the requirements live, so the user sees in real
  time whether their password meets them before submitting.
- **On login:** a valid password must never be rejected ("don't harass the user"). If sign-in
  fails, tell the user the real reason in a clear, localized message — never a generic or
  misleading one (e.g. "Something went wrong. The link may have expired." must not be shown
  for a password-policy or credentials failure).
- This requires the API to surface a machine-readable, distinguishable error code (not a single
  generic body) so the UI can map it to a specific message.

### Password Storage

- Standard secure hashing
- No plaintext ever stored

---

## 11. Registration & Enumeration Protection

### No Email Existence Checks

- API never reveals:
  - Whether email exists
  - Whether account is registered

### Registration Flow

- User submits email
- Always respond:

  > "We sent instructions to your email"

- Email determines next step:
  - Existing user → login link
  - New user → verification + set password

- **Email copy must remain generic**: subjects and body text must not explicitly indicate whether an account already exists (even though the backend sends different links depending on state)

### Product-Specific Existing-Account UX Opt-In

The default remains strict no-enumeration: existing users receive the same generic registration response and a neutral login-link email. A consuming product may explicitly opt into the tradeoff with signed config claim `existing_user_registration_behavior: "inline_sign_in"`. In that mode, `POST /auth/register` returns a generic public error envelope with machine code `EMAIL_ALREADY_REGISTERED` for an existing user, sends no login-link email, and the Auth UI shows localized copy routing the user to sign in or reset their password. Use this only where the product has accepted the account-enumeration tradeoff.

---

## 12. Email Verification & Password Reset

### Tokens

- One-time
- Time-limited
- Stored hashed
- Every capability issued for an existing user (password reset, 2FA reset, login code, login link,
  existing-user verification/invite link) stores both the exact `userId` and the user's
  issue-time `tokenVersion`. Consumption takes the canonical user-global lock and requires that
  immutable pair to match the live user before any credential, invite, or authentication side
  effect. A credential reset therefore invalidates every sibling capability issued in the prior
  epoch. Legacy existing-user rows with a null epoch fail closed; the migration deliberately does
  not backfill them because their true issue epoch cannot be reconstructed.
- Both `userId` and `tokenVersion` may be null only for a genuine pre-user registration token, and
  that token remains eligible only while its exact `userKey` is still absent. Mixed/null legacy
  bindings are invalid.
- A landing-page check is read-only. Every consuming mutation checks expiry again from a fresh
  clock after acquiring its serialization locks, so a token that expires while waiting cannot
  authenticate, mutate credentials, accept/decline an invite, or create a session.

### Flows

- Email verification
- Password reset
- Both use secure token validation

---

## 13. Two-Factor Authentication (Optional)

### Enablement

- Controlled via config (JWT)
- Config must be signed

### Method

- TOTP (Authenticator apps)

### Setup Flow

1. Generate user-specific secret
2. Generate `otpauth://` URI
3. Render QR code
4. User scans with Authenticator
5. Verify initial code
6. Mark 2FA enabled

### Clarification: Policy and Self-Service Enrollment

- `2fa_enabled` in the signed config JWT is the master gate. If it is false or absent, effective 2FA is off regardless of Admin policy.
- When `2fa_enabled` is true, the effective login policy is resolved from the Service/domain policy, the user's same-domain Organisation policies, and the exact selected Organisation even when a recognized product selected it across domains. The strongest policy wins: `off < optional < required`.
- Recognized products resolve their server-owned exact workspace before 2FA on password, social, email-code, and email-link paths even when `workspace_selection: "off"`; off suppresses only the chooser. Authorization codes persist whether TOTP completed, and exchange rechecks current exact-workspace policy/enrollment transactionally before creating a token family.
- Authorization codes and signature continuations also persist the originating locked
  `User.tokenVersion`. Code redemption and continuation completion require exact equality under the
  canonical user-global lock, so password/2FA reset cannot turn pre-reset TOTP or signature proof
  into a renewable post-reset session. Historical null epoch rows fail closed and are not backfilled.
- A workspace chooser is an authorization continuation, never an authentication method. Its signed login-session capability preserves the verified identity method through workspace selection, 2FA/signature continuations, AuthIdentity updates, and login logging; Google/social sign-ins must not be relabelled as email merely because the user selected a team.
- Email-link and verify-email continuations run workspace choices/placement, exact policy finalization, and immediate code issuance in one admin transaction. Its per-user first-placement lock remains held through commit, so concurrent first use from two products binds one canonical workspace; code-issuance failure rolls placement and code back while the already-consumed one-time email token stays consumed.
- Service/domain policy supports Off, Optional, and Required. Organisation policy supports Inherit, Optional, and Required in Admin; inherited policy does not weaken the domain policy.
- Optional policy lets users self-enroll and requires TOTP verification only for enrolled users. Required policy forces an unenrolled user to complete setup before an OAuth code is granted.
- Self-service setup returns an `otpauth://` URI, a self-contained logo QR, and a short-lived setup token. Enrollment trusts the encrypted secret in the setup token, not any client-submitted plaintext secret.
- Users may disable 2FA only when the effective policy is not Required. Admins may reset a user's 2FA enrollment but cannot view secrets or enroll on the user's behalf.

---

## 14. Tokens & OAuth Output

### Returned to Client

- OAuth access token (JWT)
- OAuth refresh token (opaque, returned to the client backend only)

### Token Contains

- User ID
- Email
- Domain/client ID
- Role (superuser or normal)
- Expiry
- Claims

### Stateless

- No session storage required
- Token verification via signature

### Short-Lived

- Access tokens must be **short-lived** (see **22.10 Token Lifetimes**; e.g. 15–60 minutes)
- Refresh tokens are supported for **client backends only** and must be rotated on every use
- Browser clients must never receive or persist refresh tokens directly

---

## 15. User Model

### Fields

- `id`
- `email`
- `password_hash` (nullable for social-only)
- `name`
- `pronouns_preset` (nullable enum: `he_him`, `she_her`, `they_them`, `any_pronouns`, `ask_me`, `prefer_not_to_say`, `custom`)
- `pronouns_custom` (nullable string, required when `pronouns_preset = custom`)
- `role` (superuser / user)
- `2fa_enabled`
- `2fa_secret` (encrypted)
- `created_at`

### Pronouns

- Pronouns support both **preset values** and a **custom free-text fallback**
- `pronouns_preset` should be used for common values and filtering/UI consistency
- `pronouns_custom` is used only when `pronouns_preset = custom`
- If `pronouns_preset` is not `custom`, `pronouns_custom` should be `null`
- Pronouns are part of the user profile and follow the same user scope rules as the rest of the user record

### Avatar

- **No avatar storage**
- Store only external avatar URL
- Update avatar URL on every login

---

## 16. Login Logging & Auditing

### Log Fields

- User ID
- Email
- Domain
- Timestamp
- Auth method
- IP (optional)
- User agent (optional)

### Access

- API endpoint
- Requires **domain hash token**

---

## 17. Domain-Scoped APIs

### Protected APIs

- List users for domain
- Get login logs
- Debug endpoints

### Authorization

- Requires token = hash(domain + secret)
- Verified server-side

---

## 18. Superuser Rules

- First user on a domain becomes superuser
- Superuser gets:
  - Debug access
  - Domain-level visibility

- No global admin UI required

---

## 19. Security Summary

- Shared secret never exposed
- All configs signed (JWT)
- Domain verification required
- No enumeration vectors
- Stateless tokens
- Short-lived secrets
- Standard crypto primitives only

---

## 20. Non-Goals (Explicit)

- No admin dashboard
- No local avatar storage
- No per-client OAuth secrets
- No user-visible error specificity
- No unsigned configs accepted

---

## 21. Output of This System

- Reusable OAuth popup
- One auth backend for all products
- Config-driven UI + security
- Minimal operational overhead
- Scales horizontally

---

## 22. Clarifications & Constraints

The following tighten ambiguities in the brief to prevent misinterpretation during implementation.

---

### 22.1 Config URL Fetching & Trust Boundary

- The OAuth entrypoint **always starts with a config URL fetch**
- The client provides a URL pointing to the signed JWT config
- The auth server fetches the config from that URL, verifies it, then proceeds
- Config is **never** POSTed directly, embedded in query params, or stored centrally on the auth server

---

### 22.2 JWT Audience / Issuer Expectations

- The config JWT is used for **config delivery only** — it is not a user token
- The config JWT does **not** require an `aud` claim
- `exp` is **optional** on config JWTs (configs are verified on every request, not cached by trust)
- Config trust is based on the verified JWT signature and exact `domain` / `config_url` hostname match
- Do not reuse user-token validation rules for config JWTs — they are separate concerns

---

### 22.3 Shared Secret Scope

- There is a **single global shared secret** for all clients
- There are **no per-client secrets**
- There is **no secret rotation UI**
- There are **no storage tables for secrets**
- The secret lives exclusively in environment variables on both the client backend and the auth server
- Superseded for domain-scoped bearer auth by the 2026-04 Admin Update above. Keep this historical scope in mind for remaining internal token/signing uses only.

---

### 22.4 Domain Verification Timing

- Domain verification is **deterministic and repeatable**
- It happens **on each auth initiation** — not once, not async, not cached
- There is no persistence of "verified domains"
- There is no retry logic or admin approval flow
- The domain is verified by checking the JWT config signature and matching the `domain` claim

---

### 22.5 Superuser Race Condition

- The first **successfully created** user row for a domain wins superuser status
- Race conditions are resolved at the **DB constraint level** (unique constraint, first insert wins)
- No locking, queues, or moderation flows
- Superuser assignment applies regardless of whether the first login is via social or email/password

#### Admin-domain bootstrap allowlist (optional)

- No allowlist is required. By default the **first** successful login on `ADMIN_AUTH_DOMAIN` bootstraps the initial `SUPERUSER` (the chicken-and-egg exception that lets a registration-disabled Admin panel gain its first operator).
- An **optional** allowlist is supported via the `ADMIN_BOOTSTRAP_EMAILS` env var (comma-separated emails):
  - **Unset / empty** — any first admin-domain login is accepted as superuser (default behaviour above).
  - **Set** — only a listed email may bootstrap the initial superuser; every other first login on the admin domain is blocked.
- The allowlist only gates the **initial** bootstrap on `ADMIN_AUTH_DOMAIN`. Once a `SUPERUSER` exists, the normal registration policy applies and the allowlist is irrelevant. Customer domains are never affected.

---

### 22.6 Social Login Email Trust

- Only **provider-verified emails** are accepted from social login providers
- If a social provider returns an unverified email, the login is **rejected**
- This prevents account takeover via unverified email claims

---

### 22.7 Avatar Update Policy

- The stored avatar URL is **overwritten on every login** with the latest from the provider
- No avatar history is kept
- No fallback storage
- No caching policy — the URL is simply stored and served as-is

---

### 22.8 Login Logs Retention

- Login log retention is **implementation-defined, but must be finite**
- No infinite retention
- No GDPR deletion workflows required at this stage
- A reasonable default (e.g. 90 days) should be configured and documented

---

### 22.9 2FA Recovery / Reset

- There are **no backup codes**
- There are **no admin overrides** for 2FA
- There are **no support workflows** for lost devices
- The only recovery path is **email-based 2FA reset**: user verifies email ownership, then 2FA is disabled so they can re-enroll

---

### 22.10 Token Lifetimes

- Access token TTL: **implementation-defined, short-lived** (e.g. 15–60 minutes)
- Refresh token TTL: **implementation-defined, bounded** (1–90 days; default 30 days)
- Login-session chooser JWTs and 2FA challenge/setup JWTs are verified once for routing, then
  verified again with a fresh clock after the product-policy and user-epoch locks that guard their
  consuming action. Expiry while waiting on a lock must fail before chooser reads, invite changes,
  secret decryption, TOTP verification/enrollment, or authorization-code issuance.
- Silent reauth is allowed **server-side only** via the refresh-token grant
- Refresh tokens must be **opaque, hashed at rest, and rotated on every use**
- A just-rotated predecessor may recover the exact deterministic live successor
  for 120 seconds only when the product re-authenticates and supplies the exact
  original client context; policy is re-run and no new row is created
- Reuse after that response-loss window must revoke the entire token family and increment the
  user's access-token version. A corrupt successor chain whose family boundary cannot be trusted
  must fail closed by revoking all refresh state for that user and incrementing the same version.

---

### 22.11 Error Handling Philosophy

- **All auth failures return generic user-facing errors**
- The system must never leak:
  - "2FA failed"
  - "Wrong provider"
  - "Email already exists"
  - "Invalid password"
  - Or any other specific failure reason
- Internal logs may contain specifics; user-facing responses must not
- A single generic message such as "Authentication failed" is used for all error cases

---

### 22.12 User Scope

- The `user_scope` config property controls whether users are **global** or **per-domain**
- Default: `"global"`
- **Global** (`"global"`):
  - One user = one email across all domains
  - Password, 2FA, and profile are shared
  - Roles (superuser / user) are **per-domain** — a user can be superuser on domain A and normal on domain B
  - Logging into a new domain with an existing email reuses the same account
- **Per-domain** (`"per_domain"`):
  - Users are scoped to the domain they registered on
  - The same email on two different domains creates two separate user records
  - Password, 2FA, and profile are independent per domain
  - No cross-domain account sharing

---

### 22.13 OAuth Flow Type

- The OAuth flow uses the **authorization code flow**
- The popup redirects back to the client with a **code**
- The client backend exchanges the code for an access token (JWT)
- This is the standard, more secure approach
- The token is **never** returned directly to the frontend via the popup
- Clients must have a backend callback endpoint to complete the exchange
- The code exchange endpoint must require backend-only authorization (derived from the shared secret)
- The flow accepts an optional opaque **`state`** on the call that begins it and
  echoes it verbatim beside `code` on the final redirect, and beside `error` on a
  failed social callback. UOA never interprets the value. It is bound to the login
  for the whole flow — the `login_token` chooser capability, the 2FA challenge and
  enrolment bridges, the signed social state, and the signing continuation all
  carry it — and a later hop that presents a *different* value is refused, so no
  mid-flow step can retarget which `state` the callback will echo. `state` is
  optional and a request without it behaves exactly as before. **PKCE and `state`
  are not substitutes**: PKCE protects the code exchange, `state` protects the
  redirect binding against login-CSRF. Integrator instructions live in the `/llm`
  guide, §3.1 "Carrying CSRF state across the callback".

---

### 22.14 Public-client / MCP OAuth profile (2026-05 addition)

A second, **opt-in** OAuth profile is added alongside the config-JWT flow above, so
that standards-based public clients — in particular Model Context Protocol (MCP)
clients such as IDE/desktop/mobile AI assistants — can authenticate users without a
client-supplied config URL or a shared secret. It is served under a distinct
`/oauth/*` path family and **does not change the existing config-JWT flow** (§4, §5,
§22.1–§22.13), which remains the default. The config-JWT flow stays the only way to
reach the existing `/auth/*` endpoints.

**Explicit public-profile gate.** The public profile is disabled by default and
requires `MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true`. A configured RS256 access-token
signing key by itself only enables token signing and `GET /oauth/jwks.json`; it
MUST NOT enable discovery, dynamic registration, authorize, login, or the public
PKCE token endpoint. Enabling the public flag also requires the signing key and
dedicated `MCP_OAUTH_DOMAIN`; invalid or incomplete configuration fails closed.

This profile **qualifies** specific rules above, scoped to `/oauth/*` only:

- **Config source (qualifies §22.1).** There is no client-supplied `config_url`.
  `/oauth/*` uses a single **first-party config** supplied to the auth service via
  environment (`MCP_OAUTH_*`): its `domain`, `enabled_auth_methods`, `ui_theme` and
  `language_config`. No config is fetched, POSTed, or trusted from the client. The
  config-JWT trust boundary (§22.1, §22.4) is untouched for `/auth/*`.
- **Registered public clients (qualifies §29 "minimal state" / §22.1 "never stored
  centrally").** Clients self-register via RFC 7591 Dynamic Client Registration
  (`POST /oauth/register`) and are stored as **`OAuthClient`** rows holding only a
  random public `client_id`, `redirect_uris`, and a label. There are **still no
  per-client secrets** (§22.3 preserved) — these are PKCE public clients
  (`token_endpoint_auth_method: none`). The only new central state is the
  redirect-URI allow-list per public client, which is the minimum required to make
  the redirect step safe.
- **Public token endpoint (qualifies §22.13).** `POST /oauth/token` performs the
  authorization-code (and refresh-token) grant with **PKCE only and no shared-secret
  / domain-hash authorization**, because public clients cannot hold a secret. PKCE
  S256 is mandatory (as it already is for code issuance). The shared-secret-gated
  `/auth/token` authorization-code and refresh-token grants are unchanged; §22.15
  adds one confidential, domain-authenticated grant alongside them.
- **Resource-bound RS256 access tokens (qualifies §14, §22.3).** Tokens issued by
  this profile are signed **RS256** with a dedicated auth-service access-token key
  (`MCP_OAUTH_ACCESS_TOKEN_*`) and carry an **`aud`** equal to the RFC 8707
  `resource` the client requested, so any resource server can validate them
  statelessly via the published access-token JWKS (`GET /oauth/jwks.json`) without
  the shared secret. This is **separate** from the HS256 client-domain tokens (§14)
  and from config-JWT verification (§22.2); the existing tokens and `/.well-known/jwks.json`
  (config keys) are unchanged. Discovery metadata is served per RFC 8414 at
  `GET /.well-known/oauth-authorization-server`.

Everything else (short-lived access tokens §22.10, opaque rotated refresh tokens,
generic error philosophy §22.11, 2FA, social login, user scope §22.12) applies to
this profile unchanged.

**Dedicated profile domain (security hardening).** `MCP_OAUTH_DOMAIN` is **required**
whenever this profile is enabled. It MUST be a dedicated first-party domain that is
**distinct from `ADMIN_AUTH_DOMAIN`** and from any customer domain. The auth service
**fails closed** (the whole `/oauth/*` flow errors) if `MCP_OAUTH_DOMAIN` is unset or
equals the admin domain — there is no fall back to the admin domain. This prevents an
MCP login from bootstrapping a `SUPERUSER` domain-role on the admin domain (which would
bypass the `ADMIN_BOOTSTRAP_EMAILS` control that only guards the Google social path).

**Resource allowlist (RFC 8707, confused-deputy mitigation).** The client-supplied
`resource` becomes the token `aud`, so it is validated against an optional allowlist
`MCP_OAUTH_RESOURCES_SUPPORTED` (comma-separated, case-sensitive resource-server URIs).
When a client supplies `resource`, it MUST exactly match one of the allowlisted values;
otherwise the request is rejected with `invalid_target` (HTTP 400). When the client
supplies no `resource`, the token `aud` falls back to the issuer as before. The
allowlist (when configured) is advertised in the RFC 8414 discovery metadata; when
unset, no unconstrained resource support is advertised.

### 22.15 Confidential subject-token exchange (2026-07 addition)

`POST /auth/token` also accepts a narrowly configured RFC 8693-style confidential
exchange. It exists for a trusted product backend to turn a short-lived,
source-signed UOA user assertion, optionally scoped to a workspace, into a
resource-bound RS256 access token. Nessie, DeepWater, DeepSignal, DeepTest, and
future products each authenticate this request with their own existing
per-domain app credential; a shared cross-product credential is forbidden. The
credential authenticates the app while the signed assertion carries user and
optional organisation/team context. This grant does not replace or alter the
authorization-code and refresh-token grants.

The caller must pass the normal verified `config_url` and per-domain hash bearer,
plus:

```json
{
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token": "<RS256 JWT>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "product": "nessie",
  "resource": "https://ledger.unlikeotherai.com",
  "scope": "ai.invoke billing.read"
}
```

The subject assertion is verified against the `jwks_url` published by the
already-verified source config JWT. That JWKS URL must use HTTPS, remain on the
source config domain, pass the public-destination SSRF checks, and contain the
assertion's RS256 `kid`. The assertion has an exact source-domain `iss` and
`source_domain`, exact `aud = PUBLIC_BASE_URL + "/auth/token"`, stable UOA `sub`,
non-empty `jti`, mandatory nonnegative integer `tv` (including epoch zero), and
`iat`/`exp` no more than 60 seconds apart. UOA locks the exact user and requires
`tv` to equal the live credential epoch; omission never defaults to zero. `active` is
optional so first-time or workspace-less product users can still be delegated.
When present it must be exactly `{ orgId, teamId }`, with both identifiers
non-empty; partial, null, or extra-field workspace objects are invalid.

An app-to-app chain uses the same endpoint without sharing app credentials. For
example, when Nessie has already obtained a UOA token whose audience is exactly
the DeepSignal API origin, DeepSignal authenticates the next exchange with
DeepSignal's own config and per-domain app credential and sends:

```json
{
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token": "<UOA-issued Nessie delegation for DeepSignal>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "product": "deepsignal",
  "resource": "https://ledger.unlikeotherai.com",
  "scope": "ai.invoke"
}
```

For this chained profile, UOA verifies its own RS256 `at+jwt` signature, exact
UOA issuer and expiry, and exact `aud = https://<authenticated DeepSignal config
domain>`. The inbound `source_domain` and `azp` must agree. `org` and `active`
are mandatory, must select the same organisation and team, and are never
replaced with DeepSignal-local tenancy. UOA revalidates the inbound source
product mapping and, for a nested chain, checks stable user/source-domain role,
ACTIVE organisation, and ACTIVE selected team under the ultimate signed origin
at the tail of `act`. It also resolves the immediate caller's separate mapping.
The requested scope must be allowed by that caller mapping and be a subset of
the inbound scope. The inbound token must also carry an explicit nonnegative
integer `tv`, including zero; UOA compares it with the locked live user epoch
and propagates that exact epoch into the narrowed token.

Delegation policy is DB-backed, not process configuration. Each mapping binds
one registered `ClientDomain` plus lowercase product identifier to one exact
HTTPS resource and a non-empty allowlist containing only `ai.invoke`,
`billing.read`, and/or `token.provision`. Token provisioning is a distinct,
explicit app capability and is never implied by `ai.invoke`.

`token.provision` authorises token provisioning against the product's own
HTTPS `resource`. It does not reach UOA's own `/org/*` surface; that surface
authenticates the domain pairing directly (§24.8) and accepts no resource
token. The domain-hash middleware retains the authenticated
`ClientDomain.id`, so another product's credential cannot select this mapping;
secret rotation remains valid because policy does not bind plaintext,
client-hash, digest, or an individual secret row. The request must name the
product, resource, and exact space-delimited scope subset. Unknown or disabled
mappings, disabled source domains, cross-domain/cross-product credentials,
inexact resources, duplicate/unsupported scopes, and scope widening all fail
closed. There is no singleton env fallback.

Superusers manage this allowlist through audited
`/internal/admin/confidential-delegations` list/create/update/delete endpoints.
Source domain and product are immutable after creation (delete and recreate to
rebind); resource, scope allowlist, and enabled state are mutable. API responses
and audit metadata contain policy only and never expose domain credential
material.

The authenticated Admin panel exposes this policy under Settings → Delegation
mappings. It uses the existing same-origin admin session internally and never
asks an operator to copy, decode, or reveal a browser token. The visible
controls cover list, create, mutable-field update, enable/disable, and guarded
delete; domain/product immutability is explained in the edit form.

Before every issue, UOA re-resolves the current user and source-domain role.
When `active` is present, UOA additionally re-resolves the requested ACTIVE org
and team memberships. Unknown users, missing domain roles, and
removed/deactivated or cross-tenant selected workspaces fail closed.

Each verified source-signed JWT assertion is one-time. After the current user, source-domain role,
and any selected workspace pass validation, UOA atomically claims the
source-domain + `jti` in PostgreSQL before signing. Concurrent or later reuse of
that assertion is rejected, including across service instances. The replay row
retains only a SHA-256 digest of the source-bound `jti` through `exp` plus the
accepted clock tolerance, after which it is eligible for pruning. A source must
mint a fresh, unique `jti` for every exchange.

An access-token subject is instead reusable until its `exp`. This is required
for normal concurrent and multi-process MCP/API calls and does not weaken the
binding: only the app authenticated for the token's exact audience may exchange
it, and neither scope nor lifetime can widen.

The result is an at-most-five-minute RS256 access token using the §22.14 access-token
signing key and `GET /oauth/jwks.json`. It contains `iss`, resource `aud`, stable
`sub`, advisory `email`, `source_domain`, non-secret `azp` (immediate caller domain),
`product`, the exact requested `scope`, `jti`, `iat`, and `exp`. The issued scope
is never widened to the mapping's full allowlist. When a workspace was selected
it also contains the current `org` and selected `active`; both claims are
omitted together for an identity-only exchange.
For a chained exchange, the token never outlives the inbound token and includes
an RFC 8693 `act` chain preserving upstream source/product provenance (the first
Nessie→DeepSignal hop is
`{ "sub": "api.nessie.works", "product": "nessie" }`).
It deliberately contains no `client_id` and never copies the 64-character
domain-hash bearer credential. This grant issues no refresh token.

Confidential exchange does not use the legacy shared 10/minute/IP `/auth/token`
bucket. After domain-hash authentication it is limited to 600 exchanges per
source domain per minute; after the assertion signature is verified it is also
limited to 60 exchanges per source-domain user per minute. Invalid assertions
still consume the authenticated domain bucket.

---

**This brief is the single source of truth for implementation.**

---

## 24. Organisations, Teams & Groups

### 24.1 Feature Gate & Configuration

Organisation, team, and group behaviour is opt-in via the config JWT claim `org_features`.

The claim is optional and defaults to disabled. The object shape and defaults are:

```json
"org_features": {
  "enabled": false,
  "groups_enabled": false,
  "user_needs_team": false,
  "auto_create_personal_org_on_first_login": false,
  "allow_user_create_org": false,
  "backend_org_management": false,
  "pending_invites_block_auto_create": true,
  "max_teams_per_org": 100,
  "max_groups_per_org": 20,
  "max_members_per_org": 1000,
  "max_members_per_team": 200,
  "max_members_per_group": 500,
  "max_team_memberships_per_user": 50,
  "org_roles": ["owner", "admin", "member"],
  "team_roles": ["owner", "admin", "member"],
  "max_flags_per_app": 100,
  "scim_override_retention": "retain",
  "global_missing_flag_default": "disabled"
}
```

| Field                                     | Type                        | Default                        | Description                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                 | boolean                     | `false`                        | Whether org/team features are enabled for this domain                                                                                                                                                                                                                                                                                         |
| `groups_enabled`                          | boolean                     | `false`                        | Whether groups are enabled (requires `enabled: true`)                                                                                                                                                                                                                                                                                         |
| `user_needs_team`                         | boolean                     | `false`                        | On successful auth, ensure the user ends up in a team. Existing org members with zero teams get a personal team; users with no org get a new personal org plus default team.                                                                                                                                                                  |
| `auto_create_personal_org_on_first_login` | boolean                     | `false`                        | On **first** verified login only, if the user ends up without an org after invite/mapping resolution, create a personal org with them as owner (plus default team per 24.3). One-shot, not a self-heal. See 24.14.                                                                                                                            |
| `allow_user_create_org`                   | boolean                     | `false`                        | Whether end-users may create an organisation with their own access token or through eligible hosted SSO. `false` means org creation is admin-only (via Internal API or domain-hash). See 24.14.                                                                                                                                               |
| `backend_org_management`                  | boolean                     | `false`                        | Whether this domain's product backend may call `/org/*` with **no** `X-UOA-Access-Token`, authorised by the domain pairing alone (24.8). There is no acting user in that mode, so per-user org-role checks do not apply; every mutation is attributed to the backend in the org audit log. Leave `false` unless a backend genuinely needs it. |
| `pending_invites_block_auto_create`       | boolean                     | `true`                         | When `true`, a pending invite matching the user's email suppresses `auto_create_personal_org_on_first_login` so the user is offered the invite choice instead of being force-placed into a fresh org.                                                                                                                                         |
| `max_teams_per_org`                       | integer                     | `100`                          | Maximum teams per organisation (max 1000)                                                                                                                                                                                                                                                                                                     |
| `max_groups_per_org`                      | integer                     | `20`                           | Maximum groups per organisation (max 200)                                                                                                                                                                                                                                                                                                     |
| `max_members_per_org`                     | integer                     | `1000`                         | Maximum members per organisation (max 10000)                                                                                                                                                                                                                                                                                                  |
| `max_members_per_team`                    | integer                     | `200`                          | Maximum members per team (max 5000)                                                                                                                                                                                                                                                                                                           |
| `max_members_per_group`                   | integer                     | `500`                          | Maximum members per group (max 5000)                                                                                                                                                                                                                                                                                                          |
| `max_team_memberships_per_user`           | integer                     | `50`                           | Maximum teams a single user can belong to — also caps JWT size (max 200)                                                                                                                                                                                                                                                                      |
| `org_roles`                               | string[]                    | `["owner", "admin", "member"]` | Allowed org-level roles. Must always contain `"owner"`.                                                                                                                                                                                                                                                                                       |
| `team_roles`                              | string[]                    | `["owner", "admin", "member"]` | Allowed team-level roles — the mirror of `org_roles`, must always contain `"owner"`. Before this existed the three canonical roles were fixed in code; they are now only the default.                                                                                                                                                          |
| `capabilities`                            | string[]                    | absent                         | The consuming product's declared capability catalogue, mirrored here so `role_grants` can be validated against it. UOA's own names (`members.manage`, `teams.manage`, `organisation.manage`) are always valid on top of this list.                                                                                                                                    |
| `role_grants`                             | object                      | absent                         | `{ "org": { role: capability[] }, "team": { role: capability[] } }` — which roles hold which capabilities. Absent means the legacy default table (see below), which reproduces the pre-`role_grants` behaviour exactly.                                                                                                                        |
| `max_flags_per_app`                       | integer                     | `100`                          | Maximum feature flag definitions per App (max 500). Enforced at creation; existing flags unaffected if cap is lowered.                                                                                                                                                                                                                        |
| `scim_override_retention`                 | `"retain"` \| `"clear"`     | `"retain"`                     | Controls per-user flag override retention on SCIM hard-delete (`DELETE /scim/v2/Users/:id?hardDelete=true`). `"retain"` keeps overrides; `"clear"` deletes them. Soft-deprovision always retains overrides regardless of this setting.                                                                                                        |
| `global_missing_flag_default`             | `"enabled"` \| `"disabled"` | `"disabled"`                   | Default response when a flag key is queried but not defined in the App at all. Consuming apps always get a boolean — never an error.                                                                                                                                                                                                          |

- `enabled = false` (or omitted): all `/org/*` and `/internal/org/*` endpoints return `404`, access tokens omit `org` claims.
- `groups_enabled = false`: group read/write paths return `404`.
- `org_roles` and `team_roles` **must include `"owner"`** — Zod validation rejects configs without it.
- `max_*` values are enforced on write paths; invalid values reject the config.
- `role_grants` is validated at config load and fails loud: every role key must be in the matching
  vocabulary (`org_roles` / `team_roles`), every capability name must be in `capabilities` or in
  UOA's own catalogue, `"owner"` may not appear at all, and an unrecognised scope key is rejected.
  Nothing is partially applied — an invalid table rejects the whole config.

Follow the same Zod pattern as `2fa_enabled` and `user_scope` in `ClientConfigSchema` — an optional field with defaults:

```typescript
org_features: z.object({
  enabled: z.boolean().default(false),
  groups_enabled: z.boolean().default(false),
  user_needs_team: z.boolean().default(false),
  auto_create_personal_org_on_first_login: z.boolean().default(false),
  allow_user_create_org: z.boolean().default(false),
  backend_org_management: z.boolean().default(false),
  pending_invites_block_auto_create: z.boolean().default(true),
  max_teams_per_org: z.number().int().positive().max(1000).default(100),
  max_groups_per_org: z.number().int().positive().max(200).default(20),
  max_members_per_org: z.number().int().positive().max(10000).default(1000),
  max_members_per_team: z.number().int().positive().max(5000).default(200),
  max_members_per_group: z.number().int().positive().max(5000).default(500),
  max_team_memberships_per_user: z.number().int().positive().max(200).default(50),
  org_roles: z
    .array(z.string().min(1).max(50))
    .refine((roles) => roles.includes('owner'), { message: 'org_roles must include "owner"' })
    .default(['owner', 'admin', 'member']),
  team_roles: z
    .array(z.string().min(1).max(50))
    .refine((roles) => roles.includes('owner'), { message: 'team_roles must include "owner"' })
    .default(['owner', 'admin', 'member']),
  capabilities: z.array(z.string().trim().min(1).max(100)).optional(),
  role_grants: z
    .object({
      org: z.record(z.string().min(1).max(50), z.array(z.string().trim().min(1).max(100))).optional(),
      team: z.record(z.string().min(1).max(50), z.array(z.string().trim().min(1).max(100))).optional(),
    })
    .strict()
    .optional(),
  max_flags_per_app: z.number().int().positive().max(500).default(100),
  scim_override_retention: z.enum(['retain', 'clear']).default('retain'),
  global_missing_flag_default: z.enum(['enabled', 'disabled']).default('disabled'),
})
  .optional()
  .default({
    enabled: false,
    groups_enabled: false,
    user_needs_team: false,
    auto_create_personal_org_on_first_login: false,
    allow_user_create_org: false,
    backend_org_management: false,
    pending_invites_block_auto_create: true,
    max_teams_per_org: 100,
    max_groups_per_org: 20,
    max_members_per_org: 1000,
    max_members_per_team: 200,
    max_members_per_group: 500,
    max_team_memberships_per_user: 50,
    org_roles: ['owner', 'admin', 'member'],
    team_roles: ['owner', 'admin', 'member'],
    max_flags_per_app: 100,
    scim_override_retention: 'retain',
    global_missing_flag_default: 'disabled',
  });
```

#### Reserved Role: `"owner"`

The `"owner"` role has system-level semantics: only owners can delete organisations, transfer ownership, and change member roles. The `org_roles` array must always include `"owner"`.

`"owner"` and `"admin"` are the only system-interpreted roles for service-level permissions. All other role strings in `org_roles` are product-defined — stored and included in JWTs but carry no system-level permissions.

> **Superseded for UOA's own gates by `role_grants` (24.1a).** Since wave 1 of
> `Docs/plans/2026-08-16-configurable-roles-and-capabilities.md`, `"admin"` is not hard-coded
> anywhere in UOA's team/roster gates: it is simply the one non-owner role the *default* grant
> table happens to name. A domain that grants a custom role `members.manage` gives it real
> authority inside UOA; a domain that grants `"admin"` nothing takes it away. `"owner"` remains
> genuinely reserved — mandatory in both vocabularies, structurally holding every capability, and
> barred from the grant table so a config can never lock its own recovery role out.

#### 24.1a Capabilities and the grant table

UOA gates its own team surfaces on **capability names**, not role strings. Its catalogue is closed
and compiled in (`API/src/services/role-grants.ts`):

| Capability | Scope | What it gates |
| --- | --- | --- |
| `members.manage` | org + team | Roster mutation. **Org:** add a member, remove one, deactivate and reactivate a membership. **Team:** add/remove members, change a member's team role, create/revoke invitations and invite links, read the PII-bearing invited list. |
| `teams.manage` | org + team | The team object itself: create, rename, re-slug, change join policy or icon, upload/remove the team avatar, delete. |
| `organisation.manage` | **org only** | The organisation object itself: rename (and with it the slug), the member-invites policy, the workspace icon. The gates that check it never read a `TeamMember` row, because administering a team must not confer authority over the tenant containing it — a `role_grants.team` entry naming it is inert, never an escalation. |

**What is deliberately not a capability.** A short list stays structural, so no configured table can
reach it: deleting an organisation, transferring its ownership and changing an org member's role
require the acting user to **be** `Organisation.ownerId`; granting or removing the `"owner"` role
requires the actor to hold it (`owner` is the one fixed role); and billing management is an
*authority verdict* UOA computes from state only UOA holds — `BillingOrgResponsibility` and the
assignment scope — never a grant. See §4 of the plan document for the verdict/grant split.

Resolution, in full:

1. `"owner"` — org or team — holds every capability at the scope it stands in. Structural, not
   configured.
2. Any other role is looked up in `role_grants[scope]`. Missing role, missing table, unknown
   string: **the empty set**. There is no default role and no coercion to `member`.
3. A workspace answer is the **union** of the org-role grants and the team-role grants. An
   org-scope grant of a team-scope capability therefore reaches down into every team of the org.
4. An action with no team to stand in — creating one — can only be authorised by an org-scope
   grant.

**The legacy default table**, used whenever `role_grants` is absent (i.e. every domain that has
not opted in):

```json
{ "org": { "admin": ["members.manage", "teams.manage", "organisation.manage"] },
  "team": { "admin": ["members.manage", "teams.manage"] } }
```

The two scopes differ by one entry on purpose: `organisation.manage` is org-scope only, and a team
`admin` never had — and must not gain — authority to rename the organisation containing their team.

That reproduces the effective behaviour of the predicates it replaced. The one deliberate
difference is stated in 24.1b.

#### 24.1b Behaviour change: a team admin administers their own team

Before wave 1, the roster/team-mutation gate read the **org** membership and nothing else, so a
team `owner` or `admin` could not add, remove or re-role members of the very team they
administered, nor rename or delete it — only an org owner/admin could. That contradicted the
design intent that a team admin is self-sufficient for its own members, and it is now corrected:
these gates resolve the capability over the union of org- and team-scope standing.

For a domain with no `role_grants`, this is the **only** observable change. Everything else —
org owner/admin reach-down, plain members refused, backend mode (`X-UOA-Access-Token` omitted)
holding every capability — answers exactly as before. Team creation stays org-scoped, because
there is no team to stand in yet.

#### 24.1c The org-scope gates (follow-up, no behaviour change)

Wave 1 moved the **team** gates onto the table and left three org-scope services still comparing
`role === 'owner' || role === 'admin'`, because they did not receive the domain config at all. They
now resolve capabilities too: `members.manage` for the org roster
(`POST/DELETE /org/organisations/{orgId}/members/{userId}` and the `deactivate`/`reactivate`
lifecycle) and `organisation.manage` for `PUT /org/organisations/{orgId}`.

`config` is threaded from the routes into `removeOrganisationMember`,
`deactivateOrganisationMember` and `reactivateOrganisationMember`, which did not take it. Every one
of these gates reuses the ACTIVE membership row it had already loaded for its own reasons, so the
new resolution costs no extra query and cannot disagree with the row the service then acts on.

**Nothing observable changes for any domain**, with or without a `role_grants` table: the legacy
default gives org `admin` all three capabilities, and the owner-only invariants listed in 24.1a
(delete, ownership transfer, member-role change, granting/removing `owner`) never moved. Equivalence
is pinned exhaustively — every role × scope × capability in `API/tests/unit/role-grants.test.ts`, and
every role × gate in `API/tests/unit/organisation.service.capabilities.test.ts`.

---

### 24.2 Database Schema

> **Note:** The `Organisation.domain` field described below has been superseded. See `Docs/Research/api-changes-rebac.md §1` — the `domain` field is removed in the ReBAC model; orgs are no longer tied to a single client domain. Auto-enrolment is handled via `OrgEmailDomainRule` instead.

Add the following models to `API/prisma/schema.prisma`. Follow existing conventions: `cuid()` IDs, `snake_case` table/column mapping, `@@map()` on all models, `createdAt`/`updatedAt` timestamps.

#### Organisation

```prisma
model Organisation {
  id        String   @id @default(cuid())
  domain    String
  name      String   @db.VarChar(100)
  slug      String   @db.VarChar(120)
  ownerId   String   @map("owner_id")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  owner   User         @relation("OrgOwner", fields: [ownerId], references: [id], onDelete: Restrict)
  members OrgMember[]
  teams   Team[]
  groups  Group[]

  @@unique([domain, slug])
  @@index([domain])
  @@index([ownerId])
  @@map("organisations")
}
```

- `ownerId` is a direct reference to the owning user. `onDelete: Restrict` prevents deleting a user who owns an org — ownership must be transferred first.
- `slug` is URL-safe, unique per domain (see 24.4).

#### OrgMember

```prisma
model OrgMember {
  id        String   @id @default(cuid())
  orgId     String   @map("org_id")
  userId    String   @map("user_id")
  role      String   @default("member")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  org  Organisation @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([orgId, userId])
  @@index([userId])
  @@map("org_members")
}
```

- `role` is validated against `org_roles` config on write only. On read, return whatever is stored.
- `updatedAt` tracks role change timestamps.

#### Team

```prisma
model Team {
  id          String   @id @default(cuid())
  orgId       String   @map("org_id")
  groupId     String?  @map("group_id")
  name        String   @db.VarChar(100)
  description String?  @db.VarChar(500)
  isDefault   Boolean  @default(false) @map("is_default")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  org     Organisation @relation(fields: [orgId], references: [id], onDelete: Cascade)
  group   Group?       @relation(fields: [groupId], references: [id], onDelete: SetNull)
  members TeamMember[]

  @@unique([orgId, name])
  @@index([orgId])
  @@index([groupId])
  @@map("teams")
}
```

- If a group is deleted, its teams become ungrouped (`onDelete: SetNull`).
- `isDefault` marks the auto-created default team. One per org.

#### TeamMember

```prisma
model TeamMember {
  id        String   @id @default(cuid())
  teamId    String   @map("team_id")
  userId    String   @map("user_id")
  teamRole  String   @default("member") @map("team_role")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([teamId, userId])
  @@index([userId])
  @@map("team_members")
}
```

- `teamRole`: `lead` or `member`. Validated at application layer. **⚠ SUPERSEDED:** `api-changes-rebac.md §1` replaces this with `TeamRole` enum (`owner | admin | member`); `lead` is removed and migrated to `admin`.

#### Group

```prisma
model Group {
  id          String   @id @default(cuid())
  orgId       String   @map("org_id")
  name        String   @db.VarChar(100)
  description String?  @db.VarChar(500)
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  org     Organisation  @relation(fields: [orgId], references: [id], onDelete: Cascade)
  teams   Team[]
  members GroupMember[]

  @@unique([orgId, name])
  @@index([orgId])
  @@map("groups")
}
```

#### GroupMember

```prisma
model GroupMember {
  id        String   @id @default(cuid())
  groupId   String   @map("group_id")
  userId    String   @map("user_id")
  isAdmin   Boolean  @default(false) @map("is_admin")
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  group Group @relation(fields: [groupId], references: [id], onDelete: Cascade)
  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([groupId, userId])
  @@index([userId])
  @@map("group_members")
}
```

#### User Model Changes

Add relations to the existing `User` model:

```prisma
ownedOrgs     Organisation[] @relation("OrgOwner")
orgMembers    OrgMember[]
teamMembers   TeamMember[]
groupMembers  GroupMember[]
```

---

### 24.3 Organisation

> **Note:** The "one org per domain" constraint and domain-based org scoping below predates the ReBAC model. `api-changes-rebac.md §1` removes `Organisation.domain` — orgs are no longer tied to a single client domain. Auto-enrolment via `OrgEmailDomainRule` replaces domain-scoped org membership. Implementers should follow `api-changes-rebac.md §1–3` for the current model.

- An organisation belongs to a **domain** and is the top-level tenant concept.
- A domain can have **multiple organisations**.
- A user belongs to **exactly one organisation** per domain (with global `user_scope`, the same person could belong to different orgs on different domains).
- The user who creates an organisation becomes its **owner** (tracked via `ownerId`).
- Every organisation has a **default team** created automatically at org creation time (see 24.5).
- Creating an org: in one transaction, create the org, add the creator as owner (`OrgMember` with role `"owner"`), and create the default "General" team with `isDefault: true`.

#### Owner-Only Operations

- Delete the organisation
- Transfer ownership (`POST /org/organisations/:orgId/transfer-ownership`)
- Change a member's org role

#### Ownership Transfer

`POST /org/organisations/:orgId/transfer-ownership` accepts `{ newOwnerId: string }`. In a transaction:

1. Verify `newOwnerId` is an existing org member.
2. Set `Organisation.ownerId` to the new owner.
3. Set the new owner's `OrgMember.role` to `"owner"`.
4. Set the old owner's `OrgMember.role` to `"admin"`.

#### User Removal Lifecycle

When removing a user from an org (`DELETE /org/organisations/:orgId/members/:userId`), the service must within one fail-closed transaction:

1. Lock exact user-global, then `(userId, domain)`, then the organisation membership and all of that user's team memberships in the org.
2. Tombstone the `OrgMember` and `TeamMember` rows as `REMOVED`; delete the org's `GroupMember` rows, which have no lifecycle status.
3. Revoke every scoped refresh-token family for the exact `(userId, orgId)` across all issuing product domains.
4. Revoke same-domain refresh rows as compatibility for legacy sessions that carry no org/team scope.

Deactivation uses the same locks and atomic revocation while writing `DEACTIVATED`. Reactivation or re-add never restores a revoked refresh family; the user must sign in again.

#### Sole Owner Deletion

`Organisation.ownerId` has `onDelete: Restrict`. A user who is the sole owner of an org cannot be deleted — ownership must be transferred first.

#### One Org Per User Per Domain

The `@@unique([orgId, userId])` on `OrgMember` only prevents duplicate membership within one org. To enforce one-org-per-user-per-domain:

- The service must query "does this user already belong to any org on this domain?" before adding them.
- This check runs inside the transaction that creates the `OrgMember` record.
- With `user_scope: "per_domain"`, this is naturally enforced (user records are domain-scoped). With `user_scope: "global"`, the check must be explicit.

#### Member Addition: No Email-Based Lookup

To prevent email enumeration (consistent with Section 11), the member addition endpoint accepts a **userId**, not an email. The consuming product looks up user IDs through its own means (e.g., the existing `/domain/users` endpoint). If the userId does not exist or does not belong to the domain, the endpoint returns a generic error.

---

### 24.4 Slug Rules

Organisation slugs are derived from the `name` field:

- **Allowed characters:** lowercase alphanumeric and hyphens (`[a-z0-9-]`)
- **Pattern:** `/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/` (start and end with alphanumeric)
- **No consecutive hyphens**
- **Minimum length:** 2 characters
- **Maximum length:** 120 characters
- Unicode characters transliterated to ASCII before slugifying
- **Reserved slugs** that must be rejected: `admin`, `api`, `internal`, `me`, `system`, `settings`, `new`, `default`
- **Collision resolution:** append a random 4-character alphanumeric suffix (e.g., `my-org-a7f3`). Try up to 10 times, then fail. Do NOT use incrementing numeric suffixes (avoids leaking org count).
- Slugs are **regenerated** when the org name is updated via `PUT /org/organisations/:orgId`.

#### Tenant Subdomain Contract (2026-08)

The organisation slug is the canonical tenant subdomain label. It is unique per
client domain, so a product may route a selected tenant to
`<organisation.slug>.<its-tenant-base-domain>`. A team also has a slug for
workspace navigation, but it is only unique within its parent organisation and
must never be used as a DNS tenant key.

For a hosted SSO flow with `login_flow.workspace_selection: "auto"` and
`org_features.allow_user_create_org: true`, the workspace chooser may create
the user's first organisation directly. Creation includes the default team and
the selection/code continuation in one transaction. The scoped access token
then carries `active.tenantSlug`, sourced from the organisation slug; consumers
must tolerate its absence on a legacy token issued before this addition.

---

### 24.5 Team Semantics

- An org has many teams.
- Team constraints:
  - `name`: max 100 chars, unique within org
  - `description`: optional, max 500 chars
  - `isDefault`: boolean
- Team membership role is separate from org role:
  - Allowed values: `member` (default), `lead` **⚠ SUPERSEDED by `api-changes-rebac.md §1`** — canonical enum is `owner | admin | member`; `lead` is removed
  - `lead` is a display/routing designation — not an access control role (pre-ReBAC; now replaced by `admin`)
- Every org member must belong to at least one team.
  - On org membership add, user is auto-added to the default team.
- If `org_features.user_needs_team = true`, successful auth must self-heal users with no team membership:
  - If the user already belongs to an org on the domain but has zero teams, create a personal team named `"{user name}'s team"` and add them as `lead`. **⚠ SUPERSEDED:** `lead` is replaced by `admin` per `api-changes-rebac.md §1`.
  - If the user does not belong to any org on the domain, create a new personal org for them, create a default personal team named `"{user name}'s team"`, and place them there.
  - Resolve this during authorization-code exchange, before refresh-token creation. If placement
    creates a workspace, validate and persist its exact org/team IDs and emit them as `active`;
    never create or switch workspaces during ordinary refresh rotation. A recognized product reuses one
    exact eligible cross-product workspace and fails closed on an ambiguous set rather than
    creating a product-domain duplicate.

#### Default Team

- When an org is created, a team named "General" is auto-created with `isDefault: true`.
- When a user is added to an org, they are auto-added to the default team.
- The default team **cannot be deleted**.
- The default team can be renamed but `isDefault` cannot be changed.
- A user cannot be removed from their last team — remove them from the org instead.
- Removing a user from a non-final team tombstones that exact team membership and, in the same
  transaction, revokes every scoped refresh-token family for `(userId, teamId)` across all issuing
  product domains. Other-team sessions remain valid, and re-adding the membership does not restore
  revoked families.

#### Team Membership Constraints

- `max_members_per_team` from config
- `max_team_memberships_per_user` from config
- User cannot be removed from their final team membership
- Team CRUD restricted to owner/admin roles
- `PUT` on team **cannot change `isDefault` or `groupId`** — group assignment is internal-only

---

### 24.6 Group Semantics (Enterprise Option)

- Groups are optional — only active when `groups_enabled` is `true`.
- An org can have many groups; max is `max_groups_per_org`.
- A team belongs to **at most one group** (nullable — teams can be ungrouped).
- Group membership stores `is_admin` per user. This flag has no auth-level behaviour — it is persisted for consuming products.
- Group reads are available to any org member via the `/org/` API.
- **All group write operations are system-admin-only** — accessed through the Internal API (`/internal/org/`), not user-facing endpoints.

---

### 24.7 Access Token JWT Changes

> **⚠ SUPERSEDED by `Docs/Research/api-changes-rebac.md §5`.** The token shape defined below (flat `org` object, `teams: string[]`, `org_role`, `team_roles: {}`) is pre-ReBAC and no longer canonical. The canonical shape uses a nested `orgs[]` array with `uoaRole`, `customRole`, `uoaRoleInherited`, and `method` fields. When implementing, use `api-changes-rebac.md §5` as the authoritative source. The content below is preserved for historical context only.

When `org_features.enabled` is `true` and the user belongs to an org, the access token includes an `org` claim:

```json
{
  "sub": "user_abc",
  "email": "user@example.com",
  "domain": "app.example.com",
  "client_id": "hash_xyz",
  "role": "user",
  "org": {
    "org_id": "org_abc",
    "org_role": "admin",
    "teams": ["team_1", "team_2"],
    "team_roles": { "team_1": "lead", "team_2": "member" },
    "groups": ["group_a"],
    "group_admin": ["group_a"]
  },
  "iss": "unlike-other-authenticator",
  "iat": 1706742000,
  "exp": 1706745600
}
```

| Claim             | Type     | Description                                          |
| ----------------- | -------- | ---------------------------------------------------- |
| `org.org_id`      | string   | Organisation ID                                      |
| `org.org_role`    | string   | User's org role                                      |
| `org.teams`       | string[] | Team IDs (capped at `max_team_memberships_per_user`) |
| `org.team_roles`  | object   | Map of team_id to team role                          |
| `org.groups`      | string[] | Group IDs (only when `groups_enabled`)               |
| `org.group_admin` | string[] | Groups where user has `is_admin = true`              |

- If user has no org on this domain, the `org` claim is **omitted entirely** (not null, not empty — absent).
- JWT size grows linearly with memberships. `max_team_memberships_per_user` (default: 50) caps this. With 50 teams and 20 groups, expect ~4-5KB additional payload. Consuming products may need to increase reverse proxy header buffer sizes.
- JWT `org` claims are populated at issuance time, not updated mid-session. Changes require re-authentication (consistent with Section 22.10).
- Every refresh decision takes PostgreSQL transaction locks for exact user-global and then
  `(userId, domain)`, then re-reads the opaque-token row. Scoped rotation subsequently takes the canonical
  organisation-then-team membership locks before creating a replacement. Org lifecycle writers
  take the same session lock before membership locks, so legacy unscoped rotation is linearized as
  well: refresh-first leaves a replacement for the writer to revoke, while lifecycle-first is seen
  by the refresh re-read and creates none. Exact org/team revocation remains independent of the
  issuing product domain.
- Reuse of an already-rotated token revokes its whole family while holding that session lock. UOA
  commits the revocation before returning the normal opaque `INVALID_REFRESH_TOKEN` response, so
  the current replacement remains dead and concurrent rotation cannot escape.
- Family logout performs the same opaque lookup/lock/re-read and atomically commits its family
  revocation with the `tokenVersion` increment. Password reset, verify-email password binding, and
  every 2FA reset/disable path take user-global before credential mutation, then commit all-domain
  refresh revocation and `tokenVersion` in the same admin transaction. Either race order therefore
  leaves no replacement or newly valid access token after recovery completes.
- **Refresh token + org claims:** Refresh tokens may carry the exact optional `orgId` / `teamId`
  selected (or newly placed) for the session. Rotation preserves and revalidates that scope before
  signing the next `active` claim; it fails closed instead of silently dropping, switching, or
  creating a workspace. The wider display-only `org` claim is re-resolved from current database
  state on each issuance.

#### Implementation

- Modify `signAccessToken()` in `token.service.ts`: add optional `org` parameter to the existing flat params.
- Modify `AccessTokenClaimsSchema` in `access-token.service.ts`: add optional `org` Zod schema. Update `AccessTokenClaims` type and the hand-mapped return in `verifyAccessToken()`.
- Modify `exchangeAuthorizationCodeForAccessToken()`: query org context via `org-context.service.ts` when `org_features.enabled`.

---

### 24.8 Authentication & Middleware

The `/org/` endpoints use a **dual-auth pattern**: domain hash token for backend identity + user access token for user identity.

#### Required on All `/org/` Endpoints

1. `?domain=<domain>` query parameter (same pattern as `/domain/*`)
2. `?config_url=<config_url>` query parameter (config verified on every request)
3. Domain hash bearer token in `Authorization` header

#### User Identity

For endpoints needing user context, the access token goes in `X-UOA-Access-Token` header (already redacted in Fastify logger config). The `Authorization` header carries the domain hash token.

`X-UOA-Access-Token` carries exactly one token profile: the HS256 user access
token issued by the login flow. There is no second credential shape on `/org/*`.

#### Backend mode — no user token at all

The header is **optional**. When it is absent, the domain pairing above (items
1–3: `?domain=`, `?config_url=` with a verified signed config, and the
domain-hash bearer) is the authorisation on its own — it already proves "this is
the backend for domain X", and it is the only authentication `GET
/org/organisations`, the bulk branch of `POST .../teams/:teamId/invitations`, and
the access-request family have ever had.

`GET /org/organisations` is **backend-only**: it lists a whole domain, so there is
no acting user for it to scope to (`GET /org/me` is the user-scoped read). It
therefore REFUSES a present `X-UOA-Access-Token` with `401
ACCESS_TOKEN_NOT_ALLOWED` — valid, malformed or blank alike — rather than
ignoring one. Ignoring it is what previously let a partner BFF's blank forwarded
session token, i.e. an anonymous visitor, read the entire domain's organisation
list. Being backend-only, it also requires `backend_org_management` like every
other tokenless `/org/*` call.

Backend mode is **opt-in per domain** via `org_features.backend_org_management`
(default `false`). While the flag is `false`, a missing `X-UOA-Access-Token` is
`401 MISSING_ACCESS_TOKEN` exactly as before. The flag is not a new credential:
it is a second secret in the path, because the config JWT that carries it is
signed with the partner's own private key, which is distinct from the domain-hash
bearer.

`requireOrgRole` grants backend mode only when all three hold, each re-checked
inside the guard rather than inferred from the order of the preValidation array:

1. the domain-hash guard ran and passed (`request.domainAuthClientDomainId`);
2. a config JWT was verified, and its `domain` — never the raw `?domain=` — is
   what the call binds to (a differing `?domain=` is `400 DOMAIN_MISMATCH`);
3. that verified config sets `org_features.backend_org_management: true`.

The header is optional only in the sense that it may be **absent**. A header that
is _present but blank_ — `""`, spaces, a tab, a newline — is a malformed
credential, not an omitted one, and is `401 MISSING_ACCESS_TOKEN`. This matters
because the realistic integration is a product BFF that attaches the domain-hash
bearer server-side and forwards the end user's session token: for an anonymous
visitor that token is the empty string, and treating it as "omitted" would
promote an anonymous visitor to the tenant's backend. A repeated
`X-UOA-Access-Token` header is refused for the same reason. Only a genuinely
missing header selects backend mode. `POST .../teams/:teamId/invitations`, whose
dual-mode branch predates backend mode, follows the identical rule, as does
`DELETE .../teams/:teamId/invitations/:inviteId` (invitation revocation — user
mode allows an org/team owner/admin or the invite's original inviter; backend
mode requires the `backend_org_management` opt-in like every other tokenless
`/org/*` mutation).

**Team invitations have one live row per address, and never grant ownership.**
At most one *actionable* invitation — unaccepted, undeclined, unrevoked, and
approval not `DENIED` — exists per `(team, lower(email))`. That is a partial
unique index, not an application convention, so two concurrent invites to the
same address can no longer both land; inviting an address that already holds one
revokes the previous invitation as `REPLACED` and reports `resent_existing`.
Terminal invitations are untouched and accumulate as history.

An invitation may grant any role in the domain's `team_roles` vocabulary
**except `owner`**. Ownership of a team comes from direct membership management,
never from an emailed invitation: `owner` implicitly holds every capability at
its scope (see the capability table above), and an invitation would hand that to
whoever controls a mailbox. The rail names `owner` specifically rather than an
enumerated `member|admin` list, so a domain that defined its own roles invites
into them normally. The database enforces the `owner` half; the per-domain
vocabulary half is application-side, because the database cannot see a config.

Accepted, declined, and revoked are mutually exclusive terminal states,
acceptance pairs its timestamp with the accepting user, and an accepted
invitation is never still awaiting or refused approval. One pure module owns
these rules together with the derived `status`, so what a product reads and what
gates a transition are the same decision. Resending requires an actionable
invitation whose approval is settled — an expired one is resendable, since that
is how it gets a fresh token and window; a revoked or unapproved one is not.

**There is no acting user in backend mode.** Checks that are about the acting
user (org owner/admin, team manager, "must be an ACTIVE member") therefore do not
apply — the pairing already proves authority over the whole tenant, which
outranks any one member's role. Checks that are _not_ about the acting user are
unchanged and apply to both modes: org-belongs-to-domain, the last-owner guard,
membership and team caps, one-org-per-domain, and "cannot leave your last team".

##### Checks deliberately dropped in backend mode

"About the acting user" is easy to state and easy to under-read, so the specific
org-level checks that **do not run** in backend mode are listed here rather than
left to be discovered by reading the diff. Each is intentional under "the domain
backend is the tenant authority", and each is pinned by a test:

| Check (user mode)                                       | Backend mode | Why                                                                                                                           |
| ------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Only the **owner** may change a member's role           | not enforced | The rule protects members from each other. The backend is not a member.                                                       |
| Only the **owner** may delete the organisation          | not enforced | Same. The last-owner guard, which is not an actor check, still applies to member removal.                                     |
| `org_features.allow_user_create_org` gates org creation | not enforced | The flag governs whether **end users** may self-serve a workspace. It says nothing about the domain asking on its own behalf. |

Everything else in the "not about the acting user" list above genuinely does
apply to both modes.

Where a route needs to name a user it takes one explicitly — `owner_user_id` on
`POST /org/organisations`, `userId` on the member routes. Nothing is inferred.

A named user must belong to the calling domain, and **existence is not that
check**. `user_scope` defaults to `global`, so in a default deployment every
`users` row has `domain: null` and is visible on every domain — platform
superusers included. `owner_user_id` therefore requires the named user to hold a
`DomainRole` on the calling domain, which is the row login itself writes. On the
user path the owner _is_ the acting user, whose access token was already proven
to belong to this domain, so nothing extra is required there.
`GET /org/me` and `POST /org/organisations/:orgId/teams/:teamId/join` are _about_
the acting user, so they remain user-mode only and still return
`401 MISSING_ACCESS_TOKEN`.

Domain isolation is absolute in both modes: every handler resolves the
organisation as `(orgId, verified domain)` through `resolveOrganisationByDomain`,
so another domain's `:orgId` is a plain 404, and every transaction still sets the
RLS `app.domain` / `app.org_id` GUCs. `app.user_id` is simply empty in backend
mode, which only narrows the RLS predicates (it appears solely as an additive
owner-of / member-of branch on every `/org` table).

The access-request admin routes are part of "every handler". They were the one
family that resolved its target from `access_requests.target_org_id` /
`target_team_id` in the caller's **own signed config** and never re-resolved it
against the calling domain — which is not a tenant boundary, because the caller
authors that config. They now resolve org by `(id, domain)` and team by
`(id, orgId)` like everything else, and the `access_requests` RLS policies
require the row's organisation to sit on `app.domain` so the two layers are
independent.

Backend mode sets a fourth RLS GUC, `app.domain_backend`, derived **only** from
the guard's own acceptance decision. Two policy branches are gated on it —
"the domain's backend may see its own domain's organisations" (which is what
makes `GET /org/organisations` return rows at all) and the equivalent for
`org_members` (which is what lets the one-org-per-domain probes see a sibling
org). A signed-in user never sets it, so user-mode visibility is unchanged.

The one-org-per-user-per-domain invariant itself is additionally enforced in the
database, so it holds on every write path rather than only where a service probe
can see far enough. It is a **partial unique index**,
`org_members_one_active_org_per_domain` on `(user_id, domain) WHERE status =
'ACTIVE'`, over a `org_members.domain` column that database triggers keep derived
from `organisations.domain` — application code never writes it. It was briefly a
`BEFORE ROW` trigger that queried for a conflict; that is check-then-write, which
at `READ COMMITTED` two concurrent transactions defeat (proven), so it was
replaced with something the storage engine enforces.

Because a backend-initiated mutation has no user to attribute, it is recorded in
`OrgAuditLog` with `actorUserId: null` plus the reserved `uoa_actor` metadata key
`{ "via": "domain_backend", "source_domain": "…" }`. Rows without that key were
made by a user directly. `actorUserId` and `uoa_actor` are mutually exclusive: a
row claiming both a user and the backend performed one mutation is rejected
before it can be written.

Every backend-reachable mutation writes such a row — organisation
create/update/delete, ownership transfer, team create/update/delete,
access-request approve/reject, and the membership and invite actions that already
did. On the access-request routes, `reviewedByUserId` is a caller-supplied label
and never becomes `actorUserId`. An audit write that fails after its mutation has
committed does not fail the request (the mutation really happened), but it is
logged as a distinct `org_audit_log_write_failed` event rather than swallowed.

> **`uoa_actor` shape change — for operators and log consumers.** Rows written by
> the removed confidential-provisioning path carried a wider object including
> `product` and `chain`. The current shape is exactly
> `{ "via": "domain_backend", "source_domain": "…" }`. Historical rows keep the
> old shape and are not backfilled, so anything reading `uoa_actor` must tolerate
> extra keys on rows predating this change and must not require `product`/`chain`
> to be present.

#### Middleware Chain

```
Request
  → config-verifier.ts       (fetch & verify config, attach to request)
  → requireDomainHashAuthForDomainQuery  (verify Authorization bearer)
  → org-features.ts          (check config.org_features.enabled → 404 if disabled)
  → org-role-guard.ts        (extract X-UOA-Access-Token, verify, check org role)
  → Route handler
```

For org creation: `org-role-guard.ts` must not require an org role (user has no org yet). It only verifies the access token is valid and the domain matches.

#### Cross-Domain Validation (IDOR Prevention)

- `org-role-guard.ts` must verify the `domain` claim in the user's access token matches `?domain=`.
- Service layer must verify that any org in the URL path belongs to the `?domain=` domain.
- Every operation must verify the full ownership chain: domain → org → team/group → member.

#### Error Pattern

All errors use `AppError` from `utils/errors.ts`. The global error handler returns only `{ error: "Request failed" }`. No status-specific messages that leak information.

---

### 24.9 API Endpoints (User-Facing)

#### Organisation Management

| Method | Endpoint                                       | Description                            | Who can call                                                              |
| ------ | ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| POST   | `/org/organisations`                           | Create org (auto-creates default team) | Any authenticated user (must not already belong to an org on this domain) |
| GET    | `/org/organisations/:orgId`                    | Get org details                        | Any org member                                                            |
| PUT    | `/org/organisations/:orgId`                    | Update org name/slug                   | Owner, Admin                                                              |
| DELETE | `/org/organisations/:orgId`                    | Delete org and all nested data         | Owner only                                                                |
| GET    | `/org/organisations/:orgId/members`            | List org members (paginated)           | Any org member                                                            |
| POST   | `/org/organisations/:orgId/members`            | Add user to org (by userId)            | Owner, Admin                                                              |
| PUT    | `/org/organisations/:orgId/members/:userId`    | Change member's org role               | Owner only                                                                |
| DELETE | `/org/organisations/:orgId/members/:userId`    | Remove member (cascades team/group)    | Owner, Admin (cannot remove last owner)                                   |
| POST   | `/org/organisations/:orgId/transfer-ownership` | Transfer ownership                     | Owner only                                                                |

#### Team Management

| Method | Endpoint                                                  | Description                      | Who can call   |
| ------ | --------------------------------------------------------- | -------------------------------- | -------------- |
| GET    | `/org/organisations/:orgId/teams`                         | List teams (paginated)           | Any org member |
| POST   | `/org/organisations/:orgId/teams`                         | Create team                      | Owner, Admin   |
| GET    | `/org/organisations/:orgId/teams/:teamId`                 | Get team details + members       | Any org member |
| PUT    | `/org/organisations/:orgId/teams/:teamId`                 | Update name/description          | Owner, Admin   |
| DELETE | `/org/organisations/:orgId/teams/:teamId`                 | Delete team (not default)        | Owner, Admin   |
| POST   | `/org/organisations/:orgId/teams/:teamId/members`         | Add user to team                 | Owner, Admin   |
| PUT    | `/org/organisations/:orgId/teams/:teamId/members/:userId` | Change team role                 | Owner, Admin   |
| DELETE | `/org/organisations/:orgId/teams/:teamId/members/:userId` | Remove from team (not last team) | Owner, Admin   |

#### Group Management (Read-Only)

Returns `404` if `groups_enabled` is `false`.

| Method | Endpoint                                    | Description                         | Who can call   |
| ------ | ------------------------------------------- | ----------------------------------- | -------------- |
| GET    | `/org/organisations/:orgId/groups`          | List groups (paginated)             | Any org member |
| GET    | `/org/organisations/:orgId/groups/:groupId` | Get group details + teams + members | Any org member |

#### Domain Admin

| Method | Endpoint             | Description                         | Who can call          |
| ------ | -------------------- | ----------------------------------- | --------------------- |
| GET    | `/org/organisations` | List all orgs on domain (paginated) | Domain hash auth only |

#### User Context

| Method | Endpoint  | Description                                        | Who can call           |
| ------ | --------- | -------------------------------------------------- | ---------------------- |
| GET    | `/org/me` | Current user's org context and workspace directory | Any authenticated user |

The additive `org.workspaces[]` directory follows the same server-owned product workspace policy as
the hosted chooser. It is domain-scoped by default. A verified product mapped to
`all_active_memberships` receives every ACTIVE workspace the caller may enter, so a product sidebar
never silently shows a smaller switcher than UOA's chooser. Cross-product entries expose no other
product's login-recency data (`lastLoginAt` remains `null`). Every entry carries the owning
`orgId`/`orgName` for organisation grouping and a non-null public `avatarImageUrl` resolving the
team's uploaded image, proxied `iconUrl`, or generated fallback without client credentials. If the
caller has no same-domain organisation, a recognized product's exact workspace-scoped access token
anchors the complete legacy `org_id`/role/team block to its selected `active.orgId` after a live
policy and membership recheck; `workspaces[]` still contains every authorized membership and each
row's own `orgId`/`orgName` is authoritative for grouping. An unscoped token never selects an
arbitrary cross-domain organisation.

The legacy fields return the same structure as the JWT `org` claim but always reflect current
database state.

#### Seamless Workspace Switching (2026-08)

A product backend switches an existing renewable session only through
`POST /auth/token` with the exact custom grant
`urn:unlikeotherai:params:oauth:grant-type:workspace-switch` and body
`{ refresh_token, organization_id, team_id }`; `operation_id` is not accepted.
The target must be an exact ACTIVE org/team pair from the same server-owned
workspace policy used by the directory. UOA holds the product-policy and refresh
session locks, validates source then target memberships, resolves target 2FA and
signature policy, and writes one deterministic target-scoped successor. The
refresh family carries the original authorization code's completed-TOTP proof
unchanged; legacy families default to no proof. Ordinary refresh always preserves
scope and same-scope switch is a non-consuming no-op conflict.

For 120 seconds an exact retry may recover only a successor chain that retains
the requested target. Any competing grant/target or later scope change returns
non-consuming/non-revoking `409 WORKSPACE_SWITCH_CONFLICT`; post-grace predecessor
use always takes the existing theft-revocation path. Production also exposes
non-oracular `403 WORKSPACE_NOT_AVAILABLE` and `403 INTERACTION_REQUIRED` so the
product can refresh its directory or restart interactive authorization without
learning which membership/policy check failed. After domain-client authentication succeeds,
invalid sources return the stable `401 INVALID_REFRESH_TOKEN` code without distinguishing the
underlying reason; client-authentication failures remain generic 401 responses.
Those 403 outcomes apply before a switch edge commits. If an exact response-loss retry proves the
edge already committed but its target membership, 2FA, or signature policy no longer passes, UOA
retires only that family and returns authenticated `401 INVALID_REFRESH_TOKEN`; it returns no target
access token, does not revoke sibling families, and does not increment the global user epoch.

---

### 24.10 Internal API

Group management and team-to-group assignment are system-admin-only. System admins are backend services, not human users.

#### Authentication

1. `?domain=<domain>` query parameter
2. Domain hash bearer token in `Authorization` header
3. `?config_url=<config_url>` query parameter
4. **No user access token** — machine-to-machine calls

The domain hash token represents full system trust. Any backend possessing the shared secret is implicitly a system admin.

#### Middleware Chain

```
Request
  → config-verifier.ts                     (fetch & verify config)
  → requireDomainHashAuthForDomainQuery    (verify domain hash)
  → org-features.ts                        (check enabled)
  → groups-enabled.ts                      (check groups_enabled → 404 if disabled)
  → Route handler
```

No `org-role-guard.ts` — no user in the request.

#### Endpoints

| Method | Endpoint                                                             | Description                           |
| ------ | -------------------------------------------------------------------- | ------------------------------------- |
| POST   | `/internal/org/organisations/:orgId/groups`                          | Create group                          |
| PUT    | `/internal/org/organisations/:orgId/groups/:groupId`                 | Update group                          |
| DELETE | `/internal/org/organisations/:orgId/groups/:groupId`                 | Delete group (teams become ungrouped) |
| POST   | `/internal/org/organisations/:orgId/groups/:groupId/members`         | Add group member                      |
| PUT    | `/internal/org/organisations/:orgId/groups/:groupId/members/:userId` | Toggle is_admin                       |
| DELETE | `/internal/org/organisations/:orgId/groups/:groupId/members/:userId` | Remove group member                   |
| PUT    | `/internal/org/organisations/:orgId/teams/:teamId/group`             | Assign/unassign team to group         |

#### Team-Group Assignment

`PUT /internal/org/organisations/:orgId/teams/:teamId/group` accepts `{ groupId: string | null }`. `null` ungroups the team. Must verify:

1. Team belongs to the org.
2. Group (if provided) belongs to the same org.
3. `groups_enabled` is `true`.

#### Security Note

The internal API must never be exposed to end users. In production, these endpoints should be network-restricted (VPC, API gateway). The authenticator does not enforce network-level restrictions.

---

### 24.11 Pagination & Rate Limiting

#### Pagination

All list endpoints support cursor-based pagination:

- Query parameters: `?limit=50&cursor=<last_id>`
- Response: `{ data: [...], next_cursor: "..." | null }`
- Default limit: 50, maximum: 200

#### Rate Limiting

Extend `rate-limiter.ts` for `/org/` routes:

- Org creation: 5 per user per domain per hour
- Member addition: 100 per org per hour
- Team creation: 50 per org per hour
- Read endpoints: standard API rate limits

---

### 24.12 Operational Lifecycle

#### Enabling on an Existing Domain

When `org_features` is enabled on a domain with existing users, none belong to an org. The authenticator does not migrate. The consuming product must:

1. Prompt users to create or join organisations.
2. Handle missing `org` JWT claim gracefully.
3. Optionally use the Internal API to pre-create orgs.

#### Disabling After Orgs Exist

Setting `enabled: false` hides all org endpoints (`404`) and omits `org` JWT claims. **Existing data is NOT deleted.** Re-enabling restores access. For permanent removal, delete orgs via API before disabling.

#### `org_roles` Config Changes

If `org_roles` changes and existing members have roles no longer in the list, those members retain their stored role. The consuming product must bulk-update roles if needed. Validation is write-only — the JWT contains whatever role is stored.

---

### 24.13 Constraints

1. **Completely generic.** No product-specific concepts.
2. **Backwards compatible.** Existing flows unchanged when `org_features` is absent.
3. **No admin dashboard.** The hosted SSO may create a user's first workspace when explicitly enabled; it is not an admin dashboard.
4. **Refresh tokens are backend-only.** Never expose them to browser JavaScript or local storage.
5. **Existing security rules apply.** Generic errors, no enumeration, no leakage.
6. **File size limit: 500 lines.**
7. **Follow existing code patterns.** See `token.service.ts`, `domain-role.service.ts`, `domain-hash-auth.ts`.
8. **Prisma only.** No raw SQL. Use transactions for multi-step mutations.
9. **Slug rules.** Random suffixes, not incrementing (see 24.4).
10. **Deletion cascades.** Org deletion cascades teams, groups, memberships. Team deletion cascades memberships (cannot delete default). Group deletion sets `groupId = null` on teams.
11. **`org_roles` must include `"owner"`.** Validated on write, not read.
12. **One org per user per domain.** Enforced at application layer.
13. **Every user in at least one team.** Auto-added to default team on join.
14. **Group writes are internal-only.** Via `/internal/org/`.
15. **Member addition by userId, not email.** No enumeration.
16. **IDOR prevention.** Verify full ownership chain: domain → org → team/group → member.

---

### 24.14 First-Login Behaviour & Capabilities

On successful **first** verified login — email-password registration after verifying, or first-time social login — the authenticator always creates the `User` record. It **never** auto-creates an organisation or team unless the config explicitly opts in. The consuming product drives onboarding UX using capabilities echoed in the auth response.

"First login" is defined as the authentication that transitions the user from nonexistent to created. It runs exactly once per user and MUST NOT re-run on subsequent logins.

#### Precedence (highest → lowest)

Apply exactly one branch on first verified login:

1. **Matching pending invite.** If an invite for this email exists → surface in `firstLogin.pending_invites`. Do not auto-place, do not auto-create. The client UI presents the invite choice.
2. **Matching `registration_domain_mapping`.** If the email domain matches a configured mapping rule → add as `member` to the mapped org + team (and default team if no team specified).
3. **`auto_create_personal_org_on_first_login: true`.** Create a personal org with the user as `owner` (default team created alongside per 24.3). Skipped if branch 1 matched and `pending_invites_block_auto_create: true`.
4. **None of the above.** User record exists; no org, no team, no memberships. Client renders onboarding based on `firstLogin.capabilities`.

`user_needs_team` (24.1) is **orthogonal**: it runs on every successful interactive authorization
as a self-heal, not just first login. First-login behaviour runs once; `user_needs_team` remains
applicable to later interactive logins, but never runs during refresh rotation.

#### Design notes

- There is no `auto_create_default_team_on_first_login` flag. Teams only exist under orgs, and every org gets a default team at creation (24.3). A standalone flag is meaningless.
- There is no separate `allow_user_create_team` flag. Team-create permission derives from org role (`owner` / `admin`); a user with no org has no team to create.
- `auto_create_personal_org_on_first_login` creates the org inside the same transaction as the `User` row where possible, matching the ownership-atomicity requirement in 24.3.

#### Auth Response Addition: `firstLogin`

The authorization-code exchange response (`POST /auth/token`) gains an optional `firstLogin` block. **One-shot**: present only on the access token response immediately following first-login user creation. Subsequent refresh-token exchanges and re-logins MUST omit it.

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "firstLogin": {
    "memberships": {
      "orgs": [{ "orgId": "...", "role": "member" }],
      "teams": [{ "teamId": "...", "orgId": "...", "role": "member" }]
    },
    "pending_invites": [
      { "inviteId": "...", "type": "team", "targetId": "...", "targetName": "..." }
    ],
    "capabilities": {
      "can_create_org": false,
      "can_accept_invite": true
    }
  }
}
```

- `memberships` reflects state **after** precedence rules ran (mapping placements and auto-create included).
- `capabilities.can_create_org` echoes `org_features.allow_user_create_org` for the caller's domain. The client MUST treat this as authoritative and NOT re-derive from config — the server stays in control.
- `capabilities.can_accept_invite` is `true` iff `pending_invites` is non-empty.
- Empty `memberships` + empty `pending_invites` + `can_create_org: true` is the "create your own workspace" entrypoint — client renders org-creation flow.
- If `org_features.enabled: false`, `firstLogin` is omitted entirely (no memberships, no capabilities concept).

#### Write-Path Gate

`POST /org/organisations` enforces `allow_user_create_org`:

- Caller is system-admin (Internal API or domain-hash auth) → allowed unconditionally.
- Caller is an end-user (bearer access token) → allowed iff `org_features.allow_user_create_org: true` for the caller's domain config. Otherwise returns the standard generic error.

This lets pre-provisioned B2B tenants disable self-service org creation while still allowing admin-driven onboarding via `/internal/org/`.

Hosted SSO uses the same gate through `POST /auth/create-workspace`, but only
after a verified login bridge and only with `login_flow.workspace_selection:
"auto"`. It creates and selects the user's first workspace atomically, rather
than issuing an unscoped code for a client-side creation flow.

##### Creating a further workspace inside an existing organisation

An organisation is the level above a workspace, and adding a workspace to an org
you already run is a different action from creating your first org. It has its
own gate, `org_features.allow_user_create_team` (default `false`), and its own
hosted-SSO route, `POST /auth/create-team` — the sibling of
`/auth/create-workspace`, with the same verified-bridge and
`workspace_selection: "auto"` preconditions.

- The chooser payload carries `creatable_orgs: [{ orgId, orgName }]` — the
  organisations the caller may add a workspace to. As with `can_create_org`, the
  client MUST treat this as authoritative and not re-derive it.
- An org appears there iff the domain set `allow_user_create_team` **and** the
  caller is an ACTIVE `owner`/`admin` of it — the same standing
  `POST /org/organisations/:orgId/teams` requires. `/auth/create-team` re-checks
  both, plus `max_teams_per_org`, so the list only decides what to offer.
- The creator is added to the new workspace as team `admin`; the workspace is
  then selected and the login finalized in the same transaction that claims the
  bridge token.
- The hosted chooser uses one card-corner creation control and a popup rather
  than an inline form on a workspace row. When more than one server-authorized
  destination is available, it presents the exact `creatable_orgs` values in an
  organisation selector. It may offer the separate “new organisation” target
  only for the existing `can_create_org` first-workspace capability; the client
  must never invent an org id.
- Both hosted chooser creation routes may receive optional `join_policy` of
  `HIDDEN`, `INVITE_ONLY` (the default), or `OPEN_TO_ORG`. `HIDDEN` is the
  private choice: it is not discoverable and only invitees can find it. The
  other policies retain their ordinary team-policy behaviour. These are a
  deliberately limited hosted-chooser subset; other policies remain managed by
  the organisation API.
- Unlike the first-workspace entrypoint, this is **not** limited to users with no
  memberships: a user who already belongs to workspaces is exactly who needs it.
  It is still bounded by the chooser being shown at all — a user with exactly one
  ACTIVE team and no pending invites auto-skips the chooser (§11.2) and creates
  workspaces through the product instead.

#### Examples

- **Restaurant SaaS (self-service).** `auto_create_personal_org_on_first_login: true`, `allow_user_create_org: true`. New user signs up → immediately owns an org → can invite staff. No client-side "create org" screen needed.
- **Enterprise product (admin-provisioned).** `registration_domain_mapping` covers `@acme.com` → Acme org; `allow_user_create_org: false`; `auto_create_personal_org_on_first_login: false`. Employees auto-land in Acme; cannot fork side-orgs.
- **Marketplace (invite-first).** All auto-create flags `false`, `allow_user_create_org: true`, `pending_invites_block_auto_create: true`. Default users land empty. Invitees see the invite; uninvited users see "Create your workspace" and call `POST /org/organisations` explicitly.

---

## 25. Task Breakdown by Phase

Each task references the line number(s) where the relevant specification lives in this document.

---

### Phase 1: Project Foundation & Core Server

| #   | Task                                                                  | Ref (line) |
| --- | --------------------------------------------------------------------- | ---------- |
| 1.1 | Initialize project repository, package manager, and base dependencies | L5–16      |
| 1.2 | Set up server framework (API-first, stateless)                        | L16, L29   |
| 1.3 | Set up environment variable loading for shared secret                 | L70–77     |
| 1.4 | Create base project folder structure                                  | L35–58     |
| 1.5 | Set up database connection and migration system                       | L301–312   |
| 1.6 | Add health check endpoint                                             | L16        |

---

### Phase 2: Config & Client Trust

| #   | Task                                                                                                              | Ref (line) |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------- |
| 2.1 | Implement client ID generation: hash(domain + shared secret)                                                      | L66–67     |
| 2.2 | Build config URL fetcher — auth entrypoint fetches JWT from client-provided URL                                   | L405–410   |
| 2.3 | Implement JWT config signature verification using shared secret                                                   | L85–100    |
| 2.4 | Validate required config fields: `domain`, `redirect_urls`, `enabled_auth_methods`, `ui_theme`, `language_config` | L106–112   |
| 2.5 | Parse optional config fields: `2fa_enabled`, `debug_enabled`, `user_scope`                                        | L114–119   |
| 2.6 | Config JWT `aud` is not required; validate signature and domain instead                                           | L414–420   |
| 2.7 | Reject unsigned or tampered config JWTs                                                                           | L98–100    |
| 2.8 | Validate `domain` claim matches the origin of the request                                                         | L434–440   |

---

### Phase 3: User Model & Database

| #   | Task                                                                                                                                                | Ref (line)              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 3.1 | Create users table: `id`, `email`, `password_hash`, `name`, `pronouns_preset`, `pronouns_custom`, `role`, `2fa_enabled`, `2fa_secret`, `created_at` | L303–321                |
| 3.2 | Add `avatar_url` column (external URL only, no local storage)                                                                                       | L314–318                |
| 3.3 | Implement global user scope (default): one email = one user across all domains                                                                      | L516–520                |
| 3.4 | Implement per-domain user scope: users isolated per domain, same email = separate records                                                           | L521–525                |
| 3.5 | Create domain-roles table for per-domain role assignment (superuser / user)                                                                         | L309, L519              |
| 3.6 | Implement superuser assignment: first successfully created user row per domain wins                                                                 | L68, L356–363, L444–449 |
| 3.7 | Ensure superuser race condition resolved at DB constraint level                                                                                     | L446–447                |

---

### Phase 4: Email & Password Authentication

| #   | Task                                                                                                                                          | Ref (line)         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 4.1 | Implement password validation rules: min 8 chars; length-first; special char NOT required (see Password Rules decision 2026-06-18 / HUGO-147) | L202–210           |
| 4.2 | Implement secure password hashing (bcrypt/argon2)                                                                                             | L212–215           |
| 4.3 | Build registration endpoint with enumeration protection — always respond "We sent instructions to your email"                                 | L219–237           |
| 4.4 | Implement email-determines-next-step logic: existing user gets login link, new user gets verification + set password                          | L234–237           |
| 4.5 | Build login endpoint (email + password) with generic error responses                                                                          | L195–215, L498–508 |
| 4.6 | Ensure API never reveals whether an email exists                                                                                              | L221–226           |

---

### Phase 5: Email Verification & Password Reset

| #   | Task                                                                    | Ref (line) |
| --- | ----------------------------------------------------------------------- | ---------- |
| 5.1 | Generate one-time, time-limited tokens for email verification           | L243–247   |
| 5.2 | Store tokens hashed (never plaintext)                                   | L247       |
| 5.3 | Build email verification flow: token sent, user clicks, email confirmed | L251       |
| 5.4 | Build password reset flow: token sent, user clicks, sets new password   | L252       |
| 5.5 | Implement secure token validation (one-time use, expiry check)          | L253       |

---

### Phase 6: OAuth Authorization Code Flow

| #   | Task                                                                                         | Ref (line) |
| --- | -------------------------------------------------------------------------------------------- | ---------- |
| 6.1 | Build OAuth entrypoint: accept config URL, fetch and verify config, render auth UI           | L405–410   |
| 6.2 | Implement authorization code generation after successful authentication                      | L529–536   |
| 6.3 | Build token exchange endpoint: client backend sends code, receives access token JWT          | L532–533   |
| 6.4 | Generate access token JWT containing: user ID, email, domain/client ID, role, expiry, claims | L285–292   |
| 6.5 | Enforce short-lived access token TTL (configurable, e.g. 15–60 min)                          | L488–494   |
| 6.6 | Validate `redirect_urls` from config before redirecting                                      | L109       |
| 6.7 | Ensure token is never returned directly to frontend — code exchange only                     | L535       |
| 6.8 | Implement rotating refresh tokens and server-side silent reauth for client backends          | L491–494   |

---

### Phase 7: Social Authentication Providers

| #   | Task                                                                               | Ref (line)         |
| --- | ---------------------------------------------------------------------------------- | ------------------ |
| 7.1 | Implement Google OAuth login                                                       | L176               |
| 7.2 | Implement Apple OAuth login                                                        | L177               |
| 7.3 | Implement Facebook OAuth login                                                     | L178               |
| 7.4 | Implement GitHub OAuth login                                                       | L179               |
| 7.5 | Implement LinkedIn OAuth login                                                     | L180               |
| 7.6 | Enforce provider-verified email only — reject unverified emails                    | L453–457           |
| 7.7 | Implement account unification: same email = same user, auto-merge across providers | L187–191           |
| 7.8 | Enable/disable providers per-client based on config `enabled_auth_methods`         | L118, L182–185     |
| 7.9 | Overwrite avatar URL on every social login                                         | L317–318, L461–466 |

---

### Phase 8: Two-Factor Authentication

| #   | Task                                                                 | Ref (line)     |
| --- | -------------------------------------------------------------------- | -------------- |
| 8.1 | Generate user-specific TOTP secret                                   | L270           |
| 8.2 | Generate `otpauth://` URI from secret                                | L271           |
| 8.3 | Render QR code for authenticator app scanning                        | L272           |
| 8.4 | Verify initial TOTP code during setup                                | L274           |
| 8.5 | Mark 2FA as enabled on user record, store encrypted secret           | L275, L310–311 |
| 8.6 | Enforce 2FA verification during login when enabled                   | L257–262       |
| 8.7 | 2FA enablement controlled per-client via config `2fa_enabled`        | L116, L259–262 |
| 8.8 | Implement email-based 2FA reset (no backup codes, no admin override) | L479–484       |

---

### Phase 9: UI & Theming

| #    | Task                                                                                                       | Ref (line)     |
| ---- | ---------------------------------------------------------------------------------------------------------- | -------------- |
| 9.1  | Set up server-side rendering for auth UI                                                                   | L127           |
| 9.2  | Integrate Tailwind CSS (only CSS framework allowed)                                                        | L128, L31      |
| 9.3  | Build theme engine: apply colors, radii, button styles, card styles, typography, logo, density from config | L130–138       |
| 9.4  | Ensure all UI properties come only from config — no hardcoded client styles                                | L140–143       |
| 9.5  | Build login form template                                                                                  | L127           |
| 9.6  | Build registration form template                                                                           | L228–237       |
| 9.7  | Build password reset form template                                                                         | L252           |
| 9.8  | Build 2FA setup screen (QR code display + code input)                                                      | L268–275       |
| 9.9  | Build 2FA verification screen (code input during login)                                                    | L257–262       |
| 9.10 | Build OAuth popup container and redirect handling                                                          | L391, L529–536 |

---

### Phase 10: Language & i18n

| #    | Task                                                                                  | Ref (line) |
| ---- | ------------------------------------------------------------------------------------- | ---------- |
| 10.1 | Build translation file structure (key-value per language)                             | L147–159   |
| 10.2 | Implement single-language mode (no selector shown)                                    | L153       |
| 10.3 | Implement multi-language mode with dropdown selector                                  | L154, L159 |
| 10.4 | Default to language selected on client website                                        | L158       |
| 10.5 | Build AI translation fallback: detect missing translation, send to AI, receive result | L161–167   |
| 10.6 | Cache AI-generated translations permanently                                           | L166       |
| 10.7 | Serve cached translations for all future requests                                     | L167       |

---

### Phase 11: Email Service

| #    | Task                                                                          | Ref (line)         |
| ---- | ----------------------------------------------------------------------------- | ------------------ |
| 11.1 | Set up email sending infrastructure (provider abstraction)                    | L50–54             |
| 11.2 | Build email verification email template                                       | L52                |
| 11.3 | Build password reset email template                                           | L53                |
| 11.4 | Build login link email template (for existing users during registration flow) | L54, L236          |
| 11.5 | Build 2FA reset email template                                                | L479–484           |
| 11.6 | Ensure all emails use generic language — no information leakage               | L221–226, L498–508 |

---

### Phase 12: Domain-Scoped APIs & Logging

| #    | Task                                                                                    | Ref (line)     |
| ---- | --------------------------------------------------------------------------------------- | -------------- |
| 12.1 | Implement login logging: user ID, email, domain, timestamp, auth method, IP, user agent | L324–332       |
| 12.2 | Build login logs API endpoint (requires domain hash token)                              | L334–337       |
| 12.3 | Build list-users-for-domain API endpoint                                                | L345           |
| 12.4 | Build debug endpoints (superuser only)                                                  | L347, L359–362 |
| 12.5 | Implement domain hash token authorization: token = hash(domain + secret)                | L349–352       |
| 12.6 | Enforce finite log retention (configurable, e.g. 90 days default)                       | L470–475       |

---

### Phase 13: Security Hardening & Final Validation

| #     | Task                                                                                                                            | Ref (line)               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 13.1  | Audit all endpoints for email enumeration vectors — ensure none leak                                                            | L24, L221–226            |
| 13.2  | Audit all error responses — ensure all are generic to user                                                                      | L498–508                 |
| 13.3  | Verify shared secret is never exposed in responses, logs, or client-side code                                                   | L25, L369                |
| 13.4  | Verify all config JWTs are rejected if unsigned or tampered                                                                     | L370, L385               |
| 13.5  | Verify domain verification runs on every auth initiation                                                                        | L434–440                 |
| 13.6  | Verify social login only accepts provider-verified emails                                                                       | L453–457                 |
| 13.7  | Verify access tokens are stateless and short-lived                                                                              | L294–297, L488–494       |
| 13.8  | Verify refresh tokens are hashed, rotated, and never exposed to browser clients; backup codes and admin overrides remain absent | L379–385, L491, L480–482 |
| 13.9  | Verify avatar URL overwrite behavior (no history, no local storage)                                                             | L461–466                 |
| 13.10 | End-to-end test: full OAuth flow from config URL fetch through token exchange                                                   | L405–410, L529–536       |

---

## 2026-04 Super-users and Per-Domain Email

The Admin panel includes a **Super-users** page for operators who already hold `SUPERUSER` on `ADMIN_AUTH_DOMAIN`. Super-user access is represented by a `domain_roles` row where `domain = ADMIN_AUTH_DOMAIN` and `role = SUPERUSER`; this is distinct from per-domain bootstrap superusers (the first login on each customer domain).

A user granted `SUPERUSER` on `ADMIN_AUTH_DOMAIN` (a **platform superuser**) is reflected as `role: "superuser"` in the `access_token` `claims.role` for tokens issued on **any** domain — not just the admin panel. This is what makes the admin **Super-users** grant visible to client websites. The per-domain bootstrap superuser still resolves to `superuser` on its own domain on top of this; `claims.role` is `superuser` when either holds.

Registered domains can opt into UOA-managed transactional email. Admin operators configure the mailing domain, from address, optional from name, and optional default reply-to on the domain detail page. SES registration returns DNS TXT and DKIM CNAME records for the operator to publish. Sending is enabled only after both SES verification and DKIM report `Success`.

Customer backends send through `POST /email/send` with `X-UOA-Config-JWT: <signed config JWT>`. UOA verifies the config JWT from the request header, checks the domain's stored email config is enabled and verified, then sends the raw subject/text/html payload through the configured email provider. The public response remains generic for missing, invalid, disabled, unverified, or failed sends.

## 2026-06 Admin Bans (deny list)

The Admin panel's ban capability is backed by a real `bans` table rather than the
earlier non-functional stub. A ban is a superuser-managed **deny** rule that always
overrides any allow-list.

**Scope (per-tenant).** A ban is scoped to a client domain by default, or to a specific
organisation (`org_id`) or team (`team_id`) within that domain. The org/team must belong
to the named domain — cross-tenant bans are rejected.

**Types.** `email` (exact, case-insensitive), `pattern` (shell-style glob over the email,
e.g. `*@evil.com` — never a raw regex, to avoid ReDoS), `ip` (exact or IPv4 CIDR against
the request IP), and `user` (UOA userId).

**Enforcement.** Bans are checked at the single login chokepoint
(`finalizeAuthenticatedUser`, after the allow-list, across the user's domain/org/team
scopes) and in the registration and social-login paths (domain scope, before any user row
is created). A SUPERUSER on the login domain bypasses bans, matching the allow-list
semantics. A matched ban produces the generic auth error to the user (no enumeration):
login fails closed with `ACCESS_DENIED`, registration returns the standard
timing-equalised silent response.

**Admin API.** `GET/POST /internal/admin/bans` and `DELETE /internal/admin/bans/:id`
(superuser only). The settings read returns the live ban list grouped by type. Reads and
writes run on the BYPASS-RLS admin role (login enforcement runs before any tenant context
is set), and the `bans` table denies the runtime app role, mirroring `client_domains`.

There are no ban expiries or hit counters; a ban persists until an operator removes it.

## 2026-07 Optional Domain Agreement Signature Module

The optional agreement signature service is **disabled by default** and enabled per
registered client domain. When enabled, it can require authenticated users to sign the
domain's current PDF agreement versions after authentication and required 2FA, but before
authorization-code or refreshed-access-token issuance.

The complete product scope, evidence model, auth-flow integration, security requirements,
non-goals, delivery phases, and unresolved decisions are defined in
[Optional Domain Agreement Signature Module — Product Brief](./Requirements/domain-signatures.md).
That document is incorporated into this build brief by reference and is authoritative for
the signature module.

Signing evidence uses a durable claimed-intent handoff: exact inputs are reserved under the
continuation/domain-policy locks, all object reads/writes, PDF generation, and cryptographic
signing occur only after that transaction commits, and a final locked revalidation appends
the signature and audit atomically. Deterministic receipt bytes and immutable intent states
make concurrent duplicates, crash recovery, and lost-response retries converge without
holding database locks across external work.

## 2026-07 Billing Tariff Control Plane

Tariffs and all commercial billing for UOA-backed products live in UOA. Ledger
owns only immutable raw usage, provider cost, and attribution facts, while
products consume a signed effective-tariff snapshot and display-ready billing
statement; neither Ledger nor an end product maintains independent tariff or
commercial-rating logic. Resolution precedence is team override, organisation
override, then service default. Raw token and other usage quantities remain
immutable. UOA may derive separately labelled customer billable units as
`raw_metered_units × usage_price_multiplier_bps / 10000`; token-metered AI,
SERP, and DeepWater label those as token-, search-, and research-equivalent
units respectively. A commercial unit never replaces, relabels, or masquerades
as provider output.

Every application connection uses its own revocable, product-bound,
purpose-bound app API key plus a short-lived RS256 actor assertion carrying the
exact UOA user, organisation, and team. Entitlement-read and customer-lifecycle
keys are separate endpoint classes; lifecycle keys require exact HTTPS return
origins, while entitlement keys cannot carry them. Shared cross-product or
cross-purpose API keys are forbidden.

Every valid customer billing mutation writes an append-only UOA action intent
at its first real effect; invalid, already-satisfied, processing, and completed
requests do not accumulate permanent intent rows. Its database trigger locks
the exact lifecycle app key, service, user, organisation, requested team, and
both membership rows and rechecks the current scope-appropriate billing-manager
role, the app key's wall-clock expiry, the actor expiry, and the actor's stored
credential epoch against the locked user's current `token_version`. A
concurrent key revocation, credential revocation, membership removal, or role
downgrade therefore serializes before or after one durable authorization point,
never in the gap before a Stripe or local monetary effect. Cancellation claims
and automatic-top-up update/disable transitions insert that evidence inside
their locked effect transaction. Logical transport retries reuse the product-
signed actor `jti` and exact request digest. Existing Checkout, cancellation, credit/add-on, and
invoice rows remain the durable effect state machines and supply stable
idempotency identities; products still perform no billing calculation.

Payment collection is independent from pricing and usage rating. Every
immutable tariff version declares `collection_mode = stripe | manual | none`.
`none` preserves non-free cost visibility and billable-unit calculation while
collecting no payment; specifically, `at_cost` + `none` + a zero monthly amount
represents 100% provider-cost visibility with no charge. Free tariffs require
`none`, zero markup, and zero monthly amount.

The optional Stripe collection foundation is fail-closed behind an explicit
process gate. It maps exact immutable tariff versions to calendar-month
subscriptions, accepts Checkout initiation only from the product's own app key
plus an owner/admin actor assertion, and verifies Stripe webhooks with a
separate signing secret. UOA reads immutable Ledger monthly snapshots using
UOA's own dedicated Ledger app key plus a short-lived service assertion; it
exports customer-rated money as idempotent delta meter events, never raw tokens,
searches, research units, or another application's credential. The deployed
scheduler polls current full UTC month periods and installs an additional
pre-boundary safety timer; it deliberately treats Checkout's
no-proration alignment stub as free and fails visibly on other non-calendar
periods. A verified draft subscription-cycle `invoice.created` event performs
the authoritative just-ended-month export before webhook commit, preserving
retry/finalization-grace semantics and capturing usage after the safety pass.
Finalization failures are recorded and logged. The machinery remains inert
while the Stripe gate is false.
Production database startup preserves the RLS boundary before that gate can be
enabled. The Prisma migration subprocess uses the separately configured
`uoa_admin` connection through a command-scoped environment override; the API
process keeps `DATABASE_URL` bound to non-`BYPASSRLS` `uoa_app`. Production
startup fails if the admin connection is absent, neither DSN is logged, and
only explicit development/test databases may deliberately use one connection for
both migration and runtime.
All Stripe projections and idempotency identities are scoped to the exact Stripe
account and test/live mode. A subscription remains pinned to its Checkout's
immutable tariff version, precedence source, assignment, and organisation/team
billing scope until terminal; conflicting tariff mutations fail closed rather
than silently repricing. Organisation subscriptions exclude team subscriptions
for that product and organisation, while independent team subscriptions may
coexist. Webhooks reconcile current Stripe state and exact undiscounted item
cardinality, so reordered notifications cannot resurrect canceled state.
Product backends can read a Stripe-ID-free subscription summary, create an
allowlisted customer-portal session, and schedule period-end cancellation; the
last unambiguous projection remains readable with an explicit disabled flag
when collection is off. Platform superusers operate services, immutable
tariffs, assignments, purpose-bound keys, and subscription state through the
Admin `/billing` screen.

The canonical model, modes, precedence, API and JWT contract, superuser
administration, presentation rules, and Stripe collection boundaries are defined
in [Billing Tariffs and Product Entitlements](./Requirements/billing-tariffs.md).
That document is incorporated into this build brief by reference and is
authoritative for the billing tariff control plane.

Organisation contract invoicing is the manual-collection extension of that
control plane. A contract pins one organisation-wide usage markup, currency,
payment terms, service set, and monthly service prices in immutable effective
versions. Closed-month calculation consumes organisation-scoped Ledger facts
through UOA's shared rating core, while every customer invoice DTO and PDF shows
only the gross final calculated price per service and separately labelled
credit/payment/write-off settlement totals—never provider cost, token/API units,
calls, markup, or private Ledger evidence. Future versions cannot project their
tariff assignments before their effective UTC month; calculated drafts freeze
their header, lines, and evidence at commit, and recalculation creates the next
revision. Issuance uses monotonic numbering and deterministic wrapping-safe
Unicode PDFs in private immutable storage; voids and corrections preserve the
audit chain. The complete model and operational rules are defined in
[Organisation Contract Invoicing](./Requirements/contract-invoicing.md), which
is incorporated into this brief by reference.

### 2026-07-20 canonical customer statement clarification

UOA is the sole commercial billing engine and customer-facing system of record.
Ledger supplies only immutable raw metering facts—tokens, API/SERP/research
usage, provider estimated/actual cost, exact aggregate selected cost, and exact
user/team/product attribution—through its
versioned `metering-usage-v1` contract. Ledger does not supply tariff,
subscription, markup, billable-unit, customer-charge, credit, add-on, payment,
or cancellation fields.

Product backends obtain the display-ready, product-agnostic
`BillingStatementV1` from `POST /billing/v1/customer-statement` and render its
labels, exact money, totals, service access, per-user usage, capabilities, and
action descriptors without re-rating or inventing copy. The statement pins the
two immutable Ledger service/user snapshots and the exact UOA tariff version.
Each request requires that product deployment's own `customer_lifecycle` app
key and a fresh subject-bound actor JWT; neither credential enters browser
code.

The canonical TypeScript source is the MIT-licensed, publishable
`packages/billing-statement-protocol` workspace. UOA imports it directly; the
package has no private API imports, credentials, or tenant data. Its generated
JSON Schema, synthetic fixture, and OpenAPI 3.1 consumer component are also
served publicly at `/schemas/billing-statement-v1.json`,
`/schemas/billing-statement-v1.example.json`, and
`/schemas/billing-statement-v1.openapi.json`. Package build/tests reject
artifact drift, and consumers may pack or vendor the package until registry
publication is approved.

The package also owns the complete product-facing billing action contract:
normalized hosted redirect, cancellation selection, preview (including the
fixed confirm method/path), confirmation request/response, and minimal error
envelope. Exact schemas reject unknown properties and are served with synthetic
fixtures and OpenAPI components at
`/schemas/billing-consumer-actions-v1.json`,
`/schemas/billing-consumer-actions-v1.example.json`, and
`/schemas/billing-consumer-actions-v1.openapi.json`.

Billing action capabilities remain separate from runtime product feature
entitlements. A capability such as `can_be_private` is resolved through UOA's
per-App, per-user/team feature-flag API using that product's backend credential;
missing or unavailable flags fail closed. Products do not infer runtime
features from tariff mode/key or retain a local subscription flag as authority.

Direct product access is UOA-owned evidence confirmed by the authenticated
product app key. Every product backend confirms it immediately after its own
successful UOA SSO exchange through
`POST /billing/v1/service-access/confirm`; proxy or agent use must not confirm
another product. Ledger-only caller/origin use remains indirect and cannot
create a direct entitlement. Cancellation is preview then confirm: UOA returns
the complete dialog model, offers a related-direct-products choice only when
the team actually has another same-account direct subscription, excludes
indirect-only services from that choice, and confirms with an opaque,
short-lived, single-use, idempotent token under database lock and state
revalidation. A related subscription is eligible only when at least one current
member of the exact organisation/team has active, non-revoked direct-access
evidence for its exact service and it shares the current Stripe account.
Missing, revoked, inactive-membership, other-team, or other-account evidence
never creates a choice; with no eligible related product, only
`current_service` is the default. The old one-step cancellation route is
superseded.

Superusers manage exact organisation/team add-ons and credits alongside
tariffs in UOA Admin. Stripe remains a payment processor: UOA rates Ledger raw
provider cost under the pinned tariff before exporting exact cumulative money
deltas. This clarification supersedes earlier text that described Ledger as
rating customer charges or product UIs reading commercial usage from Ledger.

### 2026-07-20 connected-service portfolio clarification

`BillingStatementV1` remains frozen and available. New product consumers use
`BillingStatementV2` from `POST /billing/v2/customer-statement`. V2 retains the
complete UOA-owned commercial statement and adds
`connected_service_usage`: display-ready team totals for every metered billing
product in the requested UTC month, with explicit origin-product and per-user
shares. UOA alone aggregates, labels, and formats this view model.

UOA obtains one immutable user-grouped `metering-portfolio-v1` snapshot from
Ledger for the exact organisation/team/month. It derives the commercial rating
and every service, origin, and per-user total from that same pinned fact set.
The statement product in UOA's signed assertion is a perspective, not a Ledger
filter. UOA rates only that product's rows; all other products are explanatory
and cannot become charges on the current statement. Stripe usage export remains
the narrower product-scoped `metering-usage-v1` flow. Null legacy origin
attribution is displayed as `Unattributed origin` and never becomes a service,
direct-access record, or cancellation choice.

Products implement only the public protocol interface: render UOA's labels,
values, shares, and actions; proxy whitelisted upgrade, portal, cancellation
preview, and cancellation confirmation requests; and never calculate billing
or subscription state. Origin attribution explains delegated use—for example,
Nessie-originated DeepWater work—without creating direct DeepWater access.
Only UOA's current exact-team direct-session evidence can make another
same-account subscription eligible for a cancel-one-versus-cancel-related
choice.

### 2026-07-21 shared credits, add-ons, and contract invoices

UOA owns one exact-team credit balance shared across every connected product in
the same Stripe account/mode. The fixed customer conversion is 1,000 credits =
US$1.00 and the required product heading is `Remaining credits`. Customer credit
quantities are always whole integers: UOA floors each cumulative service/user
rated amount to complete credits and carries the sub-credit remainder internally
until it crosses the next credit boundary. Individual
products may advertise different fixed top-up offers, but every successful
payment funds the shared account. Manual and bounded automatic top-up are
available to all services only through UOA-authored frozen actions; products
never calculate credits, choose a payment amount, or rebuild an action body.

UOA stores immutable auto-top-up consent revisions, payment proof, monthly caps,
attempt outcomes, refunds, and disputes. Every customer-initiated funding,
consent, or add-on mutation requires the appropriate active billing manager at
the database boundary; automatic attempts, Stripe corrections, settlements,
and superuser adjustments use their separate immutable proof paths. Manager
credit views may contain per-user and payment-method display detail;
ordinary members receive only their own usage, categorical other-team and
unattributed aggregates, payment-method status, and no enabled money actions.
The Stripe-gated billing scheduler identifies only active exact-team accounts
below their UOA consent threshold, rechecks current policy/offer/catalog and the
UTC monthly cap under a database lock, and commits one attributed attempt before
any off-session payment. A second per-account PostgreSQL lock serializes Stripe
dispatch across replicas. Lost responses reuse that attempt's deterministic
Stripe idempotency key; only signed webhooks terminalize it or add credits.

Recurring add-ons are UOA subscriptions scoped to an organisation, team, or
subscribing user. DeepWater privacy is a versioned US$50/month offer.
Organisation-scoped purchase or cancellation requires an organisation
owner/admin; team managers cannot escalate their authority through the actor's
requested-team context. Team and subscribing-user scopes may use the exact-team
owner/admin policy. Opaque cancellation intents expire terminally and preserve
the exact subject and Stripe subscription evidence.
UOA provisions or validates the immutable Stripe Product/monthly Price from its
offer catalog, creates one licensed monthly item with server-derived customer,
return URLs, and idempotency, and activates entitlement only after verifying the
exact undiscounted paid initial invoice. Checkout completion alone never grants
the add-on. Cancellation preview and confirmation recheck the exact actor/scope,
use a five-minute opaque capability and stable Stripe idempotency key, and replay
the stored confirmation without issuing a second cancellation.

For negotiated organisation contracts, the UOA Admin billing area owns the
versioned organisation margin and invoice calculator. Customer invoices show
only calculated gross customer price per service, a separate canonical
funded-credit settlement, ordinary fixed subscriptions, adjustments, taxes,
payments, and totals. Paid recurring add-ons are labelled as collected
separately and excluded from the manual amount due. They never expose
raw token/API/SERP/research quantities, provider cost, cost-token equivalents,
markup, or margin calculations. Connected products consume a display-ready UOA
invoice view model and contain no local invoice-rating logic.
Invoice issue, void, and manual settlement effects lock the exact admin user and
domain-role rows and reject when the presented access token's credential epoch
no longer matches the locked user's current `token_version`.

The Admin `/billing` page separates **Product billing** from **Contracts &
invoices**. In the contract view, platform superusers can create organisation
contracts and versions, activate exact monthly prices per selected service,
manage explicit issuer and buyer profiles, calculate and list invoice
revisions, issue/download/void invoices, and append manual payment, refund, or
write-off events. The browser only submits those operator choices and renders
UOA's customer-safe calculated values; UOA remains the commercial source of
truth and Ledger remains the raw-usage source.

The UOA runtime serves the public `BillingCreditsV1`/recurring-add-on protocol
artifacts, product-authenticated reads, and the protocol's frozen add-on
Checkout/cancellation actions. A credit read pins one exact
team-wide Ledger cursor and settles every service atomically against the shared
balance; it is concurrency-safe and cursor-idempotent, releases corrections
before allocating new usage, stops ordinary usage at zero, and retains the full
unfunded liability. Only verified reversals may create debt. When parallel
Ledger fetches arrive out of capture order, the newest committed capture stays
authoritative; an equal-or-older unseen cursor is a successful superseded no-op
and cannot roll the team projection backwards. The database independently
rejects stale snapshot writes as defense in depth. The display model then
enforces manager/member visibility, while every add-on read or mutation
applies the same exact subject boundary. Read/schema availability alone does not
enable a money action: each Checkout/top-up/auto-top-up/add-on action requires
its dedicated verified Stripe runtime and UOA policy/catalog evidence.

Credit funding mutations are UOA-owned at
`/billing/v1/credits/top-up-checkout` and
`/billing/v1/credits/auto-top-up/{setup,update,disable,recover}`. Each accepts
only the frozen subject plus a UOA offer/option ID, rechecks the exact product
key, fresh actor, and active exact-team billing manager, and derives every
amount, Stripe Price/customer, consent term, metadata value, and allowlisted
return URL from UOA state. UOA persists the immutable local intent before
calling Stripe, uses account/mode-scoped idempotency, recovers the same open
Checkout across a fresh exact-scope actor, and applies webhooks only after
current Stripe metadata matches the stored customer/catalog/intent binding.
Missing policy, catalog, payment, consent, or Stripe evidence fails closed and
keeps the corresponding projected action disabled.

The initial commercial catalog is installed through a typed operator command,
not a migration or startup side effect. It requires an explicit Stripe account
and test/live mode, defaults to read-only `--dry-run`, and requires an
account-and-mode-bound confirmation for `--apply`. Before any database write it
retrieves and validates the existing immutable Stripe Products and Prices for
the four shared-credit offers and DeepWater privacy add-on. Apply then creates
or binds, in one serializable transaction, the credit policy, offers, default
automatic-top-up option for `nessie`, `deepwater`, `deepsignal`, `deeptest`, and `docgen`,
plus DeepWater's team feature policy and recurring add-on catalog. Stripe
metadata contains stable public contract identifiers only, never UOA database
IDs. Any local or remote drift aborts instead of mutating or replacing an
existing Stripe object or local binding.

## 2026-07-25 User Avatars: uploads, provider proxy, and generated fallbacks

This addendum supersedes the "no avatars stored locally" principle (§2), the §15
"Avatar — No avatar storage" rules, and the §20 non-goal "No local avatar storage",
and qualifies §22.7. The complete specification is
[User Avatars](./Auth/avatars.md), incorporated into this brief by reference and
authoritative for the avatar system.

Summary of what changes and what does not:

- Users may now have an **uploaded avatar** stored in UOA (Postgres `user_avatars`
  table, raster-only PNG/JPEG/WebP, magic-byte validated, 1 MiB cap). It is set
  through the API: by the user via the dual-auth `/avatar/me` endpoints, or by the
  product backend via `/domain/users/:userId/avatar` (domain hash auth).
- **Avatar resolution precedence is: uploaded → provider URL → generated.** An
  avatar set in UOA always wins over the social-provider image; the generated
  image is the universal fallback so avatar GET endpoints always return an image.
- Four deterministic, non-AI **generated SVG styles** exist: `tiles`, `waves`,
  `rings`, `mono`. The optional signed-config claim `avatars.default_style`
  selects a domain's default generated style; absent, a stable per-user
  pseudo-random style is used.
- §22.7 remains true **for the provider URL column only**: `User.avatarUrl` is
  still overwritten on every social login, no history, no caching of provider
  bytes. Uploaded avatars live in a separate table precisely so that overwrite
  cannot destroy them.
- Provider images are **proxied server-side** (HTTPS-only, SSRF-guarded,
  size/time-capped) so callers always receive image bytes; any proxy failure
  falls back to the generated image.
- The Admin panel displays user avatars through
  `GET /internal/admin/users/:userId/avatar` regardless of source.
- **Teams (companies) now have avatars too**, on the same terms: an uploaded image in the
  Postgres `team_avatars` table wins, otherwise the team's existing `iconUrl` is proxied
  server-side under the same SSRF/size/time rules, otherwise the deterministic generated
  SVG seeded from the team id. Managed through `GET`/`PUT`/`DELETE
/domain/teams/:teamId/avatar` — domain hash bearer only, the machine-to-machine path a
  product backend uses, since products retain the bound refresh credential rather than a
  spendable end-user access token; per §24.10 that token is full system trust for the domain,
  so the backend applies its own owner/admin gating before relaying. The dual-auth
  `PUT`/`DELETE /org/organisations/:orgId/teams/:teamId/avatar` (organisation owner/admin
  only, the same authorization as updating the team) and the audited
  `/internal/admin/teams/:teamId/avatar` routes remain available for callers that do hold a
  user token, and for operators. Team records now also carry an `avatarImageUrl`.
  `Team.iconUrl` keeps its current meaning and is never written by the avatar endpoints,
  exactly as `User.avatarUrl` is not.

## 2026-08-16 Organisation billing responsibility (one bill for the whole organisation)

Design: [`Docs/plans/2026-08-15-org-billing-override.md`](./plans/2026-08-15-org-billing-override.md).

An organisation may take billing over from all of its teams, across **every**
service — one place to see and manage spend, credits, payment method and
invoices for the whole organisation. Products implement none of it: this is one
UOA capability plus one additive protocol field they already know how to render.

- **`BillingOrgResponsibility`** is the authority record — one row per
  organisation, `active` with `assumedAt`/`assumedByUserId` and, once released,
  `releasedAt`/`releasedByUserId`. Deliberately org-wide rather than
  per-service: the ask is one bill for the whole organisation, and the existing
  `(scope, scope_key)` convention leaves room to add a service dimension later
  without a breaking change. Absent or inactive is today's behaviour exactly.
- **`BillingCreditAccount` gained the scope pair its neighbours already carry.**
  `team_id` is nullable, `scope`/`scope_key` are not (`org_id` for
  `ORGANISATION`, `org_id || ':' || team_id` for `TEAM`), and its unique key
  moved from `(account_id, team_id, currency)` to
  `(account_id, scope_key, currency)` — Postgres treats NULLs as distinct, so
  the old index would have admitted duplicate organisation accounts.
  `resolveCreditAccount` returns the organisation account while the override is
  active and today's team account otherwise. Every debit already crossed that
  one resolver, so nothing in Ledger, the worker, or any product changed.
- **Rating, attribution and evidence stay per team.** A team's Ledger portfolio
  is rated exactly as before and its snapshot keeps the team it came from; only
  the account the credits are drawn from changes.
- **The statement answers at the paying scope.**
  `POST /billing/v2/customer-statement` still takes organisation + team and UOA
  decides. Override off is unchanged. Override on adds `controlled_by`; an
  organisation billing manager additionally receives `organisation_scope` —
  every team, each from its own pinned `metering-portfolio-v1` snapshot, with
  organisation totals produced by the existing commercial-line summation. It
  sits **beside** the requested team's own fields, never in place of them, so a
  product that predates the field cannot read organisation totals as if they
  were the team's.
- **Old-client safety is part of the contract.** A caller who is not an
  organisation billing manager gets an empty action list and no funding
  controls at all, so a product still vendoring protocol 1.2.0 renders a
  read-only surface rather than buttons that would 403.
- **Enabling is a stated migration, not a silent switch**
  (`POST /billing/v1/organisation-billing/assume`, organisation billing manager
  only, same app key + fresh 45-second actor assertion + `tv` epoch discipline
  as every other billing action). It is refused whole while any team funding
  action is in flight (`FUNDING_ACTION_IN_FLIGHT`, listing the exact rows) or
  while a live team-scoped Stripe subscription exists
  (`TEAM_SUBSCRIPTIONS_ACTIVE`, listing them — auto-migrating one would re-bill
  a customer without a decision). Team credit balances are never swept, and
  each team's stored automatic top-up consent is deactivated, never deleted,
  with an audit row; releasing leaves them inactive until a customer consents
  again. Releasing reverses credit resolution only — no ledger row, invoice or
  statement is ever re-scoped.
- **Protocol 1.3.0** publishes `controlled_by`, `organisation_scope`, and the
  checkout-session/portal-session envelopes whose absence had products
  hand-writing their own validators. Every addition is optional, so a 1.2.0
  consumer and every existing fixture stay valid.
