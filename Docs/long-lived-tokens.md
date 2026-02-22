# Long-Lived Tokens — Specification

> **Status:** Proposed
> **Purpose:** Add refresh token support to the Authenticator so consumer products (e.g. Remember Ninja admin panel) can maintain long-lived sessions without forcing re-authentication every 15–60 minutes.

---

## Problem

The Authenticator currently issues **short-lived JWTs only** (15–60 minute TTL, configurable via `ACCESS_TOKEN_TTL`). There are no refresh tokens. When a token expires, the client must re-initiate the full OAuth flow (popup → authenticate → code exchange).

This is acceptable for products where authentication is infrequent, but breaks down for **admin panels and dashboards** where users expect long-lived sessions (hours or days). Forcing a popup re-auth every 30 minutes is hostile UX.

---

## Solution: Refresh Token Grant

Add an **opaque refresh token** alongside the existing access token. The refresh token is long-lived, stored server-side, and can be exchanged for a new access token without user interaction.

### Token Pair

| Token | Type | Lifetime | Storage (Client) | Storage (Server) |
|-------|------|----------|-------------------|-------------------|
| **Access token** | JWT (HS256, signed) | 15–60 min (unchanged) | Memory (JavaScript variable) | Not stored (stateless) |
| **Refresh token** | Opaque (random 64 bytes, base64url) | 30 days (configurable) | HttpOnly Secure SameSite=Strict cookie | Hashed (SHA-256) in `refresh_tokens` table |

### Why Opaque (Not JWT) for Refresh Tokens

- Refresh tokens are **always validated server-side** (DB lookup) — there's no benefit to self-contained claims
- Opaque tokens can be **revoked instantly** by deleting the DB row
- No risk of stale claims in a long-lived JWT
- Shorter token string (86 chars vs 300+ for JWT)

---

## Database Schema

```sql
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain          TEXT NOT NULL,               -- which client domain issued this
    token_hash      TEXT NOT NULL UNIQUE,         -- SHA-256 of the opaque token
    token_family    UUID NOT NULL,                -- rotation family (detect reuse)
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ,
    replaced_by     UUID REFERENCES refresh_tokens(id),  -- points to next token in chain
    ip_address      INET,
    user_agent      TEXT
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id, domain) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX idx_refresh_tokens_family ON refresh_tokens (token_family);
CREATE INDEX idx_refresh_tokens_expires ON refresh_tokens (expires_at) WHERE revoked_at IS NULL;
```

### Prisma Schema Addition

```prisma
model RefreshToken {
  id           String    @id @default(uuid())
  userId       String    @map("user_id")
  domain       String
  tokenHash    String    @unique @map("token_hash")
  tokenFamily  String    @map("token_family")
  expiresAt    DateTime  @map("expires_at")
  createdAt    DateTime  @default(now()) @map("created_at")
  revokedAt    DateTime? @map("revoked_at")
  replacedById String?   @map("replaced_by")
  ipAddress    String?   @map("ip_address")
  userAgent    String?   @map("user_agent")

  user         User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  replacedBy   RefreshToken? @relation("TokenChain", fields: [replacedById], references: [id])
  replacements RefreshToken[] @relation("TokenChain")

  @@index([userId, domain])
  @@index([tokenFamily])
  @@map("refresh_tokens")
}
```

---

## API Changes

### Token Exchange Response (Updated)

`POST /auth/token` — exchange authorization code for tokens.

**Current response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**New response:**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 1800,
  "token_type": "Bearer"
}
```

The refresh token is **NOT** returned in the JSON body. Instead, it is set as a cookie:

```
Set-Cookie: __Host-refresh=<opaque_token>; HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh; Max-Age=2592000
```

**Why cookie instead of response body:**
- HttpOnly prevents XSS from reading the refresh token
- SameSite=Strict prevents CSRF
- Path=/auth/refresh limits cookie transmission to refresh endpoint only
- The access token (in memory) is the XSS-vulnerable surface; keeping the refresh token in a cookie means an XSS attack cannot escalate to long-lived access

### New Endpoint: Refresh

`POST /auth/refresh`

No request body needed — the refresh token comes from the cookie.

**Success response (200):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 1800,
  "token_type": "Bearer"
}
```

A new `Set-Cookie` header is also sent (token rotation — see below).

**Error responses:**
- `401` — No refresh cookie, or token not found / expired / revoked
- `403` — Token reuse detected (entire family revoked — see security section)

### New Endpoint: Logout

`POST /auth/logout`

Revokes the refresh token from the cookie. Clears the cookie.

**Response (200):**
```json
{
  "logged_out": true
}
```

### New Endpoint: Revoke All Sessions

`POST /auth/revoke-all`

Requires a valid access token. Revokes all refresh tokens for the authenticated user across all domains.

