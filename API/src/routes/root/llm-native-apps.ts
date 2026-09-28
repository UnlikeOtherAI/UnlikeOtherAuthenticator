export const llmNativeAppsMarkdown = `
## Native app sign-in (public clients; no embedded secret)

Operators register a reverse-domain identifier in Admin → Apps. Store the app name,
PNG/JPEG/WebP icon (256 KB maximum), colors, exact return URLs, account scope allowlist,
Google/password methods, registration policy and enabled status there. These are
independent of billing credentials and feature-flag apps. Only admin superusers may
manage /internal/admin/native-apps. No hard-delete endpoint exists.

Send app_id with POST /oauth/register plus redirect_uris, scope and
token_endpoint_auth_method=none. app_id is public metadata, not binary identity or
permission to bypass authentication. The server checks its stored policy and issues
a public client_id. Numeric loopback HTTP ports may vary at registration; subsequent
steps bind the exact registered URI. Use fresh state and mandatory S256 PKCE with
/oauth/authorize; exchange its one-use code at /oauth/token. Never put session tokens
in return URLs. Native account endpoints and settings scopes are described below.

Registered native-app clients also receive an opaque refresh_token and
refresh_token_expires_in from that exchange. Keep only the refresh token and client_id in the
platform's encrypted secret store (never the access token or profile), persist every rotated
refresh token before using its access token, and renew with POST /oauth/token
{grant_type: "refresh_token", refresh_token, client_id}. Refreshing within 60 s of access-token
expiry, or once after a 401, is enough. A 400/401 means the session ended (reuse, sign-out
anywhere, password or second-factor change, app disabled or edited): clear it and sign in again.
Network errors, 429 and 5xx are transient: keep the stored token. On sign-out call
POST /oauth/revoke {token, client_id} (always 200); it ends the user's other native sessions too.

Google sign-in uses /oauth/social/google with the same validated public OAuth
parameters and the existing provider callback. Enabled registration allows verified
Google users to create accounts; native email registration/recovery is not advertised.
Current epoch, bans, second-factor and signature requirements still apply. The one-use public
Google completion is isolated from the signed-config website flow. App security edits
invalidate existing registrations and UOA account tokens; name/color/icon edits do
not. Offline resource servers enforce their own revocation and token expiry.
`;
