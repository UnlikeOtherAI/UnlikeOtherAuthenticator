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

Kelpie account connectivity requires dedicated kelpie.connect consent, granted only
to the exact enabled registered com.unlikeotherai.kelpie app. POST /oauth/kelpie/connect
with the native UOA account bearer and {resource: "https://api.nessie.works/api/kelpie/connect"}
returns {connection_ticket,token_type:"Bearer",expires_in,gateway_url}. The resource
must exactly equal operator KELPIE_CONNECT_RESOURCE; absent disables this feature.
The RS256 at+jwt ticket is at most120 seconds and capped by source account expiry.
It carries iss/sub/aud/iat/exp/jti/client_id/app_id/tv/twofa, scope=kelpie.connect
and token_use=kelpie_connect; no email, name, avatar, organisation or team.
Send only that ticket in the gateway's first WSS frame. Renew after60seconds or
before expiry through the same endpoint, refreshing the native account token through
the existing grant as needed. A403 requires fresh consent; a401 permits one account
refresh then sign-in if still refused. Never widen an existing refresh grant.
App scope edits invalidate old client revisions: re-register and sign in once.
404 means operator configuration/profile is unavailable;429/network/5xx retry with
backoff while retaining native account credentials. All responses are no-store.

The gateway calls POST /oauth/kelpie/connect/validate?domain=api.nessie.works with
its existing domain bearer and {ticket}. UOA re-resolves current native and account
authority and authenticates the exact resource host. Success is
{active:true,iss,sub,aud,client_id,app_id,exp,jti}; invalid authority is a generic401.
Validate before dispatch and at most every30seconds, close on failure or ticket
expiry, and accept only renewed tickets for the same issuer/subject/client.
UOA remains the identity authority; Nessie resolves its existing team entitlements
separately and stores only stable references and product-specific device data.
App IDs are public registration metadata, never binary attestation.

Same-account LAN pairing uses POST /oauth/kelpie/pair with the requesting application's
existing Kelpie UOA account bearer and {challenge,clientId}. challenge is the receiving
Kelpie's fresh 43-character base64url nonce; clientId names the exact LAN caller.
Existing kelpie.connect consent is required. The returned {pairing_ticket,token_type,
expires_in} is profile-free, at most120seconds, capped by source expiry and carries
token_use=kelpie_pair, exact challenge/client binding and a challenge-bound urn audience.
Only that proof travels to the LAN; never forward a UOA account credential there.
This flow needs no KELPIE_CONNECT_RESOURCE and cannot authenticate a gateway/account.

The receiving registered Kelpie calls POST /oauth/kelpie/pair/validate using its own
UOA profile-scope account bearer and {ticket,challenge,clientId}. UOA checks both live
account authorities and exact subject equality, returning {active:true,expires_at}
(epoch milliseconds capped by both accounts) or200 {active:false}. Invalid requester
proof never signs the receiver out:401 is reserved for its own invalid account.
No identity/profile is returned. Accept only active proof, without an Allow dialog,
keep resulting local access in memory until expiry/sign-out/revoke, and revalidate
before every HTTP/MCP call. Account switch and failed validation deny access.
Calls without account authorization retain ordinary on-device pairing. Never silently
downgrade failed account proof to approval. All responses are no-store.
`;
