# Native UOA accounts

Native public clients authenticate directly to UOA; no product auth backend, embedded
client secret or copied user/profile database is needed. The production public profile
uses the dedicated `native.authentication.unlikeotherai.com` logical domain, separate
from the administrative domain. The issuer remains `https://authentication.unlikeotherai.com`.

1. Discover `/.well-known/oauth-authorization-server` and register at `/oauth/register`.
   Register the exact callback and requested scopes. Only authorization_code is supported.
2. Open `/oauth/authorize` in the system authentication browser with fresh state and S256
   PKCE. Hosted email/password login displays the destination and requested access.
3. Enrolled TOTP is replay protected. Submit password again with `code` after
   `twofa_required`. Required enrollment returns a setup token and authenticator secret;
   submit `setup_token` and `code` with the same password and authorization parameters.
   The setup token is bound to user, credential epoch, domain and every authorization
   parameter. Signature requirements still pass through the existing signature gate.
4. Validate the exact callback and state; exchange the one-use code at `/oauth/token`.
   Do not request a resource when accessing UOA's account endpoints. The issuer is their
   required audience. There is no public refresh grant; repeat hosted sign-in on expiry.

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

Kelpie keeps tokens, profile, avatar and signed-in favourites in memory. Its public client
registration id may persist; it is not a credential. Local signed-out favourites remain
separate and are restored on sign-out. Account switching or expiry discards pending local
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
does not revive old clients. Public refresh tokens remain unsupported. Offline resource
servers may accept already-issued resource tokens until their expiry. See
[the native app design](../plans/native-app-sign-in.md) for the authority boundaries.

Native hosted login places enabled social methods above password fields so the
Google button remains visible in short default-browser windows. Website login
retains its existing order. Both methods display the registered app and access.
