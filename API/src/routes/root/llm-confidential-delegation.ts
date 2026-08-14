/**
 * `/llm` documentation for the per-product confidential assertion exchange
 * (§4.6a). Extracted from llm-integration.ts to keep every file under the
 * 500-line limit; the wording is part of the machine-checked API contract
 * (see API/tests/unit/api-schema-*.test.ts and the /llm route docs rule).
 */
export const llmConfidentialDelegationMarkdown = `### 4.6a Per-product confidential assertion exchange

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
\`iss\`, resource \`aud\`, stable \`sub\`,
advisory \`email\` (omitted whenever the scope contains \`identity.read\`,
\`membership.invite\`, or \`membership.manage\`), \`source_domain\`,
non-secret \`azp\` (the source domain), \`product\`, the exact
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
the inbound scope. The result never outlives the inbound token. The inbound
advisory \`email\` claim is optional — identity/membership-scoped tokens omit
it — and verification depends only on stable \`sub\`, mandatory \`tv\`, and
the re-resolved workspace; a narrowed token's email (when its scope allows one)
comes from the live user record.

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
\`token.provision\`, \`identity.read\`, \`membership.invite\`, and
\`membership.manage\`; \`token.provision\` is a separate high-privilege app
capability and the identity/membership scopes are globally pinned: any
resolve/create/update containing \`identity.read\`, \`membership.invite\`,
or \`membership.manage\` must name the exact \`nessie-identity\` binding
(source \`api.nessie.works\`, literal product \`nessie-identity\`, resource
\`https://authentication.unlikeotherai.com\`), and its stored mapping must
carry exactly the three privileged scopes — any other product, source,
resource, or drifted stored set is refused. Each token request may still be
any non-empty subset of that exact allowlist, and the issued token carries
exactly the requested subset. This binding coexists with ordinary \`nessie\`
product mappings, which never carry privileged scopes. Privileged scopes are
also terminal: they only ever target UOA's own identity/membership resource,
so a token carrying them can never be re-delegated onward as a privileged
chained hop. Disabling the exact mapping stays allowed; none are ever implied
by \`ai.invoke\`. The response and token contain only what that request asked
for, never the full mapping allowlist.

The confidential grant is rate-limited per authenticated source domain
(600/minute) and per verified source-domain user (60/minute), so users behind
one Nessie egress IP do not consume a shared 10/minute bucket.

`;

/**
 * The per-route backend-mode table for §4.6b (kept beside the confidential
 * exchange section to keep llm-integration.ts under the 500-line limit).
 */
export const llmBackendModeRouteTableMarkdown = `| Route | Backend mode |
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
| \`POST|GET|DELETE .../teams/:teamId/invite-links\` | Yes. A link created this way has \`created_by_user_id: null\`. |
| \`GET .../invitations?approval=pending\` | Yes. |
| \`POST .../invitations/:inviteId/approve|deny\` | Yes. No reviewer is recorded. |
| \`GET|POST .../access-requests…\` | Yes (already was). Optional \`reviewedByUserId\` in the body, unchanged — it is a label, never an actor. The \`:orgId\`/\`:teamId\` must be your own domain's, even when your signed config names them as the access-request target. |

`;

/** The backend-mode error table for §4.6b (extracted for the line limit). */
export const llmBackendModeErrorTableMarkdown = `| Status | Code | Meaning |
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

`;
