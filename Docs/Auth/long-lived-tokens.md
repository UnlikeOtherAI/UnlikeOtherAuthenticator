# Long-Lived Tokens

> **Status:** Implemented
> **Purpose:** Define the refresh-token contract and the separate short-lived confidential resource-token grant used by client backends.

---

## Current Behavior

The Authenticator now issues a **token pair** from `POST /auth/token`:

- `access_token` — short-lived JWT for API calls
- `refresh_token` — opaque bearer token for server-side renewal only
- `token_type`
- `expires_in`
- `refresh_token_expires_in`

`POST /auth/token` supports three grants:

1. Authorization-code exchange
2. Refresh-token exchange with `grant_type=refresh_token`
3. Confidential JWT assertion exchange with
   `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`

`POST /auth/revoke` revokes the refresh-token family used by the caller during logout.

---

## Token Model

| Token | Format | Lifetime | Client Storage | Server Storage |
|-------|--------|----------|----------------|----------------|
| Access token | HS256 JWT | 15-60 minutes | Memory / short-lived session | Stateless |
| Refresh token | Opaque random base64url string | 1-90 days, default 30 | Backend-only, never browser JS | SHA-256 hash in `refresh_tokens` |
| Confidential resource token | RS256 JWT | 5 minutes | Calling backend only | Stateless |

### Important Constraints

- Refresh tokens are returned to the **client backend**, not directly to browser JavaScript.
- Consumer products must store refresh tokens in a **server-only** location such as an `HttpOnly` cookie or backend session store.
- Access tokens stay short-lived even when refresh tokens are enabled.

---

## Persistence Model

Refresh tokens are stored in the `refresh_tokens` table with:

- `token_hash`
- `family_id`
- `parent_token_id`
- `replaced_by_token_id`
- `user_id`
- `domain`
- `client_id`
- `config_url`
- `org_id` (nullable exact workspace scope)
- `team_id` (nullable exact workspace scope)
- `expires_at`
- `revoked_at`
- `last_used_at`
- `created_at`

Only the hash is persisted. Raw refresh tokens are never stored.

---

## Rotation and Reuse Detection

Every successful refresh-token exchange:

1. Derives a deterministic successor and creates its hash in the same family
2. Marks the previous token as revoked
3. Links the old token to the replacement with `replaced_by_token_id`

UOA allows one narrowly bounded recovery case for a successful response that
was lost in transit. For 120 seconds after rotation, the same predecessor may
be submitted with the same authenticated application credential and exact
`domain`/`client_id`/`config_url` context. UOA validates every stored
parent/successor hash and scope link, re-runs current policy, and returns the
one current live descendant without creating another row. The response reports
that descendant's actual remaining lifetime. This also makes concurrent
submissions converge on one successor across UOA replicas.

The 120-second window is an explicit availability/security tradeoff: a stolen
predecessor plus the product's application credential can recover the current
successor during that window. Raw tokens remain backend-only and responses are
`Cache-Control: no-store` / `Pragma: no-cache`.

If an already-rotated refresh token is presented outside that window, or its
stored successor chain is corrupt:

1. The entire token family is revoked
2. The user's global access-token version is incremented
3. Both revocations commit in the same transaction
4. Only after commit, the request fails with the same generic unauthorized response used for every invalid refresh
5. Subsequent refresh attempts and access tokens from the prior version fail

This is the theft-detection path for replayed refresh tokens. Every production refresh decision
takes PostgreSQL transaction advisory locks in the canonical order: exact user-global, then exact
`(user_id, domain)`. Because the raw token is needed to discover that identity, UOA performs an
opaque lookup, takes both locks, and then re-reads the row before deciding reuse, rejection, or
rotation. Reuse and a current-token rotation therefore cannot cross: whichever commits first
determines the state observed by the waiter, and no new live replacement can escape revocation.

## Workspace Lifecycle Revocation

Workspace-scoped refresh families are terminated when their membership stops being ACTIVE:

- Organisation deactivation or removal revokes every live row for the exact
  `(user_id, org_id)` across all issuing product domains. The lifecycle transaction also preserves
  the legacy same-domain revocation contract so older unscoped sessions cannot survive.
- Team removal revokes every live row for the exact `(user_id, team_id)` across all issuing product
  domains. Sessions for the user's other teams remain valid.
