// Section 4.6b of the /llm guide: the backend-mode (no acting user) calling
// convention for every /org/* route, its per-route table and its error table.
export const llmBackendModeMarkdown = `### 4.6b Server-to-server organisation/team management (backend mode)

Every \`/org/*\` route already authenticates the **domain pairing**: the
per-domain hash bearer in \`Authorization\`, plus the partner's signed config JWT
fetched from \`?config_url=\` and tied to \`?domain=\`. That pairing proves *"this
is the backend for domain X"*, and it is the only authentication several \`/org\`
routes have ever needed (\`GET /org/organisations\`, the bulk branch of
\`POST .../invitations\`, the access-request family).

**Backend mode omits both user credentials:** \`X-UOA-Access-Token\` and
\`X-UOA-Subject-Assertion\`. There is no acting user, no token exchange, and no
extra header.

### 4.6c Product-signed current-user assertion

An integrated product that needs UOA to authorize the person currently signed
into that product, but deliberately does not retain a UOA bearer token, sends a
short-lived RS256 JWT in \`X-UOA-Subject-Assertion\` instead of
\`X-UOA-Access-Token\`. This is user mode, never backend mode, and it still sends
the usual domain-hash bearer and verified config URL.

The assertion must be signed by the product key advertised in the verified
config JWT's JWKS, have \`iss\` and \`source_domain\` equal to that config domain,
have exact \`aud\` \`https://authentication.unlikeotherai.com/org\`, live for at
most 60 seconds, and contain \`{ sub, tv, active: { orgId, teamId } }\`. The
active org/team must exactly match the route parameters. UOA then verifies the
signature and re-resolves the subject's current credential epoch and ACTIVE
cross-product membership before it applies the ordinary user role/capability
gate and writes ordinary user audit attribution. A product assertion is not a
UOA access token, is never persisted by UOA, and cannot grant tenant-wide
backend authority.

Send exactly one user credential. A request with both headers, a blank or
repeated assertion, a stale epoch, invalid signature/audience/lifetime, or a
different active workspace is refused; it never falls through to backend mode.
\`GET /org/organisations\` and backend-only invitation acceptance refuse either
user credential with \`401 ACCESS_TOKEN_NOT_ALLOWED\`.

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
  modes: the organisation must have been created on the verified domain, the last
  owner cannot be removed, membership and team caps still hold, and a user cannot
  be removed from their last team.
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

**Domain isolation is absolute — in this mode.** The call binds to the domain in
the VERIFIED config, never the raw query string — a \`?domain=\` that differs is
\`400 DOMAIN_MISMATCH\`. The guard then checks the \`:orgId\` against
\`organisations.domain\` (the org's ORIGIN — the product that created it), so an
\`:orgId\` another product created is a plain \`404\`. A backend for domain X cannot
see or touch an organisation created on domain Y.

This is backend mode's *only* boundary, and the one place origin scoping is still
an authorization predicate. **User-token calls are different**: one organisation
is usable from every UOA-integrated product, so \`/org/organisations/:orgId/**\`
resolves the org by id alone and gates on the token's \`domain\` + \`org\` claim plus
live ACTIVE membership. A user who belongs to an org created on domain X manages
it from domain Y with a domain-Y token; a domain-Y *backend* still cannot.

**Per route, in backend mode:**

| Route | Backend mode |
|---|---|
| \`GET /org/me\` | **No** — 401. It answers "who am I", which has no meaning without a caller. |
| \`GET /org/organisations\` | Yes (already was). |
| \`POST /org/organisations\` | Yes. Body **must** carry \`owner_user_id\`; \`allow_user_create_org\` does not apply. The response carries \`defaultTeam\` (below). |
| \`GET|PUT|DELETE /org/organisations/:orgId\` | Yes. |
| \`GET|POST /org/organisations/:orgId/members\` | Yes. \`POST\` takes \`userId\` as today. |
| \`PUT|DELETE .../members/:userId\` | Yes. |
| \`POST .../members/:userId/deactivate|reactivate\` | Yes. |
| \`POST .../transfer-ownership\` | Yes. Demotes the org's **current owner** — see below for the role they land on. |
| \`GET .../groups\`, \`GET .../groups/:groupId\` | Yes. |
| \`GET .../teams\` | Yes — and lists \`HIDDEN\` teams too; that filter is member-to-member discovery. |
| \`POST .../teams\` | Yes — but \`join_creator\` is ignored: there is no acting user to add. |
| \`GET .../teams/:teamId\` | Yes, including \`?include=invited\`. |
| \`PUT|DELETE .../teams/:teamId\` | Yes. |
| \`POST .../teams/:teamId/members\` | Yes. Takes \`userId\` as today. |
| \`PUT|DELETE .../teams/:teamId/members/:userId\` | Yes. |
| \`GET|PUT|DELETE .../teams/:teamId/avatar\` | Yes. |
| \`POST .../teams/:teamId/join\` | **No** — 401. Self-join's subject IS the acting user. |
| \`POST|GET .../teams/:teamId/invitations\`, \`.../resend\` | Yes (already was — this is the bulk-invite contract). |
| \`GET .../teams/:teamId/invitations/:inviteId\` | Yes — reads one invitation by id, same record shape as the list. |
| \`POST .../teams/:teamId/invitations/:inviteId/accept\` | **Backend-only.** Strict body \`{ userId }\`; accepts for that asserted UOA invitee and returns \`{ ok, orgId, teamId }\`. Any present user token is refused. |
| \`DELETE .../teams/:teamId/invitations/:inviteId\` | Yes — revokes any pending invitation, including one still awaiting member-invite approval. |
| \`POST|GET|DELETE .../teams/:teamId/invite-links\` | Yes. A link created this way has \`created_by_user_id: null\`. |
| \`GET .../invitations?approval=pending\` | Yes. |
| \`POST .../invitations/:inviteId/approve|deny\` | Yes. No reviewer is recorded. |
| \`GET|POST .../access-requests…\` | Yes (already was). Optional \`reviewedByUserId\` in the body, unchanged — it is a label, never an actor. The \`:orgId\`/\`:teamId\` must be your own domain's, even when your signed config names them as the access-request target. |

**Creating an organisation gives you its workspace in the same answer.** The
create transaction also makes a default team named "General" and puts the owner
in it, and the response carries that whole team record as \`defaultTeam\`. Use
\`defaultTeam.id\` to address the new workspace immediately.

This matters most to a product driving creation from its own UI: there is no
follow-up read that recovers the id with a user credential, because a
\`X-UOA-Subject-Assertion\` has to name the org and team it is acting on, and
those are exactly what is unknown a millisecond after the org is born. Without
the field, such a product had to send the person back through the interactive
chooser purely to learn one id. Backend mode can of course also call
\`GET /org/organisations/:orgId/teams\` and pick the \`isDefault\` entry; keeping
that as a defensive fallback is reasonable, but it is no longer required.

**Errors specific to this mode:**

| Status | Code | Meaning |
|---|---|---|
| 401 | \`MISSING_ACCESS_TOKEN\` | No user token and \`backend_org_management\` is not \`true\` (or the domain-hash guard did not pass). Also: an \`X-UOA-Access-Token\` that is present but blank (\`""\`, whitespace, \`"Bearer "\`) — a blank credential is malformed, never "omitted". |
| 401 | \`ACCESS_TOKEN_NOT_ALLOWED\` | \`GET /org/organisations\` is backend-only and has no user mode. It refuses ANY present \`X-UOA-Access-Token\`, valid or blank — omit the header. For a user's own workspaces use \`GET /org/me\`. |
| 400 | \`DOMAIN_MISMATCH\` | \`?domain=\` does not equal the verified config \`domain\`. |
| 400 | \`OWNER_REQUIRED\` | \`POST /org/organisations\` in backend mode without \`owner_user_id\`. |
| 400 | \`OWNER_NOT_ALLOWED\` | \`POST /org/organisations\` with a user token AND \`owner_user_id\` — ambiguous. |
| 400 | (generic) | \`owner_user_id\` names a user who does not exist or does not belong to this domain. |
| 429 | \`RATE_LIMITED\` | Backend organisation creation is capped per domain per hour (well above normal provisioning volume). The end-user path keeps its own, much lower, per-user cap. |
| 404 | \`ORG_FEATURES_DISABLED\` | \`org_features.enabled\` is false. |
| 404 | (generic) | The \`:orgId\` was not created on this domain (backend mode only — user-token calls resolve any org the token is scoped to). |

**Audit attribution.** A backend-initiated mutation writes
\`actor_user_id: null\` and records who acted under the reserved \`uoa_actor\` key
of \`OrgAuditLog.metadata\`:

\`\`\`json
{ "uoa_actor": { "via": "domain_backend", "source_domain": "api.hugopos.eu" } }
\`\`\`

Rows without that key were made by a user directly.`;
