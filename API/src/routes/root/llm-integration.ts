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
- \`allow_user_create_team\` (default \`false\`) gates \`POST /auth/create-team\`: whether a user may add a **further workspace** to an organisation they already run, from the SSO chooser. Separate from \`allow_user_create_org\` because it writes into an existing tenant rather than creating a first one, and the org owner/admin role check still applies on top.

When \`login_flow.workspace_selection\` is \`"auto"\`, the hosted chooser has one
card-corner creation control that opens a dialog. It offers **Create a new
organisation** only for the existing first-workspace capability
\`can_create_org: true\`; it sends \`{ login_token, name, join_policy? }\` to
\`POST /auth/create-workspace\`. That endpoint creates the organisation and its
default team atomically with the remaining login continuation. Do not mint a
tenant locally or use an empty \`/auth/select-team\` selection for this path.

An **organisation is the level above a workspace**, and the two creation paths differ accordingly.
\`can_create_org\` is about a user's *first organisation*; the chooser's \`creatable_orgs\`
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

### 4.6b Server-to-server organisation/team management (backend mode)

Every \`/org/*\` route already authenticates the **domain pairing**: the
per-domain hash bearer in \`Authorization\`, plus the partner's signed config JWT
fetched from \`?config_url=\` and tied to \`?domain=\`. That pairing proves *"this
is the backend for domain X"*, and it is the only authentication several \`/org\`
routes have ever needed (\`GET /org/organisations\`, the bulk branch of
\`POST .../invitations\`, the access-request family).

**Backend mode simply omits \`X-UOA-Access-Token\`.** There is no second
credential, no token exchange, and no extra header.

**Omit the header — do not send it empty.** A header that is present but blank
(an empty string, spaces, a tab, a newline) is a malformed credential, not an absent one,
and is \`401 MISSING_ACCESS_TOKEN\`. This bites the common BFF shape: if you
attach the domain-hash bearer server-side and forward the end user's session
token, an anonymous visitor forwards an empty string — and that must stay a 401
rather than silently becoming a whole-tenant backend call. Send the header only
when you actually have a token. A repeated \`X-UOA-Access-Token\` header is
rejected for the same reason.

\`\`\`text
POST /org/organisations/<orgId>/teams?domain=<d>&config_url=<u>
Authorization: Bearer <client_hash>
Content-Type: application/json

{ "name": "Kitchen" }
\`\`\`

**Opt in first.** Set \`org_features.backend_org_management: true\` in the signed
config for that domain. It defaults to \`false\`, and while it is \`false\` a
missing \`X-UOA-Access-Token\` is still \`401 MISSING_ACCESS_TOKEN\` exactly as
before. The flag is not a new credential — it is a second secret in the path: an
attacker who steals only the domain-hash bearer still cannot turn the flag on,
because the config JWT is signed with the partner's own private key.

**There is no acting user.** That is the whole point, and it has consequences:

- Per-user org/team role checks (owner/admin, team manager, "must be a member")
  do not apply — there is no user to check them against, and the pairing already
  proves authority over the entire tenant, which outranks any single member's
  role.
- Every check that is NOT about the acting user is unchanged and applies to both
  modes: the organisation must belong to the verified domain, the last owner
  cannot be removed, membership and team caps still hold, one-org-per-domain
  still holds, a user cannot be removed from their last team.
- Where a route needs to name a user, name it explicitly. \`POST
  /org/organisations\` takes \`owner_user_id\`; the member routes already take
  \`userId\`. Nothing is inferred.
- A named \`owner_user_id\` must **belong to your domain** — the user must have
  authenticated there at least once (UOA records a domain role on login).
  Existence alone is not enough: with the default \`user_scope: global\`, user
  rows are visible across domains, so "the id resolves" would let you name a
  stranger.

The three org-level checks below are **deliberately not enforced** in backend
mode, because each protects members from one another and the backend is not a
member: only-the-owner-may-change-roles, only-the-owner-may-delete-the-org, and
the \`allow_user_create_org\` gate. Everything in the bullet above this one still
applies.

**Domain isolation is absolute.** The call binds to the domain in the VERIFIED
config, never the raw query string — a \`?domain=\` that differs is
\`400 DOMAIN_MISMATCH\`. Every handler then resolves the organisation as
\`(orgId, verified domain)\`, so an \`:orgId\` that belongs to another domain is a
plain \`404\`. A backend for domain X cannot see or touch domain Y.

**Per route, in backend mode:**

| Route | Backend mode |
|---|---|
| \`GET /org/me\` | **No** — 401. It answers "who am I", which has no meaning without a caller. |
| \`GET /org/organisations\` | Yes (already was). |
| \`POST /org/organisations\` | Yes. Body **must** carry \`owner_user_id\`; \`allow_user_create_org\` does not apply. |
| \`GET|PUT|DELETE /org/organisations/:orgId\` | Yes. |
| \`GET|POST /org/organisations/:orgId/members\` | Yes. \`POST\` takes \`userId\` as today. |
| \`PUT|DELETE .../members/:userId\` | Yes. |
| \`POST .../members/:userId/deactivate|reactivate\` | Yes. |
| \`POST .../transfer-ownership\` | Yes. Demotes the org's **current owner** to admin. |
| \`GET .../groups\`, \`GET .../groups/:groupId\` | Yes. |
| \`GET .../teams\` | Yes — and lists \`HIDDEN\` teams too; that filter is member-to-member discovery. |
| \`POST .../teams\` | Yes. |
| \`GET .../teams/:teamId\` | Yes, including \`?include=invited\`. |
| \`PUT|DELETE .../teams/:teamId\` | Yes. |
| \`POST .../teams/:teamId/members\` | Yes. Takes \`userId\` as today. |
| \`PUT|DELETE .../teams/:teamId/members/:userId\` | Yes. |
| \`GET|PUT|DELETE .../teams/:teamId/avatar\` | Yes. |
| \`POST .../teams/:teamId/join\` | **No** — 401. Self-join's subject IS the acting user. |
| \`POST|GET .../teams/:teamId/invitations\`, \`.../resend\` | Yes (already was — this is the bulk-invite contract). |
| \`GET .../teams/:teamId/invitations/:inviteId\` | Yes — reads one invitation by id, same record shape as the list. |
| \`DELETE .../teams/:teamId/invitations/:inviteId\` | Yes — revokes any pending invitation, including one still awaiting member-invite approval. |
| \`POST|GET|DELETE .../teams/:teamId/invite-links\` | Yes. A link created this way has \`created_by_user_id: null\`. |
| \`GET .../invitations?approval=pending\` | Yes. |
| \`POST .../invitations/:inviteId/approve|deny\` | Yes. No reviewer is recorded. |
| \`GET|POST .../access-requests…\` | Yes (already was). Optional \`reviewedByUserId\` in the body, unchanged — it is a label, never an actor. The \`:orgId\`/\`:teamId\` must be your own domain's, even when your signed config names them as the access-request target. |

**Errors specific to this mode:**

| Status | Code | Meaning |
|---|---|---|
| 401 | \`MISSING_ACCESS_TOKEN\` | No user token and \`backend_org_management\` is not \`true\` (or the domain-hash guard did not pass). Also: an \`X-UOA-Access-Token\` that is present but blank (\`""\`, whitespace, \`"Bearer "\`) — a blank credential is malformed, never "omitted". |
| 401 | \`ACCESS_TOKEN_NOT_ALLOWED\` | \`GET /org/organisations\` is backend-only and has no user mode. It refuses ANY present \`X-UOA-Access-Token\`, valid or blank — omit the header. For a user's own workspaces use \`GET /org/me\`. |
| 400 | \`DOMAIN_MISMATCH\` | \`?domain=\` does not equal the verified config \`domain\`. |
| 400 | \`OWNER_REQUIRED\` | \`POST /org/organisations\` in backend mode without \`owner_user_id\`. |
| 400 | \`OWNER_NOT_ALLOWED\` | \`POST /org/organisations\` with a user token AND \`owner_user_id\` — ambiguous. |
| 400 | (generic) | \`owner_user_id\` names a user who does not exist, does not belong to this domain, or already has an active organisation here. |
| 429 | \`RATE_LIMITED\` | Backend organisation creation is capped per domain per hour (well above normal provisioning volume). The end-user path keeps its own, much lower, per-user cap. |
| 404 | \`ORG_FEATURES_DISABLED\` | \`org_features.enabled\` is false. |
| 404 | (generic) | The \`:orgId\` is not on this domain. |

**Audit attribution.** A backend-initiated mutation writes
\`actor_user_id: null\` and records who acted under the reserved \`uoa_actor\` key
of \`OrgAuditLog.metadata\`:

\`\`\`json
{ "uoa_actor": { "via": "domain_backend", "source_domain": "api.hugopos.eu" } }
\`\`\`

Rows without that key were made by a user directly.

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

### 4.7a Team join policies + member-initiated invites (Phase 4)

Every \`Team\` has a \`joinPolicy\`: \`INVITE_ONLY\` (default) | \`APPROVED_DOMAIN\` | \`REQUEST_TO_JOIN\` | \`OPEN_TO_ORG\` | \`HIDDEN\`. The policy **gates** the existing join mechanisms rather than replacing them:

- **Auto-enrolment** via \`access_requests.auto_grant_domains\` only auto-adds a user when the configured target team's \`joinPolicy\` is \`APPROVED_DOMAIN\`.
- **Request-to-join** (\`access_requests.enabled\`) only accepts a request when the target team's \`joinPolicy\` is \`REQUEST_TO_JOIN\`; any other policy fails the login with a generic error when \`request_access=true\` is set.
- **Self-join** — \`POST /org/organisations/:orgId/teams/:teamId/join\` (access token required) — succeeds only when the team's \`joinPolicy\` is \`OPEN_TO_ORG\` and the caller is an ACTIVE member of the team's org. Reactivates a previously removed/deactivated row instead of duplicating it.
- **HIDDEN** teams are excluded from \`GET /org/organisations/:orgId/teams\` for callers who are not already an ACTIVE member of that team.
- Set the policy with \`PUT /org/organisations/:orgId/teams/:teamId\` (\`{ "joinPolicy": "OPEN_TO_ORG" }\`, owner/admin only).

Team invites now carry an \`expiresAt\` (30 days from send/resend — resending refreshes it) and an \`approvalStatus\`: \`not_required\` | \`pending\` | \`approved\` | \`denied\`. The derived invite \`status\` gains \`expired\` and \`revoked\` alongside \`pending | accepted | declined | replaced\` (\`replaced\` = superseded by a newer invite for the same email; \`revoked\` = explicitly cancelled); an expired, revoked, or not-yet-approved invite cannot be accepted and is excluded from the workspace chooser / \`firstLogin.pending_invites\`.

Reading one invitation: \`GET /org/organisations/:orgId/teams/:teamId/invitations/:inviteId\` returns that single invitation in exactly the shape each entry of the list carries (derived \`status\`, \`approvalStatus\`, \`expiresAt\`, inviter, send/open and accepted/declined/revoked state, \`invitedByAvatarImageUrl\`/\`acceptedAvatarImageUrl\`) — so a caller holding an id can re-read one row instead of the whole team's invite history. Authorization is the list's: domain-hash + verified config + \`org_features\`, backend-mode capable. It is read-only — nothing is written and no audit row is produced. An unknown id, an invitation belonging to a foreign org/team, and a cross-domain org all answer the same generic \`404\`, so the endpoint is never an existence oracle.

Where the id comes from: the trusted-backend bulk call \`POST /org/organisations/:orgId/teams/:teamId/invitations\` answers \`{ "results": [...] }\` with one object per submitted email — \`{ email, status, invite? }\`. On \`invited\` and \`resent_existing\` rows the \`invite\` key is the full invitation record, so \`results[i].invite.id\` is the id of the invitation just created (or, for \`resent_existing\`, of the fresh invitation that superseded the previous one) and is what the by-id read, \`.../resend\`, and \`DELETE\` take. The \`already_member\`, \`existing_user\`, and \`conflict\` outcomes create no invitation and therefore carry \`email\` + \`status\` only, with no \`invite\` key. The member-initiated (\`X-UOA-Access-Token\`) variant returns \`{ "status": "ok" }\` and deliberately no id — revealing one would be enumeration.

Revoking an invitation: \`DELETE /org/organisations/:orgId/teams/:teamId/invitations/:inviteId\` cancels a pending invitation in either state — already emailed, or still awaiting member-invite approval. The row is kept (invite history is audit history) with \`status: "revoked"\`, outstanding emailed tokens are consumed, and the invite link's hosted landing page tells the recipient the invitation was revoked. In user mode the caller must be an org/team \`owner\`/\`admin\` or the invite's original inviter; backend mode follows the table above. Responses: \`200 { "ok": true }\` (idempotent — an already-revoked or declined invitation also answers \`200\`), \`409\` with code \`INVITATION_ALREADY_ACCEPTED\` once the invite has been accepted (remove the member instead), generic \`404\` for an unknown id or a foreign org/team/domain.

Member-initiated invites: \`POST /org/organisations/:orgId/teams/:teamId/invitations\` accepts the same path used by the trusted backend bulk-invite call, but when called WITH an \`X-UOA-Access-Token\` header it becomes a single-invite, permission-gated call instead:

- Org or team \`owner\`/\`admin\`: always allowed, sent immediately (\`approvalStatus: not_required\`).
- A plain ACTIVE team member: gated by the organisation's \`memberInvites\` setting (\`allowed\` default | \`admin_approval\` | \`disabled\`, set via \`PUT /org/organisations/:orgId\` \`{ "member_invites": "admin_approval" }\`). \`admin_approval\` creates the invite as \`pending\` and sends **no email** until an owner/admin approves it.
- A deactivated member, or a plain member when \`disabled\`, is rejected generically.
- The response is always \`{ "status": "ok" }\` regardless of outcome — whether the email already has an account is never revealed (no enumeration).

Owner/admin review the pending queue with \`GET /org/organisations/:orgId/invitations?approval=pending\`, then \`POST /org/organisations/:orgId/invitations/:inviteId/approve\` (sends the invite email) or \`.../deny\` (silent to the invitee, sends nothing).

### 4.7b Sidebar workspace stack, "Invited" tab, and workspace icons (gap-fix A, design §11.3–§11.5)

\`GET /org/me\` now returns two additive fields inside \`org\` alongside the existing \`org_id\`,
\`org_role\`, \`teams\`, \`team_roles\`, \`groups\` (unchanged — this is purely additive). For a
recognized \`all_active_memberships\` product with no same-domain organisation, the complete legacy
block is anchored to the access token's exact selected \`active.orgId\` after UOA revalidates that
organisation and the product policy live:

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
        "avatarImageUrl": "https://authentication.unlikeotherai.com/teams/team_1/avatar",
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
        "avatarImageUrl": "https://authentication.unlikeotherai.com/teams/team_2/avatar",
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

- \`workspaces[]\` — one entry per ACTIVE team membership on this domain. When UOA's server-owned
  product policy is \`all_active_memberships\`, it instead contains the same complete active
  workspace directory as the hosted chooser. It is ordered \`lastLoginAt\` DESC with nulls last,
  then \`name\` ASC (this IS the sidebar order — render it as-is). \`lastLoginAt\` is \`null\` when
  the caller never opened a session scoped to that workspace; cross-product entries intentionally
  remain \`null\` because another product's session history is not exposed. Group by each entry's
  own \`orgId\`/\`orgName\`; the directory may span organisations and is not implicitly scoped by the
  singular legacy \`org_id\` field.
- \`avatarImageUrl\` — the public, credential-free \`<PUBLIC_BASE_URL>/teams/<teamId>/avatar\` form.
  It is never null and resolves uploaded image → proxied \`iconUrl\` → deterministic generated image,
  so a native or browser client renders this field directly instead of fetching \`iconUrl\` itself.
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

When config \`2fa_enabled\` is false or absent, no 2FA branch runs. When it is true, UOA resolves DB policy from the Service/domain, same-domain Organisations, and the exact selected Organisation using strongest-wins (\`off < optional < required\`). A recognized product resolves that exact workspace before 2FA even when its chooser is off. Authorization-code exchange rechecks current policy and enrollment against persisted interactive proof, so a newly stricter policy fails closed before token issuance.

- Enrolled users get \`{ ok: true, twofa_required: true, twofa_token }\`; submit \`{ twofa_token, code }\` to \`POST /2fa/verify?config_url=...\` and follow \`redirect_to\`.
- Required but unenrolled users get \`{ ok: true, kind: "twofa_enroll_required", twofa_enroll_required: true, setup_token, otpauth_uri?, qr_svg?, manual_secret? }\`; the Auth UI completes \`POST /2fa/enroll\` with the setup token and initial code before any authorization code is granted.
- Optional and unenrolled users continue normally.

For account settings, an authenticated user can call \`POST /2fa/setup\` with \`X-UOA-Access-Token\`, enroll with \`POST /2fa/enroll\`, and disable with \`POST /2fa/disable\` plus a current TOTP code. Disable is rejected generically when the effective policy is required.

---
`;