- Reactivating or re-adding a membership never clears `revoked_at`; the user must complete a new
  interactive authorization flow.

The status tombstone and refresh-row updates run in one fail-closed `uoa_admin` transaction. Org
lifecycle takes user-global, user+domain, then canonical organisation/team membership locks. Team
lifecycle takes user-global before its membership locks. Refresh follows the same hierarchy before
creating a replacement. This also serializes legacy unscoped rows, which have no org/team IDs
available to lock. Refresh-first is followed and revoked by the lifecycle writer; lifecycle-first
is observed by refresh's post-lock re-read and creates no replacement. Lifecycle revocation does
not bump the global token version: already-issued access tokens expire normally, and unrelated
workspace/product sessions are not globally invalidated.

## Logout and Global Credential Revocation

`POST /auth/revoke` first performs an opaque, context-bound lookup. Only after a valid subject is
known does it take user-global then user+domain locks and re-read the row. Family revocation and the
`User.tokenVersion` increment commit in the same transaction. Missing, mismatched, or concurrently
deleted tokens retain the same successful no-oracle response.

Password reset, password binding during verify-email, email 2FA reset, authenticated 2FA disable,
and admin 2FA reset use `uoa_admin`. Each takes the user-global lock before changing credentials,
then atomically revokes every live refresh row and increments `tokenVersion` in that transaction.
If refresh commits first, the reset revokes its replacement and invalidates its access token. If
reset commits first, refresh's post-lock re-read sees revocation and cannot mint either token.

The shipped revocation caller audit is:

| Caller | Database boundary | Ordered locks | Atomic effects |
| --- | --- | --- | --- |
| Refresh rotation/reuse | `uoa_admin` | product policy → user-global → user/domain → org/team → signature | rotate, or durable family theft revocation |
| `POST /auth/revoke` | tenant domain transaction | user-global → user/domain | family revoke + `tokenVersion` |
| Org deactivate/remove | `uoa_admin` | user-global → user/domain → org/team | status + exact-org + legacy-domain revoke |
| Team-member remove | `uoa_admin` | user-global → org/team | status + exact-team revoke |
| Password reset | `uoa_admin` | user-global | password + all-refresh revoke + `tokenVersion` |
| Verify-email password binding | `uoa_admin` | user-global | password/token consume + all-refresh revoke + `tokenVersion` |
| Email 2FA reset | `uoa_admin` | user-global | 2FA/token consume + all-refresh revoke + `tokenVersion` |
| Authenticated 2FA disable | `uoa_admin` | user-global | TOTP replay claim + 2FA disable + all-refresh revoke + `tokenVersion` |
| Admin 2FA reset | `uoa_admin` | user-global | 2FA reset + all-refresh revoke + `tokenVersion` |

---

## API Contract

### `POST /auth/token`

Authorization-code request:

```json
{
  "code": "auth_code_here"
}
```

Refresh-token request:

```json
{
  "grant_type": "refresh_token",
  "refresh_token": "opaque_refresh_token"
}
```

Confidential assertion request:

```json
{
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token": "<short-lived source-signed RS256 JWT>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "product": "nessie",
  "resource": "https://ledger.unlikeotherai.com",
  "scope": "ai.invoke billing.read"
}
```

Chained access-token request (Nessie→DeepSignal→Ledger example):

```json
{
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token": "<UOA access token with aud=https://api.deepsignal.live>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "product": "deepsignal",
  "resource": "https://ledger.unlikeotherai.com",
  "scope": "ai.invoke"
}
```

DeepSignal authenticates that request with DeepSignal's own registered config
and per-domain app credential. UOA verifies the inbound UOA RS256 `at+jwt`,
requires its exact DeepSignal audience and non-null org/team provenance,
revalidates the original Nessie product/user/membership link, and narrows scope
through both the inbound token and DeepSignal's separate Ledger mapping. No app
key, webhook signing secret, or fallback credential is reused between hops.

Success response:

```json
{
  "access_token": "jwt_here",
  "expires_in": 1800,
  "refresh_token": "opaque_refresh_token",
  "refresh_token_expires_in": 2592000,
  "token_type": "Bearer"
}
```

The response is also returned for an unknown or context-mismatched token. Valid logout revokes the
complete family and invalidates existing access tokens before this response is sent.

The confidential grant instead returns only:

