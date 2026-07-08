export const llmIntegrationMarkdown = `---

## Phase 4 — Backend token exchange

This call is server-to-server. The browser MUST never see the bearer token.

\`\`\`text
POST /auth/token?config_url=<your_config_endpoint_url>
Authorization: Bearer <client_hash from Phase 1>
Content-Type: application/json

{
  "code": "<authorization_code>",
  "redirect_url": "<same callback URL used in Phase 3>",
  "code_verifier": "<the PKCE verifier whose SHA-256 produced code_challenge>"
}
\`\`\`

### 4.1 Canonical response body

The authorization-code grant returns exactly the shape below. **There is no top-level \`user\` field.** User identity is carried as claims inside \`access_token\`. If your RP code reads \`response.user.id\` you will always get \`undefined\` — decode the JWT and read \`sub\` instead.

\`\`\`json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.<payload>.<sig>",
  "expires_in": 1800,
  "refresh_token": "<opaque, server-side only>",
  "refresh_token_expires_in": 2592000,
  "token_type": "Bearer",
  "firstLogin": {
    "memberships": {
      "orgs":  [{ "orgId": "org_…", "role": "member" }],
      "teams": [{ "teamId": "tm_…", "orgId": "org_…", "role": "member" }]
    },
    "pending_invites": [
      { "inviteId": "inv_…", "type": "team", "orgId": "org_…", "teamId": "tm_…", "teamName": "…" }
    ],
    "capabilities": { "can_create_org": false, "can_accept_invite": true }
  }
}
\`\`\`

Store the refresh token server-side ONLY; browser clients never receive or persist refresh tokens. \`firstLogin\` is only present on the authorization-code grant; refresh-token grants never include it.

**Field-casing warning.** The outer envelope is snake_case (\`access_token\`, \`refresh_token\`, \`expires_in\`, \`refresh_token_expires_in\`). The key \`firstLogin\` itself and the IDs inside \`memberships.*\` and \`pending_invites[]\` (\`orgId\`, \`teamId\`, \`inviteId\`, \`teamName\`) are camelCase. \`pending_invites\` and \`capabilities.can_*\` are snake_case. Do not assume one style throughout.

### 4.2 Access-token JWT claims

The \`access_token\` is a JWT (compact JWS, three base64url segments). Decode the payload — no signature verification on the RP side (see the trust-model note below).

| Claim | Source | Meaning |
|---|---|---|
| \`sub\` | standard | **Stable external user id.** Use this as the RP's foreign key into the UOA user. |
| \`email\` | custom | User's primary email. Advisory — user may change it; \`sub\` is the stable identity. |
| \`role\` | custom | **Platform-side UOA role** — \`"user"\` or \`"superuser"\`. Do NOT use this for tenant/org authorization. See 4.4. |
| \`domain\` | custom | The integration domain from your config JWT. Confirms which integration minted this token. |
| \`client_id\` | custom | \`SHA256(domain + clientSecret)\` hex. Identifies the exact client credential used. |
| \`org\` | custom (optional) | Present only when \`org_features.enabled\` and the user has an org on this domain. Shape: \`{ org_id, org_role, teams[], team_roles{}, groups?[], group_admin?[] }\`. |
| \`iss\` | standard | UOA host, e.g. \`authentication.unlikeotherai.com\`. |
| \`aud\` | standard | Always \`"uoa:access-token"\`. |
| \`iat\`, \`exp\` | standard | Epoch seconds. Respect \`exp\`. |

Minimal decode (no verification):

\`\`\`ts
import { decodeJwt } from 'jose';
const claims = decodeJwt(response.access_token);
const userId = claims.sub;                 // stable
const email = claims.email as string;      // advisory
const platformRole = claims.role as 'user' | 'superuser';
\`\`\`

### 4.3 Trust model — access tokens are HS256-signed

Access tokens are signed with \`HS256\` using the deployment-wide \`SHARED_SECRET\`. **RPs cannot and should not cryptographically verify them.** The config JWKS at \`/.well-known/jwks.json\` is for verifying RS256 *config* JWTs, not access tokens, and there is no UOA-side public JWKS for access tokens.

The RP trust model is channel-based:

1. You received the \`access_token\` as the body of an HTTPS response to your backend's \`POST /auth/token\` call.
2. That call was authenticated with your per-domain \`client_hash\` bearer, which only UOA and your backend know.
3. You passed \`code\` + \`code_verifier\` (PKCE) that only your tab could have produced.

Because all three hold, the token's issuer is UOA by construction. Do not expose \`access_token\` to the browser; do not forward it to third parties; and treat it as opaque beyond decoding claims for user identity / expiry. When you need to validate a presented access token later, call UOA (e.g. use it in the \`X-UOA-Access-Token\` header against UOA's own endpoints such as \`GET /org/me\`) rather than attempting local verification.

### 4.4 Which role to honour for authorization

The JWT \`role\` claim (\`"user"\` | \`"superuser"\`) is the **UOA platform role** — it gates access to UOA's own admin surfaces, NOT to the RP's business features. It is almost never the right role for RP authorization decisions.

Use this precedence inside your RP:

1. **Per-tenant role:** \`firstLogin.memberships.orgs[].role\` (on first login) — subsequently, fetch the current role via \`GET /org/me\`. This is what your RP should honour for org-scoped authorization.
2. **Per-team role:** \`firstLogin.memberships.teams[].role\`.
3. **Platform role (\`claims.role\`):** only relevant if the RP itself is a UOA-internal admin surface. Treat unknown values as \`"user"\`.

\`superuser\` in the JWT does NOT mean the user is an admin *inside your product*; it only means they can use UOA's admin UI.

### 4.5 First-login tenant bootstrapping — empty memberships

When \`firstLogin.memberships.orgs\` is empty, the user is authenticated but has no tenant on this domain yet. Do NOT fall back to a synthetic tenant (\`"default"\`, the user's email domain, etc.) — you will cross-contaminate users. Branch on \`capabilities\`:

| \`capabilities.can_create_org\` | \`capabilities.can_accept_invite\` | RP action |
|---|---|---|
| \`true\` | any | Show "Create your organisation" UI. Your backend calls \`POST /org/organisations?domain=<d>&config_url=<u>\` with domain-hash auth **and the user's \`X-UOA-Access-Token\` header**; the body is \`{ name }\` only — the new org is owned by that token's user (there is no \`owner_id\` in the body). After success, re-issue the session and re-fetch \`GET /org/me\`. |
| \`false\` | \`true\` | User has a pending invite. Show "Accept invitation" UI; the invite link is delivered by email from UOA — or you can resolve it yourself via \`firstLogin.pending_invites[0]\`. |
| \`false\` | \`false\` | No tenant and no path to one. Reject the login with a "Contact your administrator" screen — do NOT silently grant access. Your UOA superuser must provision the org/team. |

The server-side behaviour controlling whether the first-login payload is already non-empty is set in the config JWT — see \`registration_domain_mapping\`, \`org_features.auto_create_personal_org_on_first_login\`, and \`org_features.pending_invites_block_auto_create\` at \`/api\`.

### 4.6 Reference implementation — authorization code → RP session

\`\`\`ts
import { decodeJwt } from 'jose';

const res = await fetch(
  \`\${UOA}/auth/token?config_url=\${encodeURIComponent(CONFIG_URL)}\`,
  {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${CLIENT_HASH}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      code,
      redirect_url: redirectUrl,
      code_verifier: codeVerifier,
    }),
  },
);
if (!res.ok) throw new Error('UOA token exchange failed');
const body = await res.json() as {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
  token_type: 'Bearer';
  firstLogin?: {
    memberships: { orgs: Array<{ orgId: string; role: string }>; teams: Array<{ teamId: string; orgId: string; role: string }> };
    pending_invites: Array<{ inviteId: string; type: 'team'; orgId: string; teamId: string; teamName: string }>;
    capabilities: { can_create_org: boolean; can_accept_invite: boolean };
  };
};

const claims = decodeJwt(body.access_token);
const externalUserId = claims.sub!;                // stable user id
const email = String(claims.email);                // advisory

const firstOrg = body.firstLogin?.memberships.orgs[0];
if (!firstOrg) {
  if (body.firstLogin?.capabilities.can_create_org) return redirectToCreateOrg();
  if (body.firstLogin?.capabilities.can_accept_invite) return redirectToAcceptInvite();
  return redirectToContactAdmin();
}
const tenantId = firstOrg.orgId;
const tenantRole = firstOrg.role;                  // use THIS for authz, not claims.role

await storeRefreshTokenServerSide(body.refresh_token, body.refresh_token_expires_in);
await issueRpSession({ externalUserId, email, tenantId, tenantRole });
\`\`\`

Server-side behaviour on first verified login is controlled by \`org_features\`:

- \`registration_domain_mapping\` (top-level config) places the user into a configured org + team when the email domain matches.
- \`auto_create_personal_org_on_first_login\` (default \`false\`) creates a personal org with the user as \`owner\` plus a default team when no mapping matches. Skipped when \`pending_invites_block_auto_create\` is \`true\` and a pending invite exists for the email.
- \`allow_user_create_org\` (default \`false\`) gates \`POST /org/organisations\` for end-users. Superusers bypass. Keep \`false\` for admin-provisioned tenants.

### 4.7 Organisation member lifecycle — deactivate, reactivate, soft-remove

Membership rows carry a \`status\`: \`ACTIVE\` | \`DEACTIVATED\` | \`REMOVED\`. Deactivation suspends access without deleting history (Slack's "deactivate", not "kick"); removal is a tombstone, not a hard delete, so audit history survives.

- \`POST /org/organisations/:orgId/members/:userId/deactivate\` — suspends the member: their org and team rows move to \`DEACTIVATED\`, and their refresh-token sessions **on this domain only** are revoked (their sessions on other domains, if any, are untouched — a user belongs to at most one org per domain, so domain-scoped revocation is exactly org-scoped revocation). Cannot deactivate an \`owner\` — transfer ownership first. The user disappears from \`GET /org/organisations/:orgId/members\` (default view) and from \`firstLogin\`/\`GET /org/me\` on their next token refresh.
- \`POST /org/organisations/:orgId/members/:userId/reactivate\` — flips a \`DEACTIVATED\` member back to \`ACTIVE\`. No sessions are restored; the user simply signs in again.
- \`DELETE /org/organisations/:orgId/members/:userId\` — now a soft-remove: status becomes \`REMOVED\` (not a row delete) and the domain-scoped session revocation above applies. Re-adding a previously removed user via \`POST /org/organisations/:orgId/members\` **reactivates** their existing row (and re-activates their default-team membership) instead of rejecting with "already a member".
- \`GET /org/organisations/:orgId/members\` defaults to \`ACTIVE\` members only. Pass \`?status=DEACTIVATED\`, \`?status=REMOVED\`, or \`?status=all\` to see other lifecycle states (e.g. for an admin roster view that lists suspended/removed accounts).

To revoke on logout:

\`\`\`text
POST /auth/revoke?config_url=<your_config_endpoint_url>
Authorization: Bearer <client_hash>
Content-Type: application/json

{ "refresh_token": "<refresh token to revoke>" }
\`\`\`

This revokes the refresh-token family AND invalidates the user's already-issued access tokens (their \`tv\` claim no longer matches the bumped per-user token version), so logout takes effect immediately rather than waiting for access-token expiry. The same access-token revocation applies on password reset and 2FA reset.

Domain admin APIs (\`/domain/users\`, \`/domain/logs\`, etc.) and team-invite / access-request review APIs use the same \`Authorization: Bearer <client_hash>\` mechanism. The old global shared-secret bearer is NOT accepted for any customer-facing endpoint.

### 4.7a Team join policies + member-initiated invites (Phase 4)

Every \`Team\` has a \`joinPolicy\`: \`INVITE_ONLY\` (default) | \`APPROVED_DOMAIN\` | \`REQUEST_TO_JOIN\` | \`OPEN_TO_ORG\` | \`HIDDEN\`. The policy **gates** the existing join mechanisms rather than replacing them:

- **Auto-enrolment** via \`access_requests.auto_grant_domains\` only auto-adds a user when the configured target team's \`joinPolicy\` is \`APPROVED_DOMAIN\`.
- **Request-to-join** (\`access_requests.enabled\`) only accepts a request when the target team's \`joinPolicy\` is \`REQUEST_TO_JOIN\`; any other policy fails the login with a generic error when \`request_access=true\` is set.
- **Self-join** — \`POST /org/organisations/:orgId/teams/:teamId/join\` (access token required) — succeeds only when the team's \`joinPolicy\` is \`OPEN_TO_ORG\` and the caller is an ACTIVE member of the team's org. Reactivates a previously removed/deactivated row instead of duplicating it.
- **HIDDEN** teams are excluded from \`GET /org/organisations/:orgId/teams\` for callers who are not already an ACTIVE member of that team.
- Set the policy with \`PUT /org/organisations/:orgId/teams/:teamId\` (\`{ "joinPolicy": "OPEN_TO_ORG" }\`, owner/admin only).

Team invites now carry an \`expiresAt\` (30 days from send/resend — resending refreshes it) and an \`approvalStatus\`: \`not_required\` | \`pending\` | \`approved\` | \`denied\`. The derived invite \`status\` gains \`expired\` alongside \`pending | accepted | declined | replaced\`; an expired or not-yet-approved invite cannot be accepted and is excluded from the workspace chooser / \`firstLogin.pending_invites\`.

Member-initiated invites: \`POST /org/organisations/:orgId/teams/:teamId/invitations\` accepts the same path used by the trusted backend bulk-invite call, but when called WITH an \`X-UOA-Access-Token\` header it becomes a single-invite, permission-gated call instead:

- Org or team \`owner\`/\`admin\`: always allowed, sent immediately (\`approvalStatus: not_required\`).
- A plain ACTIVE team member: gated by the organisation's \`memberInvites\` setting (\`allowed\` default | \`admin_approval\` | \`disabled\`, set via \`PUT /org/organisations/:orgId\` \`{ "member_invites": "admin_approval" }\`). \`admin_approval\` creates the invite as \`pending\` and sends **no email** until an owner/admin approves it.
- A deactivated member, or a plain member when \`disabled\`, is rejected generically.
- The response is always \`{ "status": "ok" }\` regardless of outcome — whether the email already has an account is never revealed (no enumeration).

Owner/admin review the pending queue with \`GET /org/organisations/:orgId/invitations?approval=pending\`, then \`POST /org/organisations/:orgId/invitations/:inviteId/approve\` (sends the invite email) or \`.../deny\` (silent to the invitee, sends nothing).

### 4.7 Two-factor login branches

When config \`2fa_enabled\` is false or absent, no 2FA branch runs. When it is true, UOA resolves DB policy from the Service/domain plus the user's Organisations using strongest-wins (\`off < optional < required\`).

- Enrolled users get \`{ ok: true, twofa_required: true, twofa_token }\`; submit \`{ twofa_token, code }\` to \`POST /2fa/verify?config_url=...\` and follow \`redirect_to\`.
- Required but unenrolled users get \`{ ok: true, kind: "twofa_enroll_required", twofa_enroll_required: true, setup_token, otpauth_uri?, qr_svg?, manual_secret? }\`; the Auth UI completes \`POST /2fa/enroll\` with the setup token and initial code before any authorization code is granted.
- Optional and unenrolled users continue normally.

For account settings, an authenticated user can call \`POST /2fa/setup\` with \`X-UOA-Access-Token\`, enroll with \`POST /2fa/enroll\`, and disable with \`POST /2fa/disable\` plus a current TOTP code. Disable is rejected generically when the effective policy is required.

---

## Phase 4.8 — Slack-style email sign-in codes + workspace selection (opt-in)

Additive on top of \`/auth/register\` and \`/auth/login\` — everything below is gated by config
\`login_flow\` and changes NOTHING when left at its defaults:

\`\`\`jsonc
"login_flow": {
  "email_code_enabled": false,      // offer a 6-digit sign-in code alongside the magic link
  "workspace_selection": "off"      // "off" | "auto" — "auto" shows a workspace chooser after
                                     // identity verification when the user has any teams or invites
}
\`\`\`

**Security note (read before enabling):** workspace names, team membership, and pending invites are
revealed ONLY after the user's identity has been verified (a valid sign-in code or magic link) —
never from \`/auth/start\`, which always returns the same generic message regardless of whether the
email exists. The \`login_token\` bridge issued by \`/auth/verify-code\` (and, when the chooser is on,
by \`/auth/login\`) authorizes ONLY \`POST /auth/select-team\` for that verified user — it is a distinct
token class from \`access_token\` and \`twofa_token\` and cannot be used for anything else.

1. \`POST /auth/start?config_url=...\` — body \`{ email }\`. Same generic response as
   \`/auth/register\`; when \`email_code_enabled\` is true it additionally emails a 6-digit code.
2. \`POST /auth/verify-code?config_url=...\` — body \`{ email, code }\`. IP + email rate-limited; wrong
   code, expired code, no code, and a dead (5-attempt) code all return the identical generic auth
   error. On success:
   - \`workspace_selection: "auto"\` → \`{ login_token, teams: [{ teamId, orgId, name, role }], pending_invites: [{ inviteId, teamName, invitedBy }], can_create_org }\`.
   - \`workspace_selection: "off"\` (default) → finalizes immediately, same response shape as
     \`/auth/login\` (\`{ ok, code, redirect_to }\`, or a \`twofa_token\`/\`twofa_enroll_required\` branch —
     2FA still applies, only the chooser step is skipped).
3. \`POST /auth/select-team?config_url=...\` — body \`{ login_token, teamId }\` (or
   \`{ login_token, inviteId, action: "accept" | "decline" }\`). Validates the bridge token, that the
   team belongs to an org on this domain, and that the user holds an ACTIVE membership on it (a team
   on another domain, or one the user isn't an ACTIVE member of, is rejected exactly like an invalid
   token — no IDOR oracle). Enforces the selected org's 2FA policy, then finalizes with the resolved
   workspace scope: the returned \`code\` carries \`orgId\`/\`teamId\`, so the eventual \`POST /auth/token\`
   exchange's access token includes the \`active: { orgId, teamId }\` claim (§4.2) next to the existing
   \`org\` claim.
4. \`POST /auth/login\` (password) also routes into the chooser when \`workspace_selection: "auto"\` and
   2FA is already satisfied: it returns \`{ login_token, teams, pending_invites, can_create_org }\`
   instead of finalizing directly, and the client then calls \`/auth/select-team\`. With the default
   \`"off"\`, \`/auth/login\` is completely unchanged.
5. Social login (\`GET /auth/callback/:provider\`) also routes into the chooser when
   \`workspace_selection: "auto"\`, 2FA is already satisfied, and the user has 2+ ACTIVE teams or a
   pending invite (single-team/no-invite users redirect straight to the code, matching the
   client-side auto-skip rule). As a GET redirect it can't inline the chooser JSON, so it mints the
   same \`login_token\` bridge and redirects to \`/auth?config_url=...&redirect_url=...&login_token=...&flow=workspace_chooser\`.
   The Auth UI then calls \`POST /auth/session-choices?config_url=...\` \`{ login_token }\` to hydrate
   \`{ teams, pending_invites, can_create_org }\` — generic rejection for an invalid/expired token, no
   enumeration.

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
   including the 2FA policy check for that org.

---

## Phase 5 — Server startup payload: kill switch + feature flags

Your backend can request the startup payload using the same signed config JWT trust path as \`/auth/login\` and \`/auth/register\`: pass \`config_url\`, UOA fetches the RS256 config JWT, verifies the signature, validates the payload, and checks that \`domain\` matches the \`config_url\` hostname.

\`\`\`text
GET /apps/startup?config_url=<your_config_endpoint_url>&appIdentifier=com.acme.ios&platform=ios&versionName=1.5.0&buildNumber=142
\`\`\`

Optional query params:

- \`userId\` — applies per-user flag overrides and kill-switch test targeting when the user belongs to the app's org.
- \`versionCode\` — Android numeric version code.
- \`teamId\` — reserved for multi-team flag resolution.

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

- Do NOT use HS256 or any algorithm other than RS256 for the CONFIG JWT. UOA rejects everything else on the config-signing path. (Access tokens returned by \`/auth/token\` are separately HS256-signed by UOA and are not your concern — see 4.3.)
- Do NOT reuse a \`kid\` after rotation. Always pick a new \`kid\`.
- Do NOT put \`client_secret\`, \`client_hash\`, \`SHARED_SECRET\`, refresh tokens, or OAuth codes into the config JWT payload.
- Do NOT call \`/auth/token\` or \`/auth/revoke\` from the browser. The bearer is backend-only.
- Do NOT host \`config_url\` on a private DNS name, internal load balancer, loopback, or VPN-only host. UOA fetches over the public internet and rejects private IPs.
- Do NOT assume a \`200\` from your \`config_url\` in a browser implies UOA can fetch it — UOA enforces SSRF rules a browser does not.
- Do NOT replay OAuth \`code\` values from logs or chat. They are one-time credentials.
- Do NOT skip \`/config/validate\` before pointing real users at UOA.
- Do NOT append \`?state=…\` (or any per-request query) to \`redirect_url\`. The allowlist match is byte-for-byte; your \`/start\` endpoint must return the state token **separately** so the caller can stash it in \`sessionStorage\` or a first-party cookie. See Phase 3.1.
- Do NOT assume \`POST /auth/token\` returns a top-level \`user\` object. It does not. See 4.1.
- Do NOT attempt to verify \`access_token\` against the config JWKS. It is HS256 and not RP-verifiable. See 4.3.
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
- \`PUT /internal/admin/domains/:domain\`, \`PATCH /internal/admin/organisations/:orgId\`, and \`PATCH /internal/admin/organisations/:orgId/teams/:teamId\` — admin-only login access whitelist writes. Send \`allowed_email_domains\` and/or \`allowed_emails\`; omitted lists remain unchanged.
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
no \`config_url\` and no shared secret. Disabled unless \`MCP_OAUTH_ACCESS_TOKEN_PRIVATE_JWK\`
is set (routes 404 otherwise). It does not change the config-JWT flow above.

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

Use [/api](/api) for the complete JSON endpoint schema and the canonical \`config_jwt\` field contract.`;
