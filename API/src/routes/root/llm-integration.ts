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

If optional agreement signatures are enabled for the domain, a newly published version or revoked signature can make the next refresh return the normal authentication failure. UOA deliberately leaves that still-valid refresh token unconsumed and unrotated; restart the interactive authorization flow so the authenticated user can review/sign the current version. Do not retry refresh in a loop.

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

### 4.7b Sidebar workspace stack, "Invited" tab, and workspace icons (gap-fix A, design §11.3–§11.5)

\`GET /org/me\` now returns two additive fields inside \`org\` alongside the existing \`org_id\`,
\`org_role\`, \`teams\`, \`team_roles\`, \`groups\` (unchanged — this is purely additive):

\`\`\`json
{
  "org": {
    "org_id": "org_…",
    "org_role": "admin",
    "teams": ["team_1", "team_2"],
    "team_roles": { "team_1": "owner", "team_2": "member" },
    "workspaces": [
      {
        "teamId": "team_1",
        "orgId": "org_…",
        "name": "Backend Team",
        "slug": "backend-team",
        "orgName": "Acme Inc",
        "iconUrl": "https://cdn.example.com/backend.png",
        "role": "owner",
        "lastLoginAt": "2026-07-01T12:00:00.000Z"
      },
      {
        "teamId": "team_2",
        "orgId": "org_…",
        "name": "Design",
        "slug": "design",
        "orgName": "Acme Inc",
        "iconUrl": null,
        "role": "member",
        "lastLoginAt": null
      }
    ],
    "pending_invites": [
      { "inviteId": "inv_…", "teamId": "team_3", "teamName": "Growth", "invitedBy": "Alice Admin", "expiresAt": "2026-08-01T00:00:00.000Z" }
    ]
  }
}
\`\`\`

- \`workspaces[]\` — one entry per ACTIVE team membership on this domain, ordered \`lastLoginAt\` DESC
  with nulls last, then \`name\` ASC (this IS the sidebar order — render it as-is). \`lastLoginAt\` is
  \`null\` when the caller never opened a session scoped to that specific workspace (e.g. a
  pre-chooser session, or a workspace never actually signed into).
- \`pending_invites[]\` — the caller's own pending invites on this domain (same eligibility as the
  workspace chooser: unaccepted/undeclined/unrevoked, not expired, and not still awaiting
  member-invite approval).
- Render this straight into the Slack-style sidebar: active workspace highlighted (match
  \`active.teamId\` from the access-token claim, §4.2), the rest one click away via \`team_hint\` on
  \`/auth\`, invite cards for \`pending_invites\`.

**"Invited" tab** — \`GET /org/organisations/:orgId/teams/:teamId?include=invited\` (exact literal;
any other value for \`include\` is ignored, same as omitting it):

\`\`\`json
{
  "id": "team_1",
  "name": "Backend Team",
  "slug": "backend-team",
  "iconUrl": "https://cdn.example.com/backend.png",
  "members": [ { "userId": "user_…", "teamRole": "owner" } ],
  "invited": [
    {
      "inviteId": "inv_…",
      "email": "new.hire@acme.com",
      "inviteName": "New Hire",
      "teamRole": "member",
      "invitedByName": "Alice Admin",
      "invitedByEmail": "alice@acme.com",
      "lastSentAt": "2026-07-05T00:00:00.000Z",
      "expiresAt": "2026-08-04T00:00:00.000Z",
      "approvalStatus": "pending",
      "openCount": 0
    }
  ]
}
\`\`\`

- Without \`?include=invited\`, the response is byte-identical to before — no \`invited\` key at all.
- With it, \`invited\` is **always present** as an array. Unlike every other pending-invite surface,
  it INCLUDES \`approvalStatus: "pending"\` entries (an admin reviewing the tab must see invites still
  awaiting member-invite approval, §4.7a) — the field itself tells you which.
- \`invited\` is gated to an org **or** team \`owner\`/\`admin\` (invite emails are PII): a plain member
  gets \`invited: []\`, never a \`403\` — the rest of the team read is unaffected either way.

**Workspace icons** (design §11.3) — \`Team.iconUrl\` / \`Organisation.iconUrl\`, external URL only, no
local storage (brief §15). Set with the existing \`PUT\` endpoints:

\`\`\`jsonc
PUT /org/organisations/:orgId/teams/:teamId
{ "icon_url": "https://cdn.example.com/backend.png" }   // or "icon_url": null to clear
\`\`\`

Same body/response shape for \`PUT /org/organisations/:orgId\`. Rules, identical for both:

- \`icon_url\` omitted → unchanged. \`null\` → clears it. Otherwise must be an \`https:\` URL, max 2048
  characters — anything else (\`http:\`, a bare string, oversized) is rejected with the same generic
  \`400\` UOA uses everywhere else (no "must be https" specificity leaked back).
- Owner/admin only — the same authorization the \`PUT\` already enforced.
- \`iconUrl\` is echoed on every team/org read and write, the workspace chooser's \`teams[]\`, \`/org/me\`'s
  \`workspaces[]\`, and \`firstLogin.memberships.teams[]\` — one column, one field name, everywhere.


### 4.7 Two-factor login branches

When config \`2fa_enabled\` is false or absent, no 2FA branch runs. When it is true, UOA resolves DB policy from the Service/domain plus the user's Organisations using strongest-wins (\`off < optional < required\`).

- Enrolled users get \`{ ok: true, twofa_required: true, twofa_token }\`; submit \`{ twofa_token, code }\` to \`POST /2fa/verify?config_url=...\` and follow \`redirect_to\`.
- Required but unenrolled users get \`{ ok: true, kind: "twofa_enroll_required", twofa_enroll_required: true, setup_token, otpauth_uri?, qr_svg?, manual_secret? }\`; the Auth UI completes \`POST /2fa/enroll\` with the setup token and initial code before any authorization code is granted.
- Optional and unenrolled users continue normally.

For account settings, an authenticated user can call \`POST /2fa/setup\` with \`X-UOA-Access-Token\`, enroll with \`POST /2fa/enroll\`, and disable with \`POST /2fa/disable\` plus a current TOTP code. Disable is rejected generically when the effective policy is required.

---
`;
