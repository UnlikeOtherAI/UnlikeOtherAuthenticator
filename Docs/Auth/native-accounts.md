# Native UOA accounts

Native public clients authenticate directly to UOA; no product auth backend, embedded
client secret or copied user/profile database is needed. The production public profile
uses the dedicated `native.authentication.unlikeotherai.com` logical domain, separate
from the administrative domain. The issuer remains `https://authentication.unlikeotherai.com`.

1. Discover `/.well-known/oauth-authorization-server` and register at `/oauth/register`.
   Register the exact callback and requested scopes. Plain registrations support only
   authorization_code; registrations with an enabled native-app `app_id` also support
   refresh_token (see [Native refresh tokens](#native-refresh-tokens)).
2. Open `/oauth/authorize` in the system authentication browser with fresh state and S256
   PKCE. Hosted email/password login displays the destination and requested access.
3. Enrolled TOTP is replay protected. Submit password again with `code` after
   `twofa_required`. Required enrollment returns a setup token and authenticator secret;
   submit `setup_token` and `code` with the same password and authorization parameters.
   The setup token is bound to user, credential epoch, domain and every authorization
   parameter. Signature requirements still pass through the existing signature gate.
4. Validate the exact callback and state; exchange the one-use code at `/oauth/token`.
   Do not request a resource when accessing UOA's account endpoints. The issuer is their
   required audience. Plain registrations have no refresh grant and repeat hosted sign-in on
   expiry; native-app registrations renew as described in
   [Native refresh tokens](#native-refresh-tokens).

Scopes are the configured `MCP_OAUTH_SCOPES_SUPPORTED` allowlist (default `openid`,
`profile`, `email`, `settings.read`, `settings.write`) intersected with the registered
client's grants. Registering an app does not authenticate a human or confer admin access.
Public clients cannot call confidential `/settings/me` using their token.

## Profile and personal settings

All responses are no-store. Identity is taken from the verified token's subject, never
from a supplied user id. RS256 signature, token class, issuer, audience, expiry, client,
domain, current credential epoch and current second-factor policy are checked. Writes
recheck authority under the same transaction/credential locks as their durable update.

- `GET /oauth/me` requires `profile`: `{sub,email,name}`.
- `GET /oauth/me/avatar` requires `profile`: UOA-resolved image bytes.
- `GET /oauth/me/settings/:namespace/:key` requires `settings.read`: `{value}`, plus
  an opaque `ETag`; an absent value is null.
- `PUT /oauth/me/settings/:namespace/:key` requires `settings.write`: `{value}`, plus
  `If-Match` containing the GET ETag. Null deletes. Missing precondition returns 428;
  conflicting value returns 409. Reread and reapply the user's intended change.

Settings use the same `user_settings` table and quotas as [user-settings.md](user-settings.md).
Values remain opaque. Kelpie uses namespace `browser`, key `bookmarks`, containing a JSON
array of bookmark objects. Settings scopes allow all personal namespaces: users consent
on the hosted page; do not store secrets in settings.

Kelpie keeps the access token, profile, avatar and signed-in favourites in memory. It persists
only `{client_id, refresh_token}` in the platform's encrypted secret store (key
`uoa.session.v1`); the public client registration id is not a credential. Local signed-out
favourites remain separate and are restored on sign-out. Account switching or expiry discards pending local
responses and account data; a write already accepted by UOA may complete for that account.

Operators can register native sign-in profiles in **Admin → Apps**. Pass their public
reverse-domain identifier as `app_id` when registering. The server checks the stored
callbacks/scopes and supplies the saved icon, colors and login methods. Google supports
existing accounts and, when allowed by the app policy, new verified accounts. Native
email registration and password recovery are not advertised. TOTP and required enrollment
remain enforced. The social callback uses a separate one-use server flow and per-login browser
cookie; completion never enters the confidential website code flow.

Security edits invalidate existing client registrations and UOA account sessions;
cosmetic edits preserve them. Disable retains the identifier permanently; re-enabling
does not revive old clients, and their refresh-token families stop working with them. Plain
(non-app) registrations still receive no refresh token. Offline resource
servers may accept already-issued resource tokens until their expiry. See
[the native app design](../plans/native-app-sign-in.md) for the authority boundaries.

Native hosted login places enabled social methods above password fields so the
Google button remains visible in short default-browser windows. Website login
retains its existing order. Both methods display the registered app and access.

## Native refresh tokens

Added 2026-09-27. Clients registered with an enabled native-app `app_id` receive a rotating
refresh token so a signed-in app survives restarts and access-token expiry. It reuses the
confidential refresh-token machinery (`refresh_tokens` families, rotation, replay grace, reuse
detection) described in [long-lived-tokens.md](long-lived-tokens.md); plain dynamic registrations
are unchanged and never receive one.

- **Issue.** The authorization-code exchange additionally returns `refresh_token` (opaque) and
  `refresh_token_expires_in` (seconds, `REFRESH_TOKEN_TTL_DAYS`, default 30 days). The family is
  created in the code-redemption transaction under the credential-epoch locks and stores the
  code's credential epoch, exact scope and resource.
- **Refresh.** `POST /oauth/token` with JSON
  `{"grant_type":"refresh_token","refresh_token":"…","client_id":"…"}` returns
  `{access_token, token_type:"Bearer", expires_in, refresh_token, refresh_token_expires_in, scope}`.
  Every use rotates the token; persist the new one before using the access token. The row is
  bound to the exact public client id, the native logical domain and the fixed context
  `urn:unlikeotherai:uoa:public-oauth-client`, which no confidential `/auth/token` row can carry.
- **Checks, in the rotation transaction.** Product-policy lock, current client and enabled,
  current-revision native app, user-global and user/domain refresh locks, user existence, the
  family's credential epoch equal to the user's current `tokenVersion`, current second-factor
  policy against the family's original TOTP proof, signature policy, and the stored scope and
  resource still within the client registration and server allowlists. The new access token is
  signed exactly like the code-exchange token with the original scope and resource, never
  broader; an explicit `scope` parameter must repeat the original exactly.
- **Ending a family.** Any credential-epoch increment ends every native family of the user:
  password reset or binding, second-factor disable or reset, a confidential `/auth/revoke`
  logout in any product, a public `/oauth/revoke`, or refresh-token reuse detection anywhere.
  Disabling the app or a security edit invalidates the registration and therefore its families.
- **Errors.** Every refusal (unknown, expired, revoked, reused or foreign-client token, disabled
  app, changed credentials, insufficient factor, incomplete signature policy, narrowed allowlist,
  mismatched `scope` parameter) is `401` with the generic error body; a malformed request body is
  `400`.
  Neither ever says which check failed. Refresh has its own per-IP rate-limit bucket (60 per
  5 minutes) so launch-time restores are not starved by interactive code exchanges (30 per 5
  minutes).
- **Replay grace.** Re-presenting the immediate predecessor within 120 seconds returns the same
  live successor (response-loss recovery). For a public client the only binding is the
  non-secret `client_id`, so a stolen predecessor could recover the successor within that window;
  later reuse revokes the family and increments the credential epoch.
- **Revoke.** `POST /oauth/revoke` with JSON `{"token":"…","client_id":"…"}` (RFC 7009) always
  answers `200 {}` with `Cache-Control: no-store`. When the token belongs to that client it
  revokes the family with the same logout semantics as `/auth/revoke` — one credential-epoch
  increment, which also invalidates current access tokens and ends the user's other native
  sessions. Unknown, foreign, repeated or malformed tokens are a silent no-op. Rate limited per IP.
- **Client storage.** Store only the refresh token and client id in the OS encrypted secret
  store; never the access token, profile or avatar. A `400`/`401` from refresh means the session
  ended: clear it and sign in again. Network errors, `408`, `429` and `5xx` are transient: keep it.
