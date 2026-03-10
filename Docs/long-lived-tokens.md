# Long-Lived Tokens

> **Status:** Implemented
> **Purpose:** Define the refresh-token contract used by client backends that need long-lived sessions without re-running the full OAuth popup flow.

---

## Current Behavior

The Authenticator now issues a **token pair** from `POST /auth/token`:

- `access_token` — short-lived JWT for API calls
- `refresh_token` — opaque bearer token for server-side renewal only
- `token_type`
- `expires_in`
- `refresh_token_expires_in`

`POST /auth/token` supports two grants:

1. Authorization-code exchange
2. Refresh-token exchange with `grant_type=refresh_token`

`POST /auth/revoke` revokes the refresh-token family used by the caller during logout.

---

## Token Model

| Token | Format | Lifetime | Client Storage | Server Storage |
|-------|--------|----------|----------------|----------------|
| Access token | HS256 JWT | 15-60 minutes | Memory / short-lived session | Stateless |
| Refresh token | Opaque random base64url string | 1-90 days, default 30 | Backend-only, never browser JS | SHA-256 hash in `refresh_tokens` |

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
- `expires_at`
- `revoked_at`
- `last_used_at`
- `created_at`

Only the hash is persisted. Raw refresh tokens are never stored.

---

## Rotation and Reuse Detection

Every successful refresh-token exchange:

1. Creates a new refresh token in the same family
2. Marks the previous token as revoked
3. Links the old token to the replacement with `replaced_by_token_id`

If an already-rotated refresh token is presented again:

1. The entire token family is revoked
2. The request fails with a generic unauthorized response
3. Subsequent refresh attempts from that family also fail

This is the theft-detection path for replayed refresh tokens.

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

---

## Consumer Responsibilities

Client backends integrating with the Authenticator must:

1. Exchange the authorization code on the backend only
2. Store the returned refresh token in a server-only location
3. Use `grant_type=refresh_token` to renew sessions
4. Call `POST /auth/revoke` during logout
5. Clear local cookies/session state if refresh fails

---

## Deployment Notes

- The refresh-token feature requires the `refresh_tokens` Prisma migration to be deployed before the new application revision starts serving traffic.
- For G Cloud / Cloud Run deployments, apply `prisma migrate deploy` as part of the rollout before or alongside the new container revision.
