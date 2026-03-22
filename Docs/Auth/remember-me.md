# Remember Me

> **Status:** Implemented
> **Purpose:** Define the "remember me" checkbox behavior on the login form and how it affects session token lifetimes.

---

## Overview

The "remember me" feature allows users to opt into longer-lived sessions. When enabled, the refresh token TTL extends from the short session default (1 hour) to the configured long-lived duration (default 30 days). The access token JWT TTL is unaffected — it remains short-lived regardless of remember-me state.

---

## Remote Config Fields

All session behavior is controlled via the signed config JWT. No server-side environment variables are added.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `session.remember_me_enabled` | `boolean` | `true` | Whether to show the "Remember me" checkbox on the login form |
| `session.remember_me_default` | `boolean` | `true` | Default checked state of the checkbox when shown |
| `session.short_refresh_token_ttl_hours` | `number` | `1` | Refresh token TTL when remember-me is OFF (1-168 hours) |
| `session.long_refresh_token_ttl_days` | `number` | `30` | Refresh token TTL when remember-me is ON (1-90 days) |
| `session.access_token_ttl_minutes` | `number` | `30` | Access token JWT TTL (15-60 minutes) |

When `session.remember_me_enabled` is `false`, the checkbox is hidden and the session always uses `short_refresh_token_ttl_hours`.

---

## Data Flow

1. **Login form** sends `remember_me: true/false` in the POST body to `/auth/login`
2. **Authorization code** is created with a `rememberMe` boolean column
3. **Token exchange** (`POST /auth/token`) reads `rememberMe` from the consumed auth code
4. **Refresh token** is issued with a TTL derived from the config:
   - `remember_me=true` → `session.long_refresh_token_ttl_days` (days)
   - `remember_me=false` → `session.short_refresh_token_ttl_hours` (hours)
5. **Access token** TTL uses `session.access_token_ttl_minutes` if set, otherwise falls back to `ACCESS_TOKEN_TTL` env var

---

## Auth Code Schema Change

The `authorization_codes` table gains one column:

```
rememberMe  Boolean  @default(false) @map("remember_me")
```

This persists the user's checkbox choice between the login step and the token exchange step (which may be a separate HTTP request from the client backend).

---

## Refresh Token Rotation

When a refresh token is rotated via `grant_type=refresh_token`, the new token inherits the TTL of the original session. The remember-me flag is not re-evaluated — it was set at login time and persists for the session lifetime.

To implement this cleanly, the refresh token TTL on rotation uses the same duration that was used when the token was originally created. This is derived from the `expiresAt` minus `createdAt` of the parent token.

---

## Non-Login Auth Flows

Flows that bypass the login form (email registration links, social OAuth, 2FA completion) default `rememberMe` to the config's `session.remember_me_default` value. The user had no opportunity to uncheck the box in these flows.

---

## UI Behavior

The checkbox renders between the password field and the submit button in the LoginForm component. It reads `session.remember_me_enabled` and `session.remember_me_default` from the client config passed through `PopupProvider`.

When `remember_me_enabled` is `false` (or the `session` config block is absent), the checkbox is not rendered and `remember_me: false` is sent in the login request body.
