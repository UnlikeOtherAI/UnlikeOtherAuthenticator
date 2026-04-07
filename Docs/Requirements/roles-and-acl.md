# Roles & ACL — Requirements

## Two distinct role systems

There are two completely separate concepts that must not be conflated.

### 1. UOA system roles (internal)

These control who can administer the UOA backend itself — the org and team structure, billing, membership. There are exactly two UOA system roles:

| Role | Scope | Rules |
|---|---|---|
| `owner` | Org or Team | Created with the org/team. Cannot be removed. Can transfer ownership to any other user. Implicitly has all admin capabilities. |
| `admin` | Org or Team | Full power: delete teams, manage billing, manage members, manage domains. Multiple admins allowed. Any user can be granted or revoked admin. |

Users who are neither `owner` nor `admin` have no named UOA system role — they are plain members whose significance is defined entirely by their custom role.

`system_admin` is a separate global role for UOA's own admin panel operators and is not visible to org/team users. It is stored as the string value `"system_admin"` on the internal `AdminUser` model (separate from `OrgMember`/`TeamMember`). System admin identity is verified via domain-hash auth against the admin domain + the UOA `SHARED_SECRET` (same mechanism as other internal routes). Endpoints under `/internal/admin/` require system admin auth and bypass all org/team permission middleware.

### 2. Consumer-defined roles (external, custom)

These are roles that a developer or org defines for their own product. UOA stores only the **label** — a string reference. UOA has no opinion on what the role permits. The consuming application owns all gating logic.

- Any number of custom roles per team or organisation — no cap
- Each role set has exactly one **default role** — marked with a tick in the admin UI. Any user added without a specified role, or auto-enrolled via domain rule, receives the default role automatically
- Custom roles can share names with UOA system roles (different namespaces, no conflict)
- A user's UOA role and their custom role are completely orthogonal

UOA's only responsibilities for custom roles:
- Store the role definitions per team, including which is the default
- Validate that a role assigned to a user exists in the team's defined list
- Return the role label(s) in the access token and via API
- Enforce nothing beyond that

---

## Hierarchy model

```
Organisation
  ├── has many Domains     (multiple — one org can serve hundreds of services)
  ├── has UOA role assignments (owner, admin) per member
  └── has many Teams
        ├── references one or more Domains from the org's domain pool
        ├── has UOA role assignments (owner, admin) per member
        ├── has custom role definitions (with one marked default) — custom roles are team-scoped only; there are no independently-defined org-level custom roles
        └── has Members with assigned custom roles
```

### Auto-organisation rule

Teams are the primary registration unit. Not every setup needs a full enterprise org structure.

**Rule:** When a team is created without specifying an organisation, UOA automatically creates an organisation with the same name and slug and places the team under it. That org starts in single-team mode.

- Single-team org = the default, lightweight path (most small integrations)
- Multi-team org = enterprise path, unlocked simply by adding a second team
- Teams are always under an org — the org may just be implicit and auto-created

### Domain assignment

- Domains are registered at **organisation level**
- An org can have any number of domains (`api.acme.com`, `app.acme.com`, `admin.acme.com`, etc.)
- A domain belongs to exactly one organisation
- Teams reference domains from their org's pool — the team is what gets registered against a domain
- Inbound auth request flow: domain → org → team registered for that domain → user's membership and roles for that team

---

## Custom role definitions

Each team defines its own role names. One role is marked as the default. Custom roles are team-scoped — there is no independently-defined org-level custom role set. The `org.customRole` field in the token is a convenience field derived from the user's primary team (see Token output section below).

```json
{
  "teamId": "team_abc",
  "customRoles": [
    { "name": "editor",  "default": false },
    { "name": "viewer",  "default": true  },
    { "name": "staff",   "default": false },
    { "name": "manager", "default": false }
  ]
}
```

