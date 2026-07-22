export const llmIntegrationMarkdown2 = `## Phase 4.8 — Slack-style email sign-in codes + workspace selection (opt-in)

Additive on top of \`/auth/register\` and \`/auth/login\` — chooser UI remains gated by config
\`login_flow\`. Legacy clients are unchanged at the defaults; server-recognized products still
pre-bind their mandatory exact workspace before 2FA when the chooser is off:

\`\`\`jsonc
"login_flow": {
  "email_code_enabled": false,      // offer a 6-digit sign-in code alongside the magic link
  "workspace_selection": "off"      // "off" suppresses the chooser; "auto" may show it
}
\`\`\`

**Security note (read before enabling):** workspace names, team membership, and pending invites are
revealed ONLY after the user's identity has been verified (a valid sign-in code or magic link) —
never from \`/auth/start\`, which always returns the same generic message regardless of whether the
email exists. The \`login_token\` bridge issued by \`/auth/verify-code\` (and, when the chooser is on,
by every verified identity path) authorizes ONLY the original chooser continuation for that user.
It signs the exact config URL plus a canonical fingerprint of the current verified parsed config,
redirect, PKCE, remember-me, access-request flag, subject/domain, expiry, and JTI. Final selection
claims the hashed JTI as the first statement in the same transaction as invite/membership mutation
and authorization. A concurrent replay therefore loses before it can send an access-request email
or emit invite audit state, while any later failure rolls the claim back so the original continuation
can be retried; \`session-choices\` and invite decline validate but do not consume it.

1. \`POST /auth/start?config_url=...\` — body \`{ email }\`. Same generic response as
   \`/auth/register\`; when \`email_code_enabled\` is true it additionally emails a 6-digit code.
2. \`POST /auth/verify-code?config_url=...\` — body \`{ email, code }\`. IP + email rate-limited; wrong
   code, expired code, no code, and a dead (5-attempt) code all return the identical generic auth
   error. On success:
   - \`workspace_selection: "auto"\` → \`{ login_token, teams: [{ teamId, orgId, name, slug, role, iconUrl }], pending_invites: [{ inviteId, teamName, invitedBy }], can_create_org }\`.
   - \`workspace_selection: "off"\` (default) → finalizes immediately, same response shape as
     \`/auth/login\` (\`{ ok, code, redirect_to }\`, or a \`twofa_token\`/\`twofa_enroll_required\` branch —
     2FA still applies, only the chooser step is skipped). A recognized product first resolves its
     exact server-owned workspace and includes that Organisation in strongest-wins 2FA policy.
3. \`POST /auth/select-team?config_url=...\` — body \`{ login_token, teamId }\` (or
   \`{ login_token, inviteId, action: "accept" | "decline" }\`). Validates the bridge token, that the
   caller has not changed any signed continuation field, and that the user holds exact ACTIVE
   organisation and team memberships. Legacy clients remain limited to their own config domain. A
   product domain expands to all exact ACTIVE memberships only when UOA's server-owned control plane
   has an active ClientDomain and current CUSTOMER_LIFECYCLE app keys whose exact HTTPS actorIssuer
   maps unambiguously to one active BillingService. Unknown, inactive, expired, revoked, or ambiguous
   mappings remain same-domain; pending invites are never expanded. Ineligible or inactive scope is
   rejected exactly like an invalid token — no IDOR oracle. Enforces the selected
   org's 2FA policy, then finalizes with the resolved
   workspace scope: the returned \`code\` carries \`orgId\`/\`teamId\`, so the eventual \`POST /auth/token\`
   exchange's access token includes the \`active: { orgId, teamId }\` claim (§4.2) next to the existing
   \`org\` claim. Code exchange locks and revalidates the exact ACTIVE organisation/team scope in the
   same transaction that consumes the code and issues the refresh/access-token family, so a
   concurrent membership deactivation either finishes first and rejects exchange without consuming
   the code, or waits until the successful exchange has committed.
   The same central policy builds \`firstLogin.memberships\`. Every scoped refresh revalidates the
   exact mapping and memberships and fails without rotating if they changed; UOA never silently
   drops \`active\`, switches tenants, or creates a product-domain workspace.
4. \`POST /auth/login\` (password) also routes into the chooser when \`workspace_selection: "auto"\` and
   2FA is already satisfied: it returns \`{ login_token, teams, pending_invites, can_create_org }\`
   instead of finalizing directly, and the client then calls \`/auth/select-team\`. With the default
   \`"off"\`, legacy clients remain unchanged; recognized products suppress the chooser but resolve
   one exact workspace (or required first placement) before any 2FA decision and fail closed on
   ambiguous choices.
5. Social login (\`GET /auth/callback/:provider\`) resolves workspace immediately after identity,
   before 2FA. With \`workspace_selection: "auto"\`, 2+ ACTIVE teams, any pending invite, or zero
   teams with \`can_create_org: true\` route to the chooser. Exactly one ACTIVE team and no invite is
   an unambiguous server-side selection: its
   exact \`orgId\`/\`teamId\` is carried through any 2FA challenge or required-enrollment setup token
   into the authorization code, so access and rotated refresh sessions retain
   \`active: { orgId, teamId }\`. With \`workspace_selection: "off"\`, legacy clients remain unscoped,
   while recognized products pre-bind the same exact scope without showing a chooser. As a GET
   redirect the multi-choice branch can't inline the chooser
   JSON, so it mints the same \`login_token\` bridge and redirects to
   \`/auth?config_url=...&redirect_url=...&login_token=...&flow=workspace_chooser\`.
   The Auth UI then calls \`POST /auth/session-choices?config_url=...\` \`{ login_token }\` to hydrate
   \`{ teams, pending_invites, can_create_org }\` — generic rejection for an invalid/expired token, no
   enumeration.
6. Magic links (\`GET /auth/email/link\`, both the passwordless LOGIN_LINK/VERIFY_EMAIL auto-consume
   and the VERIFY_EMAIL_SET_PASSWORD → \`POST /auth/verify-email\` path) join the same chooser gate —
   the design's "magic links join the same flow". LOGIN_LINK/VERIFY_EMAIL redirect to \`/auth?...&
   login_token=...&flow=workspace_chooser\` exactly like the social callback; \`POST /auth/verify-email\`
   instead returns the inline JSON chooser payload exactly like \`/auth/login\`. The same exact-one
   rule binds the sole ACTIVE team's \`orgId\`/\`teamId\` when the chooser is skipped, and that exact
   scope survives an enrolled-2FA challenge or required-enrollment setup token before code issuance.
   Zero teams with \`can_create_org: true\` still enter the chooser so the create-workspace action is
   reachable. An invite-bound link never sees the chooser: token consumption returns the accepted
   invite's exact \`orgId\`/\`teamId\`, applies the effective 2FA policy, and preserves that scope
   through the authorization code, access token, refresh token, and rotation.
   Both email continuations perform chooser reads, recognized-product placement, exact policy/2FA
   finalization, and immediate code issuance in one admin transaction. Its per-user placement lock
   remains held through commit, so concurrent first use from different products reuses one
   canonical workspace; an issuance failure rolls the workspace and code back together while the
   one-time email token remains consumed.
   A \`LOGIN_LINK\` resolves only the existing \`userId\` stored when it was issued; a missing,
   deleted, or identity-mismatched account fails closed and can never become new-user registration.
   At code exchange UOA re-resolves the current exact-workspace policy and enrollment state. The
   code carries whether TOTP was completed, so a newly stricter policy rejects a proof-free code
   transactionally instead of issuing a refresh/access-token family.
7. \`GET /auth\` accepts an optional \`team_hint=<teamId|slug>\` — a chooser preselect / one-click
   workspace switch (design §11.4): a product's sidebar links back into \`/auth\` with the workspace
   the user clicked, and if a team in that user's own (already-verified) chooser payload matches by
   \`teamId\` or \`slug\`, the Auth UI auto-selects it via the same code path as the single-team
   auto-skip. Client-side preselect ONLY — an invalid or non-matching hint is silently ignored (the
   chooser just renders normally); \`select-team\`'s product-policy + exact ACTIVE-membership check is the sole
   authority and a hint can never select a team the user isn't already a member of.

---

## Phase 4.9 — Shareable team invite links (opt-in)

Additive on top of the invite system in 4.7a — a link that can be shared outside of email (Slack's
"Copy invite link"). A link authorizes **joining** a team; it never authorizes **authentication** on
its own — redemption only completes on the verified-session path below, after the visitor has
already proven their email via a magic link or (if enabled) a sign-in code.

1. \`POST /org/organisations/:orgId/teams/:teamId/invite-links\` (domain hash + access token; org or
   team \`owner\`/\`admin\` only) creates a link. Body:
   \`{ roleToAssign?: "member"|"admin", maxUses?: number (<=400, default 400), expiresInDays?: number (<=30, default 30) }\`.
   Response: \`{ token, link: { id, roleToAssign, expiresAt, maxUses, useCount, revokedAt, createdAt } }\`
   — **the plaintext \`token\` is returned exactly once**; only its hash is ever stored. Refused with a
   generic error when the team's \`joinPolicy\` is \`HIDDEN\` (invite links are not a self-serve
   backdoor around a hidden team).
2. \`GET .../invite-links\` lists a team's links (never the token itself).
   \`DELETE .../invite-links/:linkId\` revokes one — idempotent, revoking twice still returns success.
3. Share the link as \`GET /auth/team-invite-link/:token?config_url=...\`. This is a public,
   IP-rate-limited landing page — it validates the token WITHOUT redeeming it (no \`useCount\`
   increment, no membership change) and renders the normal Auth UI bootstrapped to start email
   verification. An unknown, revoked, expired, over-cap, or HIDDEN-team token all render the
   identical generic invalid-link page — there is no oracle on which condition failed.
4. Once the visitor verifies their identity and holds a \`login_token\` bridge (§4.8), the client
   calls \`POST /auth/select-team?config_url=...\` with \`{ login_token, inviteLinkToken }\` instead of
   \`teamId\`/\`inviteId\` (the three are mutually exclusive in one call). UOA re-validates the link with
   the same generic-error rule, atomically increments \`useCount\` (a conditional update guarantees
   concurrent redemptions can never push \`useCount\` past \`maxUses\`), adds the caller as an ACTIVE
   team member with the link's \`roleToAssign\` (reactivating a previously removed/deactivated row;
   idempotent if already an ACTIVE member), then finalizes exactly like a normal team selection —
   including the 2FA policy check for that org. An absent organisation membership may be created,
   but an existing inactive organisation tombstone is rejected before \`useCount\`, team-membership
   creation/reactivation, authorization, or audit mutation. The team membership may be absent,
   ACTIVE, or inactive and is created/reactivated as needed; the resulting exact organisation +
   team membership scope must be ACTIVE before handoff, or the transaction rolls back in full.

---

## Phase 5 — Server startup payload: kill switch + feature flags

Your backend can request the startup payload using the same signed config JWT trust path as \`/auth/login\` and \`/auth/register\`: pass \`config_url\`, UOA fetches the RS256 config JWT, verifies the signature, validates the payload, and checks that \`domain\` matches the \`config_url\` hostname.

\`\`\`text
GET /apps/startup?config_url=<your_config_endpoint_url>&appIdentifier=com.acme.ios&platform=ios&versionName=1.5.0&buildNumber=142
\`\`\`

Optional query params:

- \`userId\` — applies per-user flag overrides and kill-switch test targeting when the user belongs to the app's org.
- \`versionCode\` — Android numeric version code.
- \`teamId\` — exact active UOA team context for flag resolution.

Response:

\`\`\`json
{
  "killSwitch": null,
  "flags": { "dark_mode": true, "new_checkout": false },
  "cacheTtl": 300,
  "serverTime": "2026-04-22T12:00:00.000Z"
}
\`\`\`

- Unknown, inactive, or cross-domain apps return a clear startup payload: \`killSwitch: null\`, \`flags: {}\`. App matching uses the registered \`appIdentifier\` plus the config JWT domain being present in the app's registered domains.
- Feature flags return a flat key-to-boolean map. If feature flags are disabled for the App, \`flags\` is \`{}\`.
- A matched hard or maintenance kill switch appears in \`killSwitch\`; callers should block startup before loading app content.

For a backend authorization decision that must observe current state, use the
domain-hash-authenticated direct query rather than the config-only startup
payload:

\`\`\`text
GET /apps/<opaque App.id>/flags?domain=api.deepwater.live&userId=<UOA JWT sub>&teamId=<UOA Team.id>
Authorization: Bearer <hex SHA256(normalizedDomain + fullClientSecret)>
\`\`\`

\`:appId\` is the opaque database App ID returned by UOA Admin, not the bundle
identifier. The \`domain\` query is the exact config domain registered on that
App. UOA binds the active App to that domain, validates active organisation and
exact team membership for the UOA subject, and returns only a flat
\`{ "flag_key": boolean }\` map with \`Cache-Control: private, no-store\`.
Wrong/inactive app, domain, user, or team returns \`{}\` without enumeration;
missing or invalid backend credentials return 401. Security capabilities must
require an explicit \`true\`; missing flags and request failures fail closed.

---

## Validate at every step

UOA ships a production-safe validator that runs the same pipeline as the auth runtime:

\`\`\`text
POST /config/validate
Content-Type: application/json

{ "config_url": "https://api.voicepos.unlikeotherai.com/auth/config" }
\`\`\`

Body may instead be \`{ "config_jwt": "<jwt>" }\` or \`{ "config": { ... raw payload ... } }\`. Source priority is \`config\` > \`config_jwt\` > \`config_url\`.

The response includes:

- \`ok\`: every executed check passed.
- \`checks\`: per-stage results for \`source\`, \`fetch\`, \`decode\`, \`secret_scan\`, \`signature\`, \`schema\`, \`runtime_policy\`, \`domain_match\`.
- \`issues\`: structured failures with stage, code, summary, details.
- \`recommendations\`: required next steps and optional customization guidance (logo, custom font, language selector, token TTL, org features, access requests).
- \`config_summary\`: a safe parsed summary when schema validation succeeds.

In a non-production deployment with \`DEBUG_ENABLED=true\` you can additionally pass \`jwks_url\` to \`POST /config/verify\` to verify against a JWKS other than \`CONFIG_JWKS_URL\` — useful for testing a new \`kid\` before it is registered with the production UOA.

---

## Errors and what they actually mean

| Error code | Stage | Almost-always cause |
|---|---|---|
| \`CONFIG_FETCH_FAILED\` | UOA fetching your \`config_url\` | Endpoint unreachable from UOA, returned non-200, returned > 64 KiB, took > 5s, returned a body that did not contain a recognizable JWT, or resolved to a private/blocked IP. Check the **Connection Errors** page in /admin for the captured request/response context. |
| \`CONFIG_URL_NETWORK_ERROR\` | UOA fetching your \`config_url\` | TLS, DNS, or socket-level failure before HTTP could complete. |
| \`CONFIG_JWT_INVALID\` | Header / signature verification | Your \`kid\` is not registered and your payload does not include \`jwks_url\` + \`contact_email\` to trigger auto-discovery. Other causes: \`alg\` is not \`RS256\`, \`kid\` missing, signature does not match the registered public key, JWKS endpoint unreachable. |
| \`INTEGRATION_JWKS_HOST_MISMATCH\` | Auto-discovery | The hostname of the \`jwks_url\` you published in the payload does not match the \`domain\` claim (case-insensitive). Fix: host the JWKS on the same hostname. |
| \`INTEGRATION_KID_NOT_IN_JWKS\` | Auto-discovery | UOA fetched your \`jwks_url\` but the JWT's \`kid\` is not present in the document. Fix: publish the correct public JWK with the \`kid\` you signed with. |
| \`INTEGRATION_PENDING_REVIEW\` | Auto-discovery | A valid request has been captured and is waiting for a UOA superuser to approve. Wait for the email to \`contact_email\`; do not retry in a loop. |
| \`INTEGRATION_DECLINED\` | Auto-discovery | A UOA superuser declined your integration request for this domain. Contact support. |
| \`CONFIG_DOMAIN_MISMATCH\` | Post-decode | \`payload.domain\` does not exactly match the hostname of the \`config_url\` UOA fetched. Hostnames are compared case-insensitively but must otherwise be identical (no trailing dot, no port mismatch). |
| \`REDIRECT_URL_NOT_ALLOWED\` | \`/auth\` + \`/auth/token\` | \`redirect_url\` is not in \`config.redirect_urls\`. **Common cause:** the bare URL is allowlisted but a per-request \`?state=…\` (or any query parameter) was appended — matching is byte-for-byte including the query string. Carry state out-of-band (see Phase 3.1), do not mutate the URL. |
| Schema validation failures | Schema stage | A required field is missing or malformed. \`/config/validate\` returns the exact JSON path and reason in \`issues\`. |
| \`auth_failed\` (final redirect) | Post-callback | Intentionally generic. With \`allow_registration: false\`, social login does not create users — the user must already exist for that domain. Check \`/internal/admin/handshake-errors\`. |
| Google \`redirect_uri_mismatch\` | Provider | Your Google OAuth client does not list the exact callback URL UOA generated from \`PUBLIC_BASE_URL\` + \`/auth/callback/google\`. |

For deep diagnostics of failed \`/auth\` requests, a UOA superuser can open **/admin > Security > Connection Errors**. UOA records the sanitized request/response context for handshake failures, including JWT header/payload (with secrets redacted), the failing phase, and the resolved \`config_url\`.

---

## What NOT to do

- Do NOT use HS256 or any algorithm other than RS256 for the CONFIG JWT. UOA rejects everything else on the config-signing path. (Legacy authorization-code/refresh access tokens returned by \`/auth/token\` are separately HS256-signed; confidential assertion tokens are RS256 and use \`/oauth/jwks.json\` — see 4.3 and 4.6a.)
- Do NOT reuse a \`kid\` after rotation. Always pick a new \`kid\`.
- Do NOT put \`client_secret\`, \`client_hash\`, \`SHARED_SECRET\`, refresh tokens, or OAuth codes into the config JWT payload.
- Do NOT call \`/auth/token\` or \`/auth/revoke\` from the browser. The bearer is backend-only.
- Do NOT host \`config_url\` on a private DNS name, internal load balancer, loopback, or VPN-only host. UOA fetches over the public internet and rejects private IPs.
- Do NOT assume a \`200\` from your \`config_url\` in a browser implies UOA can fetch it — UOA enforces SSRF rules a browser does not.
- Do NOT replay OAuth \`code\` values from logs or chat. They are one-time credentials.
- Do NOT skip \`/config/validate\` before pointing real users at UOA.
- Do NOT append \`?state=…\` (or any per-request query) to \`redirect_url\`. The allowlist match is byte-for-byte; your \`/start\` endpoint must return the state token **separately** so the caller can stash it in \`sessionStorage\` or a first-party cookie. See Phase 3.1.
- Do NOT assume \`POST /auth/token\` returns a top-level \`user\` object. It does not. See 4.1.
- Do NOT attempt to verify a legacy authorization-code/refresh \`access_token\` against the config JWKS. It is HS256 and not RP-verifiable. A confidential assertion token is verified against \`/oauth/jwks.json\`, never the config JWKS. See 4.3 and 4.6a.
- Do NOT fall back to a synthetic tenant ID (\`"default"\`, email domain, etc.) when \`firstLogin.memberships.orgs\` is empty. See 4.5.
- Do NOT use \`claims.role\` for RP authorization. It is the UOA platform role, not your tenant role. See 4.4.

---

## Admin access

The first-party Admin UI is served from [/admin](/admin). It dogfoods the same auth system with its own first-party config:

- \`/admin/login\` redirects into \`/auth\` with PKCE.
- The admin config is served from \`/internal/admin/config\` and verified against the public JWKS at \`/.well-known/jwks.json\`.
- The admin config uses the admin domain, disables registration, and allows only Google.
- \`/admin/auth/callback\` exchanges the authorization code at \`POST /internal/admin/token\`.
- Admin access tokens are signed with \`ADMIN_ACCESS_TOKEN_SECRET\`.
- Only \`role: "superuser"\` tokens for \`ADMIN_AUTH_DOMAIN\` can access \`/internal/admin/*\`. The sole exception is the feature-flag/kill-switch/apps-list subset, which **also** accepts a scoped **Admin API key** (\`X-API-Key\`) for terminal/CI use — see "Admin API keys" below.
- \`ADMIN_AUTH_DOMAIN\` defaults to the resolved auth service identifier (inferred from \`PUBLIC_BASE_URL\` unless \`AUTH_SERVICE_IDENTIFIER\` overrides it).
- DB-backed deployments also require a \`SUPERUSER\` row in \`domain_roles\` for that admin domain.

---

## Operational endpoints

- \`GET /domain/users\` — list users for a domain.
- \`GET /domain/logs\` — domain login logs.
- \`GET /org/me\` — current user's org context.
- \`POST /email/send\` — send a transactional email for a configured domain. Supply \`X-UOA-Config-JWT: <signed config JWT>\`; UOA verifies the RS256 config JWT directly from the header, requires the domain email config to be enabled and SES verification/DKIM to both be \`Success\`, then sends \`{ to, subject, text, html?, reply_to? }\`.
- \`GET /internal/admin/handshake-errors\` — sanitized handshake and config JWT errors for superusers, including redacted request/response context when \`config_url\` fetches fail before a JWT can be decoded.
- \`PUT /internal/admin/domains/:domain\`, \`PATCH /internal/admin/organisations/:orgId\`, and \`PATCH /internal/admin/organisations/:orgId/teams/:teamId\` — admin-only login access whitelist writes. The team route also accepts \`name\` and \`description\` for team edits. Send only the fields to change; omitted fields remain unchanged.
- \`POST /internal/admin/organisations\` — admin-only organisation creation for an existing owner user; creates the default \`General\` team and may set \`allowed_email_domains\` / \`allowed_emails\`.
- \`POST /internal/admin/apps\` — admin-only app registration used by feature flags and \`/apps/startup\`. Superuser JWT only — an Admin API key cannot create apps.
- \`GET /internal/admin/apps\` — list registered apps with their feature flag definitions and kill-switch rules. Superuser JWT **or** an Admin API key (\`X-API-Key\`). This is the discovery call a terminal/CI user makes to find the \`appId\`/\`flagId\`/\`killSwitchId\`.
- \`POST/PATCH/DELETE /internal/admin/apps/:appId/flags\` and \`/kill-switches\` — feature flag definitions and version kill-switch rules. Superuser JWT **or** an Admin API key (\`X-API-Key\`).
- \`GET/POST/DELETE /internal/admin/api-keys\` — mint, list, and revoke Admin API keys. **Superuser JWT only** (key management is the escalation boundary; an Admin API key can never reach these).

---

## Admin API keys — control feature flags & kill switches from a terminal

Feature flags and kill switches are normally written through the Admin UI with a short-lived superuser browser token, so there is no way to flip one from a script or CI job. An **Admin API key** closes that gap.

A superuser mints a key in the Admin panel (**API Keys** page). It is shown **once** — copy it immediately. The key:

- looks like \`uoa_ak_<random>\` and is sent as \`X-API-Key: <key>\` (or \`Authorization: Bearer uoa_ak_…\`),
- can do **exactly** three things: list apps, write feature flags, and write kill switches,
- **cannot** mint/list/revoke keys or reach any other \`/internal/admin/*\` route (users, orgs, domains, dashboard, settings, logs, search). Those stay superuser-JWT-only.

When an \`X-API-Key\`/\`Bearer uoa_ak_…\` credential is present it is authoritative: a bad, expired, or revoked key returns a generic \`401\` and is **not** retried as a JWT. Only requests with no API-key credential fall through to the superuser browser-token path, so the Admin UI is unaffected.

### Terminal recipe

\`\`\`bash
UOA=https://authentication.unlikeotherai.com
KEY=uoa_ak_your_key_minted_in_the_admin_panel

# 1. Discover the app — find its appId, flag ids, and kill-switch ids.
curl -fsS -H "X-API-Key: $KEY" "$UOA/internal/admin/apps"
# => [ { "id": "app_…", "identifier": "com.acme.ios", "flags": 1, "flagDefinitions": [ { "id": "flag_…", "key": "new_checkout" } ], "killSwitches": [ … ] }, … ]

APP=app_…

# 2. Create a feature flag definition (default OFF).
curl -fsS -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \\
  -d '{ "key": "new_checkout", "description": "New checkout flow", "default_state": false }' \\
  "$UOA/internal/admin/apps/$APP/flags"

# 2b. Toggle it ON later (PATCH the returned flagId).
curl -fsS -X PATCH -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \\
  -d '{ "key": "new_checkout", "default_state": true }' \\
  "$UOA/internal/admin/apps/$APP/flags/flag_…"

# 3. Flip a kill switch — block versions < 1.5.0 with a hard stop.
curl -fsS -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \\
  -d '{ "platform": "both", "type": "hard", "version_field": "versionName",
        "operator": "lt", "version_value": "1.5.0", "version_scheme": "semver",
        "active": true, "priority": 100 }' \\
  "$UOA/internal/admin/apps/$APP/kill-switches"
\`\`\`

The result is visible immediately to clients calling \`GET /apps/startup\`. See [/api](/api) for the full request/response schema of each route (flag and kill-switch bodies, the apps-list shape, and the superuser-only \`/internal/admin/api-keys\` management routes).

---

## Public-client / MCP OAuth profile (\`/oauth/*\`, brief §22.14)

A second, opt-in profile for **standards public clients** (e.g. MCP clients) that have
no \`config_url\` and no shared secret. Disabled unless
\`MCP_OAUTH_PUBLIC_PROFILE_ENABLED=true\` **and** the signing key and dedicated
\`MCP_OAUTH_DOMAIN\` are configured (routes 404 otherwise). Signing-key presence
alone publishes \`/oauth/jwks.json\` for confidential resource-token verification
and never opens public registration/login/token routes. It does not change the
config-JWT flow above.

- \`GET /.well-known/oauth-authorization-server\` — RFC 8414 metadata (discover the endpoints below).
- \`POST /oauth/register\` — RFC 7591 dynamic registration. PUBLIC clients only: send
  \`redirect_uris\` (https / loopback http / native scheme), get a \`client_id\`, **no secret**.
- \`GET /oauth/authorize?response_type=code&client_id=&redirect_uri=&code_challenge=&code_challenge_method=S256&state=&resource=\`
  — renders the first-party login UI; on success redirects to \`redirect_uri?code=&state=\`.
- \`POST /oauth/token\` — PKCE exchange (\`code\`, \`redirect_uri\`, \`code_verifier\`, \`client_id\`),
  **no client secret**. Returns a resource-bound **RS256** access token (\`aud\` = the requested \`resource\`).
- \`GET /oauth/jwks.json\` — verify those access tokens here (separate from the config JWKS).

Standard OAuth 2.1 + PKCE authorization-code flow; resource servers validate the token
statelessly via \`/oauth/jwks.json\` with issuer + audience checks.

---

Use [/api](/api) for the complete JSON endpoint schema and the canonical \`config_jwt\` field contract.
`;