```json
{
  "access_token": "<5-minute resource-bound RS256 JWT>",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "ai.invoke billing.read"
}
```

It does not issue or rotate a refresh token. For a first-hop JWT, the source
backend creates a fresh assertion with a new unique `jti` when another resource
token is needed. After identity and any selected workspace are revalidated, UOA
atomically consumes that source-domain `jti` in PostgreSQL before signing. Exact
or concurrent replays are rejected across instances. Only a SHA-256 digest is
retained through the assertion's `exp` plus accepted clock tolerance, then
pruned.
An audience-bound access-token subject is reusable until `exp`; UOA does not add
it to the one-time assertion-use ledger. This permits concurrent calls across
DeepSignal instances while exact audience, app authentication, workspace
revalidation, and scope narrowing remain mandatory.

Application authentication and subject provenance are separate. Each product
uses its own existing per-domain app credential; the credential's authenticated
`ClientDomain` plus explicit product must match one enabled DB mapping with the
exact requested HTTPS resource and an allowlist of `ai.invoke`, `billing.read`,
and/or `token.provision`. The last scope is an explicit app capability used
only by a token provisioner; `ai.invoke` never implies it. The signed assertion carries the stable user and optional
organisation/team. A user token is never accepted as the application
credential, credentials are not shared across products, and there is no
singleton env fallback. The issued token and response contain exactly the
requested allowlisted scope subset plus the product claim.

The source assertion's `exp - iat` MUST be no more than 60 seconds. The issued
resource access token is at most five minutes (`expires_in: 300`); a chained
result is capped to the inbound token's remaining lifetime.

The signed assertion may omit `active` for a first-time or workspace-less user.
UOA still re-resolves the stable user and source-domain role. When `active` is
present it must contain both non-empty `orgId` and `teamId`; UOA verifies the
current ACTIVE memberships and includes `org` plus `active` in the resource
token. When absent, both workspace claims are omitted from the issued token.
Chained access-token subjects require both claims. Their output keeps the
revalidated original workspace, identifies the immediate caller in
`source_domain`/`azp`/`product`, and adds an RFC 8693 `act` chain for upstream
source/product provenance.

Confidential exchanges use a 600/minute authenticated source-domain ceiling and
a 60/minute verified source-domain-user ceiling. They do not share the legacy
10/minute/IP token-exchange bucket, so one product egress IP cannot starve all
users.

### `POST /auth/revoke`

Request:

```json
{
  "refresh_token": "opaque_refresh_token"
}
```

Success response:

```json
{
  "ok": true
}
```

---

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `ACCESS_TOKEN_TTL` | `30m` | Short-lived JWT lifetime, bounded to 15-60 minutes |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh-token lifetime in days, bounded to 1-90 |
| `MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK` | unset | RS256 signing key whose public half is served at `/oauth/jwks.json`; key presence does not enable public OAuth routes |
| `MCP_OAUTH_PUBLIC_PROFILE_ENABLED` | `false` | Explicit gate for discovery, registration, authorize, login, and public PKCE token routes |

---

## Consumer Responsibilities

Client backends integrating with the Authenticator must:

1. Exchange the authorization code on the backend only
2. Store the returned refresh token in a server-only location
3. Use `grant_type=refresh_token` to renew sessions
4. Call `POST /auth/revoke` during logout
5. Clear local cookies/session state if refresh fails
6. Persist the returned refresh successor and access-token state atomically
   before acknowledging a local session renewal
7. If the UOA success response may have been lost, retry the same predecessor
   promptly with the same application credential and exact client context; do
   not mint or derive a replacement locally
8. If a product already persisted the UOA result but lost its own downstream
   response, replay that committed local result (including the already-issued
   access-token version) instead of rotating through UOA again

---

## Deployment Notes

- The refresh-token feature requires the `refresh_tokens` Prisma migration to be deployed before the new application revision starts serving traffic.
- Confidential assertion replay protection requires the `confidential_assertion_uses` migration to be deployed before confidential exchange traffic reaches the new revision.
- Per-product exchange requires `20260719020000_add_confidential_delegation_mappings`, an active registered ClientDomain/credential for each product, and an audited mapping provisioned before that product sends traffic. Unknown/disabled mappings fail closed.
- For G Cloud / Cloud Run deployments, apply `prisma migrate deploy` as part of the rollout before or alongside the new container revision.