- Exactly one role per team must be marked default at all times
- If the default role is deleted, the admin must designate a new default before the deletion is allowed. If the default role no longer exists at the time of auto-enrolment (race condition), the auto-enrolment fails gracefully: the user is added as a plain member with no `customRole` assigned and no error is returned.
- No limit on number of roles
- Role names: non-empty string, max 100 characters. Spaces and special characters are allowed — format is up to the defining org. Duplicate names within the same team are rejected (case-sensitive). The same name may exist on different teams in the same org; in the flag matrix these collapse to a single column.
- Role names share a namespace with UOA system role names but do not conflict — custom `owner`/`admin` labels are valid (different namespaces).

What a role *permits* inside the consuming application is entirely that application's concern.

### Custom role CRUD endpoints

These require team `admin` or `owner` UOA role (or org `owner`).

```
GET    /org/:orgId/teams/:teamId/roles          — list custom role definitions
POST   /org/:orgId/teams/:teamId/roles          — create a role
PATCH  /org/:orgId/teams/:teamId/roles/:name    — rename a role (only `name` field; `default` is set separately)
DELETE /org/:orgId/teams/:teamId/roles/:name    — delete a role (blocked if it is the current default; caller must reassign first)
PUT    /org/:orgId/teams/:teamId/roles/:name/default  — mark this role as the default (unmarks the previous default)
```

`POST` body: `{ "name": "editor" }`. `PATCH` body: `{ "name": "new-editor" }`.

On rename: existing `TeamMember.customRole` records with the old name are updated atomically. The flag matrix column is renamed atomically. On delete: `TeamMember` records with this role get `customRole = null` (they become plain members with no custom role). The flag matrix column is removed.

---

## Token output

```json
{
  "sub": "user_123",
  "email": "alice@acme.com",
  "method": "microsoft",
  "orgs": [
    {
      "id": "org_abc",
      "slug": "acme",
      "uoaRole": "admin",
      "customRole": "editor",
      "teams": [
        {
          "id": "team_xyz",
          "name": "Backend",
          "uoaRole": "admin",
          "uoaRoleInherited": true,
          "customRole": "editor"
        }
      ]
    }
  ],
  "flags": {
    "dark_mode": true,
    "new_checkout": false
  }
}
```

Note: `flags` is present only when `feature_flags_enabled = true` on the App associated with the login. When absent, no `flags` key appears in the token. See `api-changes-rebac.md §5` for the canonical TypeScript interface. This document's token example is illustrative; `api-changes-rebac.md §5` is authoritative.

- `method` — the authentication method used: `"email"`, `"google"`, `"github"`, `"microsoft"`, `"apple"`. SCIM-provisioned users who have not completed an interactive login will not have a `method` value until first login — implementors should treat `method` as potentially absent for machine-provisioned accounts.
- `uoaRole` — `owner`, `admin`, or omitted if neither (plain member has no named UOA role)
- `uoaRoleInherited` — `true` if derived from org-level role rather than explicit team assignment; omitted if `false`
- `customRole` (org level) — a convenience field. Derived from the user's primary team `customRole`. Tiebreaker: (1) highest UOA system role on that team (`owner > admin`, users with no named role rank lowest), (2) if tied, earliest `TeamMember.createdAt`. There is no separately stored org-level custom role — this field is computed server-side at token issuance, not read from a separate org-scope data model. Omitted if no team has a `customRole` assigned for this user.
- `customRole` (team level) — the consuming app's single role label for this user on this specific team membership. Omitted if no custom role is assigned on that team.

**`org.customRole` when the user has multiple team memberships:** Always derived from the primary team's `customRole` using the standard multi-team tiebreaker. It is never independently set or stored at org scope. Custom roles are team-only constructs.

**`orgs` when user has zero org memberships:** When org features are enabled but the user belongs to no org, `orgs` is an empty array (`"orgs": []`), not absent. The field is always present when `org_features.enabled = true`.

