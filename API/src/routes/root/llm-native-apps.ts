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

Google sign-in uses /oauth/social/google with the same validated public OAuth
parameters and the existing provider callback. Enabled registration allows verified
Google users to create accounts; native email registration/recovery is not advertised.
Current epoch, bans, second-factor and signature requirements still apply. The one-use public
Google completion is isolated from the signed-config website flow. App security edits
invalidate existing registrations and UOA account tokens; name/color/icon edits do
not. Offline resource servers enforce their own revocation and token expiry.
`;
