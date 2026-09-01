import { llmBackendModeMarkdown } from './llm-integration-backend-mode.js';
import { llmTeamsInvitationsMarkdown } from './llm-integration-teams.js';

export const llmIntegrationMarkdown = `---

## Phase 4 — Backend token exchange

Sections 4.1–4.7 describe the legacy authorization-code / refresh-token profile.
Section 4.6a documents the separate confidential JWT assertion grant and its
resource-verifiable RS256 token.

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
Presenting an already-rotated token is treated as theft/replay: UOA durably revokes the complete
family before returning the normal authentication failure, so the current replacement cannot be
used afterward. Replace stored refresh state atomically and never retry an older token.
Refresh, logout, and global credential recovery are serialized per user. When logout or a password/
2FA recovery returns, no concurrent refresh replacement or access token can have escaped it.

If optional agreement signatures are enabled for the domain, a newly published version or revoked signature can make the next refresh return the normal authentication failure. UOA deliberately leaves that still-valid refresh token unconsumed and unrotated; restart the interactive authorization flow so the authenticated user can review/sign the current version. Do not retry refresh in a loop.

If UOA rotated the refresh token but its successful response was lost, retry the
same predecessor within 120 seconds using the same application credential and
exact config/client context. UOA returns the one already-created current
successor (and its actual remaining lifetime) instead of rotating again.
Concurrent retries converge on that same value. After 120 seconds, predecessor
reuse is theft detection: UOA revokes the family and increments the user's
access-token version. Persist a successful UOA successor and access-token state
atomically. If only your own downstream response was lost after that local
commit, replay the locally persisted result rather than calling UOA again.

**Field-casing warning.** The outer envelope is snake_case (\`access_token\`, \`refresh_token\`, \`expires_in\`, \`refresh_token_expires_in\`). The key \`firstLogin\` itself and the IDs inside \`memberships.*\` and \`pending_invites[]\` (\`orgId\`, \`teamId\`, \`inviteId\`, \`teamName\`) are camelCase. \`pending_invites\` and \`capabilities.can_*\` are snake_case. Do not assume one style throughout.

### 4.2 Legacy access-token JWT claims

The \`access_token\` is a JWT (compact JWS, three base64url segments). Decode the payload — no signature verification on the RP side (see the trust-model note below).

| Claim | Source | Meaning |
|---|---|---|
| \`sub\` | standard | **Stable external user id.** Use this as the RP's foreign key into the UOA user. |
| \`email\` | custom | User's primary email. Advisory — user may change it; \`sub\` is the stable identity. |
| \`role\` | custom | **Platform-side UOA role** — \`"user"\` or \`"superuser"\`. Do NOT use this for tenant/org authorization. See 4.4. |
| \`domain\` | custom | The integration domain from your config JWT. Confirms which integration minted this token. |
| \`client_id\` | custom | \`SHA256(domain + clientSecret)\` hex. Identifies the exact client credential used. |
| \`org\` | custom (optional) | Present only when \`org_features.enabled\` and the user has an org on this domain. Shape: \`{ org_id, tenant_slug, org_role, teams[], team_roles{}, groups?[], group_admin?[] }\`. |
| \`active.tenantSlug\` | custom (optional) | Canonical DNS-safe subdomain label for the selected workspace. It is sourced from the organisation slug and unique within this client domain. Treat its absence as a legacy-token compatibility case; never use \`Team.slug\` as a tenant host key. |
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
const tenantSlug = (claims.active as { tenantSlug?: string } | undefined)?.tenantSlug;
\`\`\`

### 4.3 Legacy trust model — authorization-code / refresh tokens are HS256-signed

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

### 4.4a Roles are the domain's words; do not hard-code them

The org and team role **vocabularies are per-domain configuration**
(\`org_features.org_roles\` and \`org_features.team_roles\`, both defaulting to
\`["owner","admin","member"]\` and both required to contain \`"owner"\`). A domain may name
\`auditor\`, \`editor\`, \`reader\`, anything. So:

- **Never coerce an unrecognised role to \`"member"\`.** \`member\` is not a floor — in most
  products it is write access. An unknown role must resolve to *no* role and *no* capability.
- **Never compare a role string to decide what someone may do.** \`role === "admin"\` is already
  false the day a domain renames the role.
- Read \`org_features.role_grants\` instead: \`{ "org": { <role>: <capability>[] },
  "team": { <role>: <capability>[] } }\`, with \`"owner"\` implicitly holding everything at the
  scope it stands in, an unmentioned role holding nothing, and a workspace answer being the union
  of the org-role and team-role grants. UOA validates that table against the domain's vocabularies
  and declared \`capabilities\` at config load, so anything you read there is coherent.

UOA gates its own org and team surfaces on exactly this table, using three capability names —
\`members.manage\` (roster mutation at either scope), \`teams.manage\` (the team object), and
\`organisation.manage\` (the organisation object: rename, member-invites policy, icon; **org scope
only**, so a team role never reaches it). See \`org_features.role_grants\` at \`/api\`. Products
declare their own catalogue in \`org_features.capabilities\` and gate on their own verbs.

A short list stays deliberately outside the table because it is structural rather than configured:
deleting an organisation, transferring its ownership and changing an org member's role require the
acting user to **be** \`Organisation.ownerId\`; granting or removing the \`"owner"\` role requires
the actor to hold it; and billing management is a verdict UOA computes from state only UOA holds,
never a grant. No \`role_grants\` entry can reach any of them.

Structural does not mean exempt from your vocabulary. Ownership transfer is the one such operation
that also *writes* a role — the outgoing owner's — so it obeys \`org_roles\` like every other
membership write. \`POST .../transfer-ownership\` takes an optional \`previousOwnerRole\` naming the
role that owner is left with; it is validated exactly as \`PUT .../members/:userId\` validates a role
change, and \`"owner"\` is refused, since the endpoint's contract is a demotion. Omit it and UOA
writes \`"admin"\` when your vocabulary contains that role, and otherwise your vocabulary's first
non-owner entry — so order \`org_roles\` from most to least authority. A vocabulary of nothing but
\`"owner"\` has no demotion target at all, and the transfer is refused rather than writing a role
your own config would reject back.

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
const tenantSlug = (claims.active as { tenantSlug?: string } | undefined)?.tenantSlug;
// Route a scoped, newly-issued token to \`\${tenantSlug}.your-tenant-domain\`.
// Re-authenticate or resolve the workspace through UOA before routing a legacy
// token that has no tenantSlug.

await storeRefreshTokenServerSide(body.refresh_token, body.refresh_token_expires_in);
await issueRpSession({ externalUserId, email, tenantId, tenantRole });
\`\`\`

Server-side behaviour on first verified login is controlled by \`org_features\`:

- \`registration_domain_mapping\` (top-level config) places the user into a configured org + team when the email domain matches.
- \`auto_create_personal_org_on_first_login\` (default \`false\`) creates a personal org with the user as \`owner\` plus a default team when no mapping matches. Skipped when \`pending_invites_block_auto_create\` is \`true\` and a pending invite exists for the email.
- \`allow_user_create_org\` (default \`false\`) gates \`POST /org/organisations\` for end-users. Superusers bypass. Keep \`false\` for admin-provisioned tenants.
- \`allow_user_create_team\` (default \`false\`) gates \`POST /auth/create-team\`: whether a user may add a **further workspace** to an organisation they already run, from the SSO chooser. Separate from \`allow_user_create_org\` because it writes into an existing tenant rather than creating a new one, and the org owner/admin role check still applies on top.

When \`login_flow.workspace_selection\` is \`"auto"\`, the hosted chooser has one
card-corner creation control that opens a dialog. It offers **Create a new
organisation** whenever the signed configuration grants organisation creation through
\`can_create_org: true\`; it sends \`{ login_token, name, join_policy? }\` to
\`POST /auth/create-workspace\`. That endpoint creates the organisation and its
default team atomically with the remaining login continuation. Do not mint a
tenant locally or use an empty \`/auth/select-team\` selection for this path.

An **organisation is the level above a workspace**, and the two creation paths differ accordingly.
\`can_create_org\` permits a user to create a *new organisation*; the chooser's \`creatable_orgs\`
(\`[{ orgId, orgName }]\`) lists organisations the user may add a *further workspace* to — they are
an ACTIVE owner/admin there and the domain set \`org_features.allow_user_create_team\`. When there
is more than one permitted destination, the dialog presents these exact values in an organisation
dropdown; never infer, add, or substitute an \`org_id\`. It posts
\`{ login_token, org_id, name, join_policy? }\` to \`POST /auth/create-team\`, which re-checks that
role and the org's \`max_teams_per_org\` cap, adds the creator to the new workspace, and finalizes
the login in the same transaction.

Both hosted chooser creation routes accept the optional \`join_policy\` values
\`"HIDDEN"\`, \`"INVITE_ONLY"\` (the default), and \`"OPEN_TO_ORG"\`. The UI labels
\`HIDDEN\` as **Private**: it is not discoverable and only people who are invited can find it.
\`INVITE_ONLY\` requires an invite to join, while \`OPEN_TO_ORG\` lets active members of the selected
organisation join themselves. Other team policies are managed through the organisation API, not this
hosted creation continuation. A user with exactly one workspace and no pending invites still auto-skips
the chooser, so that user reaches creation through the product rather than the sign-in popup.

After exchanging the resulting authorization code, use
\`access_token.active.tenantSlug\` as the tenant's DNS label. It is the
organisation slug and is unique within the client domain. \`Team.slug\` is only
unique inside its organisation, so it must not be used as a subdomain. Existing
tokens may omit \`tenantSlug\` until they expire; re-authenticate or resolve the
workspace through UOA before redirecting a legacy session to a tenant host.

### 4.6a Per-product confidential assertion exchange

A registered backend can exchange a short-lived user assertion, optionally
scoped to a selected workspace, for a resource-bound token without forwarding
its normal UOA access token or its domain credential to the resource server.
The calling product MUST authenticate this request with its own existing
per-domain app credential. UOA resolves that authenticated ClientDomain plus the
explicit product against an enabled database mapping containing one exact HTTPS
resource and a scope allowlist. There is no shared cross-product credential and
no singleton source/resource env fallback. This is a separate RFC 8693-style
grant on the same backend-only endpoint; the authorization-code and refresh
grants above remain unchanged.

\`\`\`ts
import { SignJWT } from 'jose';

const now = Math.floor(Date.now() / 1000);
const workspace = orgId && teamId ? { active: { orgId, teamId } } : {};
const subjectToken = await new SignJWT({
  source_domain: 'api.nessie.works',
  ...workspace,
})
  .setProtectedHeader({ alg: 'RS256', kid: NESSIE_CONFIG_KEY_ID, typ: 'JWT' })
  .setIssuer('api.nessie.works')
  .setAudience('https://authentication.unlikeotherai.com/auth/token')
  .setSubject(uoaUserId) // stable UOA sub, never email
  .setJti(crypto.randomUUID())
  .setIssuedAt(now)
  .setExpirationTime(now + 60)
  .sign(nessieConfigPrivateKey);

const response = await fetch(
  'https://authentication.unlikeotherai.com/auth/token?config_url=' +
    encodeURIComponent(NESSIE_CONFIG_URL),
  {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${NESSIE_DOMAIN_HASH}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      product: 'nessie',
      resource: 'https://ledger.unlikeotherai.com',
      scope: 'ai.invoke billing.read',
    }),
  },
);
\`\`\`

Before traffic is enabled, a UOA superuser creates the corresponding mapping
through \`/internal/admin/confidential-delegations\`. Source domain and product
are immutable after creation; resource, allowlisted scopes, and enabled state
are audited mutable policy. Nessie, DeepWater, DeepSignal, and DeepTest therefore
use their own registered domains and credentials even when their target resource
is the same Ledger deployment. A credential rotation remains valid because the
mapping binds the registered ClientDomain, never a plaintext secret, hash, or
individual secret row.

The source config JWT MUST publish \`jwks_url\` on the source domain. UOA fetches
that JWKS through its SSRF-protected, same-host pipeline and requires RS256 +
\`kid\`. The assertion requires exact \`iss\` and \`source_domain\`, exact
\`aud = PUBLIC_BASE_URL + "/auth/token"\`, stable UOA \`sub\`, non-empty \`jti\`,
\`iat\`/\`exp\` no more than 60 seconds apart. \`active\` is optional for
first-time or workspace-less users. When present it must be exactly
\`{ orgId, teamId }\` with both values non-empty; partial or malformed workspace
objects are rejected. Mint a fresh unique \`jti\` for every attempt: after
identity and optional workspace validation, UOA atomically consumes that
source-domain + \`jti\` once through \`exp\` plus clock tolerance. Exact and
concurrent replays are rejected across service instances.

UOA never trusts the assertion as current identity state. Before every issue it
re-reads the user and source-domain role. When \`active\` is supplied it also
re-reads the requested ACTIVE org and team memberships. Unknown users, missing
domain roles, and removed/deactivated or cross-org/team selections are rejected.

\`\`\`json
{
  "access_token": "<5-minute RS256 JWT>",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "ai.invoke billing.read"
}
\`\`\`

The issued token is verified with \`GET /oauth/jwks.json\` and contains
\`iss\`, resource \`aud\`, stable \`sub\`, advisory \`email\`,
\`source_domain\`, non-secret \`azp\` (the source domain), \`product\`, the exact
requested \`scope\` subset, \`jti\`, \`iat\`, and \`exp\`. A validated workspace
adds current \`org\` and selected
\`active\`; an identity-only exchange omits both. It contains no
\`client_id\` and never contains the 64-character domain-hash bearer credential.
This grant returns no refresh token.

For a chained hop, the next product authenticates with that product's own
registered config and domain-hash credential. It submits the already UOA-issued
token whose \`aud\` is exactly that product's HTTPS API origin:

\`\`\`json
{
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "subject_token": "<UOA RS256 at+jwt issued to DeepSignal>",
  "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "product": "deepsignal",
  "resource": "https://ledger.unlikeotherai.com",
  "scope": "ai.invoke"
}
\`\`\`

UOA binds the request credential and mapping to DeepSignal, verifies the inbound
UOA signature/issuer/expiry and exact DeepSignal audience, requires non-null
\`org\` + \`active\`, and revalidates the original source product mapping,
stable user/source-domain role, ACTIVE organisation, and ACTIVE selected team.
The requested scope must be allowed by DeepSignal's mapping and be a subset of
the inbound scope. The result never outlives the inbound token.

The chained result identifies the immediate caller through
\`source_domain\`, \`azp\`, and \`product\`, while \`act\` preserves upstream
product provenance (for Nessie→DeepSignal:
\`{"sub":"api.nessie.works","product":"nessie"}\`). A chained access-token
subject remains reusable until \`exp\`; only the first-hop source JWT assertion
is one-time. This supports concurrent multi-process calls without weakening the
exact audience, app-credential, workspace, or scope checks.

Unknown or disabled mappings, a product selected with another app credential,
an inexact resource (including path/trailing-slash differences), duplicate or
unsupported scopes, and scope widening all fail closed before assertion
verification. Supported delegation scopes are \`ai.invoke\`, \`billing.read\`,
and \`token.provision\`; the last is a separate high-privilege app capability
and is never implied by \`ai.invoke\`. The response and token contain only what that request asked
for, never the full mapping allowlist.

The confidential grant is rate-limited per authenticated source domain
(600/minute) and per verified source-domain user (60/minute), so users behind
one Nessie egress IP do not consume a shared 10/minute bucket.

${llmBackendModeMarkdown}

### 4.7 Organisation member lifecycle — deactivate, reactivate, soft-remove

Membership rows carry a \`status\`: \`ACTIVE\` | \`DEACTIVATED\` | \`REMOVED\`. Deactivation suspends access without deleting history (Slack's "deactivate", not "kick"); removal is a tombstone, not a hard delete, so audit history survives.

- \`POST /org/organisations/:orgId/members/:userId/deactivate\` — suspends the member: their org and team rows move to \`DEACTIVATED\`. In the same fail-closed transaction, UOA revokes every refresh family scoped to that exact user+org across all issuing product domains, plus same-domain legacy/unscoped sessions. Cannot deactivate an \`owner\` — transfer ownership first. The user disappears from \`GET /org/organisations/:orgId/members\` (default view) and from \`firstLogin\`/\`GET /org/me\` on their next token refresh.
- \`POST /org/organisations/:orgId/members/:userId/reactivate\` — flips a \`DEACTIVATED\` member back to \`ACTIVE\`. No sessions are restored; the user simply signs in again.
- \`DELETE /org/organisations/:orgId/members/:userId\` — now a soft-remove: status becomes \`REMOVED\` (not a row delete), and the exact-org plus legacy same-domain revocation above applies. Re-adding a previously removed user via \`POST /org/organisations/:orgId/members\` **reactivates** their existing row (and re-activates their default-team membership) but never restores revoked sessions.
- \`DELETE /org/organisations/:orgId/teams/:teamId/members/:userId\` — tombstones only that team membership and atomically revokes exact user+team refresh families across all issuing product domains. Other-team sessions remain valid; re-add does not restore the revoked families.
- \`GET /org/organisations/:orgId/members\` defaults to \`ACTIVE\` members only. Pass \`?status=DEACTIVATED\`, \`?status=REMOVED\`, or \`?status=all\` to see other lifecycle states (e.g. for an admin roster view that lists suspended/removed accounts).

Org lifecycle is serialized with both current scoped refresh and legacy unscoped same-domain
refresh. A concurrent refresh therefore cannot mint a surviving replacement after revocation.

To revoke on logout:

\`\`\`text
POST /auth/revoke?config_url=<your_config_endpoint_url>
Authorization: Bearer <client_hash>
Content-Type: application/json

{ "refresh_token": "<refresh token to revoke>" }
\`\`\`

This returns the same success for unknown/mismatched tokens (no token oracle). For a valid token it
re-reads under the user-global and user/domain transaction locks, then atomically revokes the family
and increments the user's token version. Password reset, password binding, and all 2FA reset/disable
paths atomically revoke every refresh token and increment the same version.

Domain admin APIs (\`/domain/users\`, \`/domain/logs\`, etc.) and team-invite / access-request review APIs use the same \`Authorization: Bearer <client_hash>\` mechanism. The old global shared-secret bearer is NOT accepted for any customer-facing endpoint.

${llmTeamsInvitationsMarkdown}


### 4.7 Two-factor login branches

When config \`2fa_enabled\` is false or absent, no 2FA branch runs. When it is true, UOA resolves DB policy from the Service/domain, same-domain Organisations, and the exact selected Organisation using strongest-wins (\`off < optional < required\`). A recognized product resolves that exact workspace before 2FA even when its chooser is off. Authorization-code exchange rechecks current policy and enrollment against persisted interactive proof, so a newly stricter policy fails closed before token issuance.

- Enrolled users get \`{ ok: true, twofa_required: true, twofa_token }\`; submit \`{ twofa_token, code }\` to \`POST /2fa/verify?config_url=...\` and follow \`redirect_to\`.
- Required but unenrolled users get \`{ ok: true, kind: "twofa_enroll_required", twofa_enroll_required: true, setup_token, otpauth_uri?, qr_svg?, manual_secret? }\`; the Auth UI completes \`POST /2fa/enroll\` with the setup token and initial code before any authorization code is granted.
- Optional and unenrolled users continue normally.

For account settings, an authenticated user can call \`POST /2fa/setup\` with \`X-UOA-Access-Token\`, enroll with \`POST /2fa/enroll\`, and disable with \`POST /2fa/disable\` plus a current TOTP code. Disable is rejected generically when the effective policy is required.

---
`;