**Token refresh behavior:** When a refresh token is used to issue a new access token, `orgs[]` claims are **re-resolved from the current database state** at that moment — they are not cached from the original login. Refresh tokens themselves carry no org data. **Flag values are NOT re-resolved on refresh** — they reflect the state at login time (see `feature-flags.md §Resolved decisions #3`). For real-time flag changes mid-session, the consuming app calls the `/apps/:appId/flags` query endpoint directly.

**`org.uoaRole` derivation for multi-team users:** The org-level `uoaRole` is the highest UOA system role the user holds across all teams in that org (accounting for inheritance). If a user is `owner` on one team and `admin` on another, their org-level `uoaRole` is `owner`. If the user has no `owner` or `admin` role on any team (and no org-level role assignment), `uoaRole` is omitted.

---

## UOA system role inheritance

Inheritance applies only to UOA system roles, not to custom roles.

1. Org `owner` → effective `owner` on every team in the org
2. Org `admin` → effective `admin` on every team in the org
3. A user with an explicitly higher team role than their org role keeps the higher team role
4. Inheritance is computed at request time — not stored as duplicate records

Custom roles do not inherit. If a consuming app wants custom role inheritance, it implements that in its own gating layer.

---

## Email domain auto-enrolment

Orgs can define rules so that any user who authenticates with a verified email from a given domain is automatically granted membership on first login.

Each rule specifies:
- Email domain (e.g. `acme.com`) — lowercase, no `@`, no protocol. Submitted values are lowercased automatically. IDN/Unicode domains must be submitted in Punycode (`xn--` form).
- Target team (optional) — `teamId` of the team to add the user to. If omitted (`null`), the user is added to the org's `isDefault: true` team.
- UOA role to grant — `admin` or `member` (plain member). `owner` can never be granted via auto-enrolment.
- Verification method required: `ANY`, `EMAIL`, `GOOGLE`, `GITHUB`, `MICROSOFT`, `APPLE`

**Multiple rules per domain:** The same email domain can appear in multiple rules for the same org, each targeting a different team. For example, `acme.com` can have one rule routing to the Engineering team and another routing to the Marketing team — all `acme.com` users will be added to both teams on first login. The unique constraint is `(orgId, emailDomain, teamId)`.

**Verification method matching per login type:**
- Email link login → matches rules with `ANY` or `EMAIL`
- Google OAuth login → matches rules with `ANY` or `GOOGLE`
- GitHub OAuth login → matches rules with `ANY` or `GITHUB`
- Microsoft Entra ID login → matches rules with `ANY` or `MICROSOFT`
- Apple Sign In → matches rules with `ANY` or `APPLE`

Auto-enrolment adds the user to the org and to the rule's target team (or the org's default team if no `teamId` is specified). Multiple matching rules for the same org are all applied — the user is added to each rule's target team. On auto-enrolment the user receives the **default custom role** of that team (the team's `isDefault: true` custom role, if role flag matrix is enabled). The rule does not need to specify a custom role explicitly.

**Multi-org conflict:** A user's email domain may match rules on multiple orgs within the same UOA instance (e.g. `ford.com` rules on both `ford-engineering` and `ford-marketing` orgs). This is intentional — the user is added to all matching orgs. There is no conflict; each org's rule is evaluated independently. If this is undesired, the org admin must not add overlapping domain rules.

**SCIM vs manual authority:** SCIM provisioning is authoritative for users managed by the IdP. Manual membership changes (via admin panel or API) are valid but will be overwritten on the next SCIM sync for SCIM-managed users. An org can opt out of SCIM for specific teams by not adding those teams to a group mapping.

---

## Who can manage custom role definitions

Only the **team admin** and the **org owner** can create, rename, delete, or change the default custom role for a team.

---

## Enterprise features (in scope from the start)

### Microsoft SSO (Azure AD / Entra ID)

Required for enterprise clients (e.g. automotive, manufacturing, finance) whose employees authenticate via corporate Microsoft accounts.