**Response (200):**
```json
{
  "revoked": 5,
  "message": "All sessions revoked"
}
```

---

## Token Rotation

Every time a refresh token is used, a **new refresh token** is issued and the old one is marked as used (`replaced_by` set). This is called **refresh token rotation**.

```
Initial login:
  → Access token A1, Refresh token R1 (family F1)

R1 used to refresh:
  → Access token A2, Refresh token R2 (family F1)
  → R1 marked as replaced_by = R2

R2 used to refresh:
  → Access token A3, Refresh token R3 (family F1)
  → R2 marked as replaced_by = R3
```

### Reuse Detection

If an **already-used** refresh token (e.g. R1, which was replaced by R2) is presented:

1. This indicates the token was stolen (legitimate user already used it, attacker is replaying)
2. **Revoke the entire family** (all tokens with `token_family = F1`)
3. Return `403 Forbidden` with error `token_reuse_detected`
4. Log a security event

This is the standard approach recommended by the OAuth 2.0 Security Best Current Practice (RFC 6819, draft-ietf-oauth-security-topics).

---

## Configuration

New environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REFRESH_TOKEN_ENABLED` | `false` | Enable refresh token issuance |
| `REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token lifetime in days |
| `REFRESH_TOKEN_MAX_PER_USER` | `10` | Max active refresh tokens per user per domain |

### Config JWT Support

Consumer products opt into refresh tokens via their config JWT:

```json
{
  "domain": "admin.remember.ninja",
  "refresh_tokens": {
    "enabled": true,
    "ttl_days": 30
  }
}
```

If `refresh_tokens` is absent or `enabled: false`, behaviour is unchanged (access token only, no refresh cookie).

---

## Client Integration

### Token Exchange (Updated)

```javascript
// Client backend: exchange auth code for tokens
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  const response = await fetch('https://auth.unlikeotherai.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: hashDomainAndSecret(domain, sharedSecret)
    }),
    credentials: 'include'  // Important: accept Set-Cookie
  });

  const { access_token, expires_in } = await response.json();
  // Refresh token is now in an HttpOnly cookie managed by the browser

  // Forward the Set-Cookie header to the client
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) res.setHeader('Set-Cookie', setCookie);

  // Store access token in memory (JavaScript variable)
  // Return to the SPA
});
```

### Silent Refresh (Browser SPA)

```javascript
async function refreshAccessToken(): Promise<string | null> {
  try {
    const response = await fetch('https://auth.unlikeotherai.com/auth/refresh', {
      method: 'POST',
      credentials: 'include',  // sends the HttpOnly cookie
    });

    if (!response.ok) return null;

    const { access_token } = await response.json();
    return access_token;
  } catch {
    return null;  // network error → redirect to login
  }
}

// Set up a timer to refresh before expiry
function scheduleRefresh(expiresIn: number) {
  const refreshAt = (expiresIn - 60) * 1000;  // 60s before expiry
  setTimeout(async () => {
    const newToken = await refreshAccessToken();
    if (newToken) {
      store.setAccessToken(newToken);
      scheduleRefresh(expiresIn);  // reschedule
    } else {
      store.clearSession();
      redirectToLogin();
    }
  }, refreshAt);
}
```

---

## Cleanup

A background job (or Prisma middleware) should periodically delete expired and revoked refresh tokens:

```sql
DELETE FROM refresh_tokens
WHERE (expires_at < now() - INTERVAL '7 days')
   OR (revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '7 days');
```

This can run daily. Keeping revoked tokens for 7 days allows security analysis of reuse patterns.

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| **XSS stealing refresh token** | HttpOnly cookie — JavaScript cannot read it |
| **CSRF using refresh cookie** | SameSite=Strict — cookie not sent on cross-origin requests |
| **Refresh token stolen from DB** | Stored as SHA-256 hash (like API keys) |
| **Replay attack** | Token rotation + reuse detection → entire family revoked |
| **Long session after password change** | On password change, revoke all refresh tokens for the user |
| **Leaked refresh token** | 30-day expiry caps exposure window. Admin can revoke all. |

---

## Implementation Scope

### Phase 1 (This Spec)

1. Add `refresh_tokens` table (Prisma migration)
2. Add `RefreshToken` Prisma model
3. Create `RefreshTokenService` (create, validate, rotate, revoke, reuse detection)
4. Update `POST /auth/token` to issue refresh cookie when enabled
5. Add `POST /auth/refresh` endpoint
6. Add `POST /auth/logout` endpoint
7. Add `POST /auth/revoke-all` endpoint
8. Add config JWT validation for `refresh_tokens` field
9. Add cleanup job for expired tokens
10. Update tests

### Not in Scope

- Sliding window refresh (extend TTL on use) — use fixed expiry for simplicity
- Per-device session management UI — future feature
- Refresh token for social provider token refresh — only for our own tokens