- Microsoft OAuth 2.0 / OIDC added as a supported social login provider alongside Google and GitHub
- Employees sign in with `user@ford.com` or `user@skoda-auto.cz` via their corporate Entra ID
- Verified Microsoft identity qualifies as `ANY` or `MICROSOFT` verification method for auto-enrolment rules
- Token includes `method: "microsoft"` alongside existing `"google"`, `"github"`, `"email"`

**Implementation notes:**

- **Multi-tenant app registration** — UOA registers a single Microsoft App in Azure Portal configured for multi-tenant (`signInAudience: AzureADMultipleOrgs`). This allows any Microsoft Entra ID tenant to authenticate without per-customer registration. Customers with single-tenant requirements can use the domain auto-enrolment `MICROSOFT` verification method to restrict sign-in to specific corporate domains.
- **Required scopes:** `openid email profile` (minimum). `offline_access` only if refresh token is needed from Microsoft side — not required since UOA issues its own refresh tokens.
- **Redirect URI:** same pattern as Google/GitHub OAuth callbacks, e.g. `https://auth.uoa.example.com/auth/social/microsoft/callback`
- **User field mapping (priority order):** `email` ← `upn` first, then `preferred_username`, then `email` claim. When `upn` and `email` differ, `upn` is stored as the canonical email. `name` ← `displayName`; no avatar from Microsoft OIDC by default.
- **Token validation:** use the OIDC common endpoint (`https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration`). The `tid` (tenant ID) claim is extracted and stored but not used for access control. All valid Entra ID tenants are accepted.
- **Conditional Access / MFA:** handled entirely by Microsoft's identity platform before the OAuth callback. UOA treats a successful Microsoft callback as a completed authentication, regardless of which MFA method the tenant required.
- **Env vars required:** `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (registered in Azure Portal)
- **Same-email merge:** if a user with the same verified email already exists (registered via email, Google, or GitHub), the Microsoft identity is linked to the existing account. A second identity link is added; no duplicate user is created. If the user already had Microsoft linked, the existing link is silently updated.
- **No matching domain rule:** if a user authenticates via Microsoft but their email domain does not match any `MICROSOFT` or `ANY` auto-enrolment rule in any org, authentication succeeds but the user has no org memberships. They can see the UOA account page but cannot access any org-protected resources. They must be added to an org manually or a matching domain rule must be configured.

### SCIM provisioning (Entra ID / Okta)

> **DEFERRED — not in initial build.** The schema models (`ScimToken`, `ScimGroupMapping`, `scimExternalId` on `User`) are present and will be created in the initial migration so no schema changes are needed when SCIM is implemented. The endpoints and all logic below are fully specified but not built yet.

Required for enterprise clients who manage thousands of users via a central identity provider and cannot manage membership manually.

SCIM (System for Cross-domain Identity Management) is the protocol identity providers like Microsoft Entra ID and Okta use to push user and group changes into external apps automatically. When an employee joins Ford, Entra ID provisions them into UOA. When they leave, it deprovisions them. Groups in Entra ID map to teams in UOA.

UOA must expose a SCIM 2.0 endpoint:

```
POST   /scim/v2/Users          — provision a new user
GET    /scim/v2/Users/:id      — read user
PATCH  /scim/v2/Users/:id      — update user attributes / active status
DELETE /scim/v2/Users/:id      — deprovision user (see deprovisioning behavior below)
GET    /scim/v2/Groups          — list groups/teams (paginated, offset-based)
GET    /scim/v2/Groups/:id      — read a single group/team with its members
POST   /scim/v2/Groups          — create team via IdP
PATCH  /scim/v2/Groups/:id      — add/remove members, rename team (RFC 7644 Operations[] format)
DELETE /scim/v2/Groups/:id      — delete team and sever ScimGroupMapping
POST   /scim/v2/Bulk            — not supported; returns HTTP 405
```

**SCIM bearer token:** An opaque UUID token issued per org via the admin panel. It has no expiry by default (long-lived). A single org may have multiple active tokens (for rolling rotation or multiple IdP integrations). Tokens are stored hashed; plain value shown only at creation. Revoked via admin panel (`DELETE /internal/admin/orgs/:orgId/scim-tokens/:tokenId`). Scoped to a single org — cannot be used across orgs.

**Group → team mapping:** SCIM Groups map to UOA teams. Mapping is stored explicitly: a `ScimGroupMapping` record links an IdP `externalGroupId` to a UOA `teamId`. Endpoints for managing mappings (system admin auth required): `GET/POST/DELETE /internal/admin/orgs/:orgId/scim/group-mappings` (see also `api-changes-rebac.md §6`). If a SCIM Group arrives with no mapping, UOA auto-creates a new team with the group `displayName` as the team name (if a team with that name already exists in the org, auto-creation is skipped and the SCIM operation continues without team assignment for that group), and creates a mapping automatically. When a SCIM group auto-creates a team, the first member added in the provisioning request receives `admin` UOA team role; all subsequent members receive `member`. Deleting a mapping does not delete the team — only severs the auto-sync link.

**User attribute mapping:**
- `userName` → UOA `email` (UPN format like `alice@ford.com`)
- `name.formatted` or `name.givenName + name.familyName` → UOA `name`
- `emails[0].value` is used as a fallback if `userName` is not an email
- If a user with the same email already exists in UOA, the SCIM-provisioned user is linked to the existing account (matched by email)
- `externalId` (IdP-provided) is stored on the UOA user record for stable re-linking on reprovision

**Email (userName) changes via PATCH:** `userName` maps to UOA email (the canonical user identifier). **Email changes via SCIM PATCH are rejected with HTTP 400** — email is immutable after account creation. If an IdP sends a new `userName` in a PATCH body, UOA returns `{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": 400, "detail": "userName is immutable" }`. The IdP should provision a new user with the new email and deprovision the old one separately.

**Custom role assignment:** The custom role assigned to SCIM-provisioned members defaults to the team's default custom role. If the IdP sends a role via SCIM enterprise extension (`urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:organization` or a custom schema attribute `uoa:customRole`), that role is validated against the team's defined custom roles and assigned if valid. If the role is unknown, provisioning proceeds with the default role (not rejected).

**Deprovisioning behavior (`DELETE /scim/v2/Users/:id`):**
- Default: **soft-deprovision** — user's `active` is set to `false`, all active sessions are invalidated, org/team memberships are retained but marked inactive. Per-user flag overrides are retained.
- `PATCH /scim/v2/Users/:id` with `{ active: false }` triggers the same soft-deprovision behavior (sessions invalidated, memberships marked inactive, overrides retained). `PATCH` with `{ active: true }` on a soft-deprovisioned user re-activates them and restores memberships (same as re-provisioning). Unknown SCIM schema attributes in a PATCH body are silently ignored.
- Hard-delete: only triggered by `DELETE` with `?hardDelete=true` query param (requires explicit IdP config). Removes org/team membership but retains per-user flag overrides by default (see `scim_override_retention` in `org_features`).
- Re-provisioning a soft-deprovisioned user (`POST /scim/v2/Users` with same email or `externalId`) re-activates the user and restores their memberships. Active sessions are not automatically re-issued — the user must re-authenticate. If the mapped team was deleted during the inactive period, the SCIM auto-create logic applies.

SCIM endpoints are authenticated with the per-org SCIM bearer token (see above). All SCIM endpoints are scoped to the org identified by the token.

**SCIM error responses:** Use the standard SCIM error schema (`urn:ietf:params:scim:api:messages:2.0:Error`), `Content-Type: application/scim+json`. HTTP status codes: 400 (malformed request), 401 (missing/invalid token), 404 (resource not found), 409 (duplicate user). Response body: `{ "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "status": 404, "detail": "Resource not found" }`. (Per RFC 7643 §8.7.1, `status` is an integer, not a string.) Per UOA policy, detail messages are generic and non-enumerable.

**`externalId` storage:** The IdP's `externalId` is stored as `scimExternalId: String?` on the UOA `User` model. It is used for re-provisioning matching. It is mutable on PATCH. It does not need to be a specific format — stored as received.

**SCIM `POST /scim/v2/Users` response (HTTP 201):**
```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
  "id": "<uoa-user-id>",
  "externalId": "<idp-external-id>",
  "userName": "alice@ford.com",
  "name": { "formatted": "Alice Smith" },
  "active": true,
  "meta": {
    "resourceType": "User",
    "created": "2026-04-07T10:00:00Z",
    "lastModified": "2026-04-07T10:00:00Z",
    "location": "/scim/v2/Users/<uoa-user-id>"
  }
}
```

**SCIM `POST /scim/v2/Groups` response (HTTP 201):**
```json
{
  "schemas": ["urn:ietf:params:scim:schemas:core:2.0:Group"],
  "id": "<uoa-team-id>",
  "externalId": "<idp-external-id>",
  "displayName": "Engineering",
  "members": [],
  "meta": {
    "resourceType": "Group",
    "created": "2026-04-07T10:00:00Z",
    "lastModified": "2026-04-07T10:00:00Z",
    "location": "/scim/v2/Groups/<uoa-team-id>"
  }
}
```

**SCIM authentication:** `Authorization: Bearer <token>` header (RFC 7523 standard). Missing or invalid token returns HTTP 401 with SCIM error schema. Token scope is validated against the org identified in the token hash lookup — requests targeting a different org's resources return HTTP 403.

**SCIM `GET /scim/v2/Users` pagination:** Uses SCIM standard `startIndex` (1-based, default 1) and `count` (page size, default 100, max 200) params. Supports `filter=userName eq "alice@acme.com"` and `filter=externalId eq "<idp-id>"` per RFC 7644 §3.4.2.2. Response includes `totalResults`, `startIndex`, `itemsPerPage`, and a `Resources` array of User objects.

**SCIM `GET /scim/v2/Groups/:id` response:** Returns a SCIM Group object including `id`, `displayName`, `externalId` (IdP group ID), and a `members[]` array of `{ "value": "<scimUserId>", "display": "<userName>" }` objects for current team members.

**SCIM `PATCH /scim/v2/Groups/:id` format:** Uses RFC 7644 §3.5.2 `Operations[]` array format. Three supported operations:
- Add member: `{ "op": "Add", "path": "members", "value": [{"value": "<userId>"}] }`
- Remove member: `{ "op": "Remove", "path": "members[value eq \"<userId>\"]" }`
- Rename team: `{ "op": "Replace", "path": "displayName", "value": "New Team Name" }`
Multiple operations may appear in a single PATCH body. Operations are applied atomically. Team rename via SCIM is authoritative — if a UOA admin renamed the team, the next SCIM PATCH with a `displayName` replace will overwrite it.

**SCIM `GET /scim/v2/Groups` pagination:** Uses SCIM standard `startIndex` (1-based, default 1) and `count` (page size, default 100, max 200) params. Supports `filter=displayName eq "Engineering"` per RFC 7644 §3.4.2.2. Response includes `totalResults`, `startIndex`, `itemsPerPage`.

**SCIM `DELETE /scim/v2/Groups/:id` behavior:** Deletes the UOA team associated with the SCIM group. The `ScimGroupMapping` record is removed. All team members remain as org members but lose their team membership. Per-user flag overrides are retained. The team itself is deleted. HTTP 204 on success. HTTP 404 if the group ID does not match any active mapping. This is a destructive operation — the team cannot be recovered. If the consuming IdP sends DELETE on a group in error, the team must be manually recreated and the mapping re-established.

**Override retention on soft-deprovision:** Per-user flag overrides are **always retained** on soft-deprovision (`PATCH { active: false }` or `DELETE` without `?hardDelete=true`), regardless of the `scim_override_retention` org config. The `scim_override_retention` config only controls what happens on hard-delete (`DELETE?hardDelete=true`).

**SCIM bearer token management endpoints** (system admin auth required):
```
GET    /internal/admin/orgs/:orgId/scim-tokens          — list all tokens (id, label, createdAt, lastUsedAt; plain token never returned after creation)
POST   /internal/admin/orgs/:orgId/scim-tokens          — create token (returns plain token in response once only)
DELETE /internal/admin/orgs/:orgId/scim-tokens/:tokenId — revoke a token
```

`POST` response includes the plain token in a `token` field (shown once, never retrievable again). All other endpoints return the hashed/masked token only.

---

## Role model decision — three options, analysis

This is an open architectural decision. Three viable approaches exist for how a user's custom roles are modelled per team.

### Option A — Multiple roles per user

A user can hold several custom roles simultaneously on the same team: `["editor", "billing"]`.

**Pros**
- Naturally models reality — a person can be an editor *and* handle billing without needing a combined role
- No role explosion — define N atomic roles, combine freely
- Changing one dimension of access doesn't affect others
- Consuming app checks `roles.includes('billing')` per capability

**Cons**
- Token grows as role combinations increase
- Access logic spreads across the consuming app's codebase — no single place to answer "what kind of user is this?"
- Harder to explain to end users and admins ("you have: editor, billing, content-reviewer")
- Role combinations can produce unintended interactions if not carefully designed on the consuming app's side

---

### Option B — More granular single roles, server-side gating

Define enough roles that every combination of access needs gets its own named role: `editor`, `billing-editor`, `read-only-viewer`, `senior-editor`, etc. One role per user per team. The consuming app gates features by checking the role name.

**Pros**
- Simplest mental model — one role, one identity, one place to check
- Easy to display: "you are a Billing Editor"
- Auditable — role assignments are explicit
- Common pattern, well understood

**Cons**
- Role explosion as the product grows — every new capability combination requires a new role
- Adding capabilities requires new role definitions and code changes on the consuming app side
- Admins must understand a large, growing list of roles
- Combining two users' access (one person covering two jobs) means creating a combined role

---

### Option C — Feature flags per role (UOA as a feature flag store)

Each custom role has a set of boolean flags attached: `{ canPublish: true, canEditBilling: false }`. UOA stores flag definitions per org/team and returns them in the token alongside the role. The consuming app checks flags rather than role names.

**Pros**
- Consuming app never needs to know role names — just checks `flags.canPublish`
- Adding new capabilities doesn't require new roles or code deploys on the consuming app side
- Org admins can adjust flags without touching app code
- Reduces coupling between UOA's role labels and the consuming app's feature names

**Cons**
- UOA becomes opinionated about the consuming app's internal features — leaks application concerns into the auth layer
- Flag definitions must be created, maintained, and versioned in UOA — additional operational surface
- Consuming apps may not trust externally defined flags for security-critical decisions (the flag is just data; the check still happens in their code)
- Flags and role permissions are distinct concepts being merged, which can become confusing as both evolve
- Significantly more complex admin UI and data model in UOA

---

### Decision

**Option C is the chosen model, implemented as an optional service.**

The role flag matrix is managed in UOA. When enabled, UOA owns role definitions and the flag → role mapping. When disabled, `roleLabel` is an opaque string on the membership record and the consuming app's config JWT defines its meaning.

A user holds **one role per team**. Per-user flag overrides handle exceptions without needing combined roles.

The default role is marked with a tick. Auto-enrolled users receive it automatically.

See `Docs/Requirements/feature-flags.md` for the full specification.
